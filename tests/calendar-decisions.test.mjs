import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEP_DECISION_DAYS, MAX_DECISIONS, restoreCalendarDecisions, validDecisionsValue, eventTaskSpan, isSingleEvent, eventTaskId, decisionFor, dayFreeMinutes, effectiveBusyEvents, convertedEventIds, eventTaskDraft, isHiddenEvent, isRecurringEvent, linkedEventTasks,
  needsTaskQuestion, occurrenceDecisionKey, pruneDecisions, readDecisions, reprioritizeSuggestion, seriesDecisionKey, withDecision,
} from "../lib/calendar-decisions.ts";
import { mergeEntity } from "../lib/field-merge.ts";

const NOW = Date.parse("2026-10-23T08:00:00Z");
const event = (patch = {}) => ({
  id: "e1", sourceId: "src", uid: "u1", occurrenceKey: "u1:2026-10-23T09:00:00.000Z", title: "Secret title",
  start: "2026-10-23T09:00:00.000Z", end: "2026-10-23T10:30:00.000Z", allDay: false, status: "confirmed", busy: true, ...patch,
});
const task = (id, properties = {}, patch = {}) => ({ id, type: "task", title: id, status: "open", workspaceId: "w", properties, createdAt: 1, updatedAt: 1, ...patch });

test("decision keys are opaque and carry no title", () => {
  assert.equal(occurrenceDecisionKey(event()), "occ:src:u1:2026-10-23T09:00:00.000Z");
  assert.equal(seriesDecisionKey(event()), "series:src:u1");
  assert.equal(seriesDecisionKey(event({ uid: "" })), "");
  assert.ok(!occurrenceDecisionKey(event()).includes("Secret"));
});

test("a decision for the occurrence or for the series applies; hidden is read from either", () => {
  assert.deepEqual(decisionFor({ [occurrenceDecisionKey(event())]: "notTask" }, event()), { decision: "notTask", key: "occ:src:u1:2026-10-23T09:00:00.000Z" });
  assert.equal(isHiddenEvent({ "series:src:u1": "hidden" }, event({ occurrenceKey: "u1:2026-10-30T09:00:00.000Z" })), true);
  assert.equal(isHiddenEvent({ "series:src:other": "hidden" }, event()), false);
  assert.equal(isRecurringEvent(event(), [event(), event({ id: "e2" })]), true);
  assert.equal(isRecurringEvent(event(), [event(), event({ id: "e2", uid: "u2" })]), false);
});

test("readDecisions ignores malformed values", () => {
  const stored = { "occ:a:b": "hidden", "series:a:b": "notTask", "occ:x": "other", junk: "hidden" };
  assert.deepEqual(readDecisions({ properties: { calendarDecisions: stored } }), { "occ:a:b": "hidden", "series:a:b": "notTask" });
  assert.deepEqual(readDecisions({ properties: { calendarDecisions: [] } }), {});
  assert.deepEqual(readDecisions(undefined), {});
});

test("old occurrence decisions are pruned, series decisions are kept", () => {
  const old = new Date(NOW - (KEEP_DECISION_DAYS + 1) * 86_400_000).toISOString();
  const recent = new Date(NOW - 5 * 86_400_000).toISOString();
  const decisions = { [`occ:s:u:${old}`]: "hidden", [`occ:s:u:${recent}`]: "hidden", "series:s:u": "hidden", "occ:s:no-date": "notTask" };
  assert.deepEqual(Object.keys(pruneDecisions(decisions, NOW)).sort(), [`occ:s:u:${recent}`, "occ:s:no-date", "series:s:u"].sort());
});

test("the map is capped, dropping occurrences before series and the oldest first", () => {
  const future = "2027-01-01T09:00:00.000Z";
  let decisions = { "series:s:keep": "hidden" };
  for (let index = 0; index < MAX_DECISIONS + 20; index += 1) decisions = withDecision(decisions, `occ:s:u${index}:${future}`, "hidden", NOW);
  const keys = Object.keys(decisions);
  assert.equal(keys.length, MAX_DECISIONS);
  assert.ok(keys.includes("series:s:keep"));
  assert.ok(!keys.includes(`occ:s:u0:${future}`));
  assert.ok(keys.includes(`occ:s:u${MAX_DECISIONS + 19}:${future}`));
});

test("withDecision sets, clears and does not change its input", () => {
  const input = { "occ:s:a": "hidden" };
  const set = withDecision(input, "series:s:u", "notTask", NOW);
  assert.deepEqual(input, { "occ:s:a": "hidden" });
  assert.equal(set["series:s:u"], "notTask");
  assert.ok(!("series:s:u" in withDecision(set, "series:s:u", null, NOW)));
  assert.equal(withDecision(input, "", "hidden", NOW), input);
});

test("an event needs the question only while undecided, upcoming, timed and without a task", () => {
  const linked = new Map();
  const ask = (e, decisions = {}, map = linked, now = NOW) => needsTaskQuestion(e, { decisions, linked: map, now });
  assert.equal(ask(event()), true);
  assert.equal(ask(event({ allDay: true })), false);
  assert.equal(ask(event({ status: "cancelled" })), false);
  assert.equal(ask(event(), {}, linked, Date.parse("2026-10-23T11:00:00Z")), false, "already ended");
  assert.equal(ask(event(), {}, linked, Date.parse("2026-10-23T09:30:00Z")), true, "running now");
  assert.equal(ask(event(), { [occurrenceDecisionKey(event())]: "notTask" }), false);
  assert.equal(ask(event(), { "series:src:u1": "hidden" }), false);
  assert.equal(ask(event(), {}, new Map([["e1", task("t")]])), false);
});

test("linkedEventTasks maps events to tasks of the workspace and prefers an open one", () => {
  const map = linkedEventTasks([
    task("done", { calendarEventId: "e1" }, { status: "completed" }), task("open", { calendarEventId: "e1" }),
    task("other", { calendarEventId: "e2" }, { workspaceId: "x" }), task("plain"),
  ], "w", [event(), event({ id: "e2", uid: "u2" })]);
  assert.deepEqual([...map.keys()], ["e1"]);
  assert.equal(map.get("e1").id, "open");
});

test("the task draft takes the title, local date, rounded length and a link back", () => {
  const draft = eventTaskDraft(event({ start: "2026-10-23T22:30:00.000Z", end: "2026-10-23T23:20:20.000Z", occurrenceKey: "u1:k" }), "Europe/Prague");
  assert.equal(draft.title, "Secret title");
  assert.equal(draft.when, "2026-10-24", "22:30Z is already the next day in Prague");
  assert.deepEqual(draft.properties, { calendarEventId: "e1", calendarSourceId: "src", calendarEventKey: "u1:k", calendarEventUid: "u1", estimatedMinutes: 50 });
  assert.equal(eventTaskDraft(event({ recurring: false }), "UTC").properties.calendarEventSingle, true);
  assert.equal(eventTaskDraft(event({ recurring: true }), "UTC").properties.calendarEventSingle, undefined);
  assert.equal(eventTaskDraft(event(), "UTC").properties.calendarEventSingle, undefined, "unknown is not single");
  assert.equal(eventTaskDraft(event(), "America/New_York").when, "2026-10-23");
});

test("the estimate is clamped between 5 and 480 minutes and omitted for all-day events", () => {
  assert.equal(eventTaskDraft(event({ end: "2026-10-23T09:01:00.000Z" }), "UTC").properties.estimatedMinutes, 5);
  assert.equal(eventTaskDraft(event({ end: "2026-10-24T09:00:00.000Z" }), "UTC").properties.estimatedMinutes, 480);
  const allDay = eventTaskDraft(event({ allDay: true, start: "2026-10-24T00:00:00.000Z", end: "2026-10-25T00:00:00.000Z" }), "Pacific/Auckland");
  assert.equal(allDay.when, "2026-10-24");
  assert.ok(!("estimatedMinutes" in allDay.properties));
  assert.equal(eventTaskDraft(event({ start: "nope" }), "UTC"), null);
});

test("free minutes are the workday minus busy events, hidden or converted ones included", () => {
  const events = [
    { start: "2026-10-23T07:00:00Z", end: "2026-10-23T08:00:00Z", busy: true },
    { start: "2026-10-23T07:30:00Z", end: "2026-10-23T09:00:00Z", busy: true },
    { start: "2026-10-23T12:00:00Z", end: "2026-10-23T13:00:00Z", busy: false },
  ];
  // Prague is UTC+2: 09:00-17:00 local, busy 09:00-11:00 local.
  assert.equal(dayFreeMinutes(events, "2026-10-23", "Europe/Prague", "09:00", "17:00"), 6 * 60);
  assert.equal(dayFreeMinutes([], "2026-10-23", "Europe/Prague", "17:00", "09:00"), null);
});

test("when the day is full, the least important movable task is proposed for the next day", () => {
  const day = "2026-10-26";
  const tasks = [
    task("high", { when: day, priority: "high", estimatedMinutes: 120 }),
    task("medium", { when: day, priority: "medium", estimatedMinutes: 60 }),
    task("low-short", { when: day, priority: "low", estimatedMinutes: 30 }),
    task("low-long", { when: day, priority: "low", estimatedMinutes: 90 }),
    task("deadline", { when: day, priority: "none", deadline: day, estimatedMinutes: 30 }),
    task("fromEvent", { when: day, calendarEventId: "e1", estimatedMinutes: 60 }),
    task("elsewhere", { when: "2026-10-27", priority: "none", estimatedMinutes: 600 }),
  ];
  const result = reprioritizeSuggestion({ tasks, workspaceId: "w", day, today: "2026-10-23", freeMinutes: 200 });
  assert.equal(result.task.id, "low-long");
  assert.equal(result.target, "2026-10-27");
  assert.equal(result.plannedMinutes, 120 + 60 + 30 + 90 + 30 + 60, "the task made from an event counts, its event is not busy");
  assert.equal(reprioritizeSuggestion({ tasks, workspaceId: "w", day, today: "2026-10-23", freeMinutes: 400 }), null, "the day fits");
  assert.equal(reprioritizeSuggestion({ tasks, workspaceId: "w", day, today: "2026-10-23", freeMinutes: null }), null, "no capacity data");
  assert.equal(reprioritizeSuggestion({ tasks, workspaceId: "other", day, today: "2026-10-23", freeMinutes: 10 }), null);
});

test("tasks without known estimates do not make a day full, and nothing movable gives no suggestion", () => {
  const day = "2026-10-26";
  assert.equal(reprioritizeSuggestion({ tasks: [task("a", { when: day }), task("b", { when: day })], workspaceId: "w", day, today: "2026-10-23", freeMinutes: 0 }), null);
  const onlyHigh = [task("a", { when: day, priority: "high", estimatedMinutes: 300 })];
  assert.equal(reprioritizeSuggestion({ tasks: onlyHigh, workspaceId: "w", day, today: "2026-10-23", freeMinutes: 60 }), null);
});

test("today's own list counts the Today flag; another day counts only its planned date", () => {
  const today = "2026-10-23";
  const flagged = [task("a", { today: true, priority: "low", estimatedMinutes: 120 })];
  assert.equal(reprioritizeSuggestion({ tasks: flagged, workspaceId: "w", day: today, today, freeMinutes: 60 })?.task.id, "a");
  assert.equal(reprioritizeSuggestion({ tasks: flagged, workspaceId: "w", day: "2026-10-26", today, freeMinutes: 60 }), null);
});

test("calendar decisions merge key by key across devices", () => {
  const workspace = (properties, updatedAt) => ({ id: "workspace:w", type: "workspace", title: "W", status: "active", workspaceId: "w", properties: { kind: "shared", role: "owner", members: [], ...properties }, createdAt: 1, updatedAt });
  const base = workspace({ calendarDecisions: { "occ:s:a": "hidden" } }, 1);
  const local = workspace({ calendarDecisions: { "occ:s:a": "hidden", "occ:s:b": "notTask" } }, 5);
  const server = workspace({ calendarDecisions: { "occ:s:c": "hidden" } }, 4);
  const merged = mergeEntity(base, local, server, 10);
  assert.deepEqual(merged.properties.calendarDecisions, { "occ:s:b": "notTask", "occ:s:c": "hidden" });
  assert.ok(!merged.properties.syncConflicts);
});

test("effective busy events: hidden and converted events do not occupy time, 'not a task' and plain events do", () => {
  const events = [
    event({ id: "plain" }),
    event({ id: "hiddenOcc", occurrenceKey: "u2:k" , uid: "u2" }),
    event({ id: "series1", uid: "ser", occurrenceKey: "ser:a" }),
    event({ id: "series2", uid: "ser", occurrenceKey: "ser:b" }),
    event({ id: "notTask", uid: "nt", occurrenceKey: "nt:a" }),
    event({ id: "converted", uid: "cv", occurrenceKey: "cv:a" }),
    event({ id: "free", uid: "fr", occurrenceKey: "fr:a", busy: false }),
  ];
  const decisions = { "occ:src:u2:k": "hidden", "series:src:ser": "hidden", "occ:src:nt:a": "notTask" };
  const tasks = [task("t", { calendarEventId: "converted" }), task("other", {}), { ...task("note", { calendarEventId: "plain" }), type: "note" }];
  assert.deepEqual(effectiveBusyEvents(events, decisions, tasks).map((e) => e.id), ["plain", "notTask"]);
  assert.deepEqual(effectiveBusyEvents(events, {}, []).map((e) => e.id).sort(), ["converted", "hiddenOcc", "notTask", "plain", "series1", "series2"].sort());
  assert.deepEqual([...convertedEventIds(tasks, events)], ["converted"]);
  // A completed task still stands in for its event.
  assert.equal(effectiveBusyEvents([event({ id: "x" })], {}, [task("d", { calendarEventId: "x" }, { status: "completed" })]).length, 0);
});

test("free minutes grow when hidden or converted events stop being busy", () => {
  const timed = [event({ id: "a", start: "2026-10-23T07:00:00Z", end: "2026-10-23T09:00:00Z" })];
  const full = dayFreeMinutes(effectiveBusyEvents(timed, {}, []), "2026-10-23", "Europe/Prague", "09:00", "17:00");
  const hidden = dayFreeMinutes(effectiveBusyEvents(timed, { [occurrenceDecisionKey(timed[0])]: "hidden" }, []), "2026-10-23", "Europe/Prague", "09:00", "17:00");
  assert.equal(full, 6 * 60);
  assert.equal(hidden, 8 * 60);
});

test("a single event moved in the source calendar keeps its task; a recurring occurrence does not borrow another's", () => {
  const moved = event({ id: "new-id", uid: "one", occurrenceKey: "one:2026-10-24T10:00:00.000Z", recurring: false });
  const single = task("t1", { calendarEventId: "old-id", calendarSourceId: "src", calendarEventUid: "one", calendarEventSingle: true });
  assert.deepEqual([...convertedEventIds([single], [moved])], ["new-id"]);
  // Legacy task without the uid: read from the occurrence key.
  const legacy = task("t2", { calendarEventId: "old-id", calendarSourceId: "src", calendarEventKey: "one:2026-10-23T10:00:00.000Z", calendarEventSingle: true });
  assert.deepEqual([...convertedEventIds([legacy], [moved])], ["new-id"]);
  // A task made from one occurrence of a series never covers another occurrence.
  const fromSeries = task("t3", { calendarEventId: "mon", calendarSourceId: "src", calendarEventUid: "ser" });
  assert.deepEqual([...convertedEventIds([fromSeries], [event({ id: "tue", uid: "ser", occurrenceKey: "ser:2026-10-27T09:00:00.000Z" })])], []);
  // Two cached events with the uid: only the id matches.
  const twin = [event({ id: "a", uid: "one", recurring: false }), event({ id: "b", uid: "one", recurring: false })];
  assert.deepEqual([...convertedEventIds([single], twin)], []);
});

test("an all-day event's task gets its date whatever the server's zone was", () => {
  // VALUE=DATE 2026-10-23 parsed east of UTC (Prague) and west of UTC (New York).
  assert.equal(eventTaskDraft(event({ allDay: true, start: "2026-10-22T22:00:00.000Z", end: "2026-10-23T22:00:00.000Z" }), "UTC").when, "2026-10-23");
  assert.equal(eventTaskDraft(event({ allDay: true, start: "2026-10-23T04:00:00.000Z", end: "2026-10-24T04:00:00.000Z" }), "UTC").when, "2026-10-23");
});

test("a long uid becomes a short stable digest in decision keys, keeping the start for pruning", () => {
  const uid = "x".repeat(2000);
  const key = occurrenceDecisionKey(event({ uid, occurrenceKey: `${uid}:2026-10-23T09:00:00.000Z` }));
  assert.ok(key.length < 60, key);
  assert.ok(key.endsWith(":2026-10-23T09:00:00.000Z"));
  assert.equal(key, occurrenceDecisionKey(event({ uid, occurrenceKey: `${uid}:2026-10-23T09:00:00.000Z` })));
  assert.notEqual(seriesDecisionKey(event({ uid })), seriesDecisionKey(event({ uid: `${uid}y` })));
});

test("stored decisions are validated for sync", () => {
  assert.equal(validDecisionsValue(undefined), true);
  assert.equal(validDecisionsValue({ "occ:s:a": "hidden", "series:s:b": "notTask" }), true);
  for (const bad of [null, [], "x", { "occ:s:a": 1 }, { "other:a": "hidden" }, { ["occ:" + "x".repeat(700)]: "hidden" },
    Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`occ:s:${index}`, "hidden"]))]) {
    assert.equal(validDecisionsValue(bad), false, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("Undo puts back only the decisions it changed and keeps the rest of the record", () => {
  const current = { properties: { kind: "personal", calendarDecisions: { "occ:s:mine": "hidden", "occ:s:other-device": "hidden" }, manualOrders: { a: 1 } } };
  const properties = restoreCalendarDecisions(current, { "occ:s:mine": null }, Date.parse("2026-10-23T00:00:00Z"));
  assert.deepEqual(properties.calendarDecisions, { "occ:s:other-device": "hidden" });
  assert.deepEqual(properties.manualOrders, { a: 1 });
  assert.equal("calendarDecisions" in restoreCalendarDecisions({ properties: { calendarDecisions: { "occ:s:mine": "hidden" } } }, { "occ:s:mine": null }, 0), false);
});

test("a yearly or monthly series with one repeat in the cached window is still a series", () => {
  // The cache holds -14/+90 days: a yearly meeting has exactly one occurrence there.
  const yearly = event({ id: "y2026", uid: "yearly", occurrenceKey: "yearly:2026-11-02T09:00:00.000Z", recurring: true });
  assert.equal(isRecurringEvent(yearly, [yearly]), true, "the menu offers this one / the whole series");
  assert.equal(isSingleEvent(yearly), false);
  // A task made from this year's meeting never stands in for next year's.
  const draft = eventTaskDraft(yearly, "UTC");
  assert.equal(draft.properties.calendarEventSingle, undefined);
  const made = task("t", draft.properties);
  const nextYear = event({ id: "y2027", uid: "yearly", occurrenceKey: "yearly:2027-11-02T09:00:00.000Z", recurring: true });
  assert.deepEqual([...convertedEventIds([made], [nextYear])], []);
  assert.deepEqual(effectiveBusyEvents([nextYear], {}, [made]).map((e) => e.id), ["y2027"]);
  // Even a task marked single is not matched by uid to an event the calendar says repeats.
  const marked = task("m", { calendarEventId: "y2026", calendarSourceId: "src", calendarEventUid: "yearly", calendarEventSingle: true });
  assert.deepEqual([...convertedEventIds([marked], [nextYear])], []);
  // Cached before the flag existed (unknown): neither single nor matched by uid.
  const unknown = event({ id: "u", uid: "yearly" });
  assert.equal(isSingleEvent(unknown), false);
  assert.deepEqual([...convertedEventIds([marked], [unknown])], []);
});

test("the task made from an event has the same id on every device", () => {
  const repeat = event({ recurring: true });
  assert.equal(eventTaskId(repeat, "w"), eventTaskId({ ...repeat }, "w"));
  assert.notEqual(eventTaskId(repeat, "w"), eventTaskId(event({ recurring: true, occurrenceKey: "u1:2026-10-30T09:00:00.000Z" }), "w"), "each repeat its own task");
  assert.notEqual(eventTaskId(repeat, "w"), eventTaskId(repeat, "other"));
  // A one-off event keeps its task id when moved (its occurrence key changes, its uid does not).
  const one = event({ recurring: false });
  assert.equal(eventTaskId(one, "w"), eventTaskId(event({ recurring: false, id: "moved", occurrenceKey: "u1:2026-10-24T09:00:00.000Z" }), "w"));
  assert.match(eventTaskId(one, "w"), /^calendar-task:[0-9a-f]{16}$/);
});

test("two devices answering Yes for the same event end up with one task after sync", async () => {
  const { mergeSnapshots } = await import("../lib/server-sync.ts");
  const meeting = event({ recurring: true, title: "Porada" });
  const make = (updatedAt) => {
    const draft = eventTaskDraft(meeting, "Europe/Prague");
    return { id: eventTaskId(meeting, "w"), type: "task", title: draft.title, status: "open", workspaceId: "w",
      properties: { ...draft.properties, when: draft.when }, createdAt: updatedAt, updatedAt };
  };
  const fromA = make(1000), fromB = make(1005);
  // Device A synced first; device B, which had not seen it, merges its own copy onto the server's.
  const server = { revision: 2, entities: [fromA], relations: [], tombstones: [] };
  const merged = mergeSnapshots(server, [fromB], [], { entities: [], relations: [] });
  const tasks = merged.entities.filter((entity) => entity.type === "task");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, fromA.id);
  assert.equal(linkedEventTasks(merged.entities, "w", [meeting]).get(meeting.id).id, fromA.id);
});

test("an event task's span runs from the event's start for its estimate (else the event's length)", () => {
  // A 24 h event yesterday 08:00 -> today 08:00 with the estimate capped at 480 min ends yesterday 16:00.
  const overnight = event({ start: "2026-10-22T06:00:00.000Z", end: "2026-10-23T06:00:00.000Z" });
  const span = eventTaskSpan(overnight, { properties: { estimatedMinutes: 480 } });
  assert.equal(new Date(span.end).toISOString(), "2026-10-22T14:00:00.000Z");
  const todayStart = Date.parse("2026-10-22T22:00:00.000Z");
  assert.ok(span.end <= todayStart, "so it does not reach into today and stays in the Today list");
  assert.equal(eventTaskSpan(overnight, { properties: {} }).end, Date.parse(overnight.end));
});
