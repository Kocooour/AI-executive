import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEP_DECISION_DAYS, MAX_DECISIONS, decisionFor, dayFreeMinutes, effectiveBusyEvents, convertedEventIds, eventTaskDraft, isHiddenEvent, isRecurringEvent, linkedEventTasks,
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
  ], "w");
  assert.deepEqual([...map.keys()], ["e1"]);
  assert.equal(map.get("e1").id, "open");
});

test("the task draft takes the title, local date, rounded length and a link back", () => {
  const draft = eventTaskDraft(event({ start: "2026-10-23T22:30:00.000Z", end: "2026-10-23T23:20:20.000Z", occurrenceKey: "u1:k" }), "Europe/Prague");
  assert.equal(draft.title, "Secret title");
  assert.equal(draft.when, "2026-10-24", "22:30Z is already the next day in Prague");
  assert.deepEqual(draft.properties, { calendarEventId: "e1", calendarSourceId: "src", calendarEventKey: "u1:k", estimatedMinutes: 50 });
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
  assert.deepEqual([...convertedEventIds(tasks)], ["converted"]);
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
