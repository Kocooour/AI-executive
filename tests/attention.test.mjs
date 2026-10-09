import assert from "node:assert/strict";
import test from "node:test";

const { evaluateAttention } = await import("../lib/attention.ts");
const NOW = Date.parse("2026-10-04T12:00:00Z");
const DAY = 86_400_000;
const entity = (id, type, overrides = {}) => ({
  id, type, title: id, status: type === "task" ? "open" : "active", workspaceId: "personal",
  properties: {}, createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY, ...overrides,
});
const evaluate = (entities, relations = [], overrides = {}) => evaluateAttention({
  entities, relations, workspaceId: "personal", timezone: "Europe/Prague", evaluatedAt: NOW,
  dataRevision: 7, ...overrides,
});

test("all-day deadline ends at local midnight, including DST shift", () => {
  const task = entity("deadline", "task", { properties: { deadline: "2026-10-25" } });
  const before = evaluate([task], [], { evaluatedAt: Date.parse("2026-10-25T22:59:59.999Z") });
  assert.equal(before[0].ruleId, "deadline_soon");
  assert.equal(before[0].relevantAt, Date.parse("2026-10-25T23:00:00Z"));
  const after = evaluate([task], [], { evaluatedAt: Date.parse("2026-10-25T23:00:00Z") });
  assert.equal(after[0].ruleId, "deadline_overdue");
});

test("timed deadline is soon at 48 hours and overdue strictly after the instant", () => {
  const task = entity("timed", "task", { properties: { deadline: "2026-10-06T12:00:00Z" } });
  assert.equal(evaluate([task])[0].ruleId, "deadline_soon");
  assert.equal(evaluate([task], [], { evaluatedAt: Date.parse("2026-10-06T12:00:00Z") })[0].ruleId, "deadline_soon");
  assert.equal(evaluate([task], [], { evaluatedAt: Date.parse("2026-10-06T12:00:00.001Z") })[0].ruleId, "deadline_overdue");
  assert.equal(evaluate([task], [], { evaluatedAt: NOW - 1 })[0]?.ruleId, undefined);
});

test("invalid dates and completed tasks produce no deadline candidate", () => {
  assert.deepEqual(evaluate([
    entity("bad", "task", { properties: { deadline: "2026-02-30" } }),
    entity("bad-timed-day", "task", { properties: { deadline: "2026-02-30T12:00:00Z" } }),
    entity("bad-timed-hour", "task", { properties: { deadline: "2026-10-04T24:00:00Z" } }),
    entity("bad-timed-offset", "task", { properties: { deadline: "2026-10-04T12:00:00+25:00" } }),
    entity("unsupported", "task", { properties: { deadline: "next week" } }),
    entity("done", "task", { status: "completed", properties: { deadline: "2026-10-01" } }),
  ]), []);
});

test("project signals use recorded activity and suppress missing action for waiting or actionable tasks", () => {
  const project = entity("project", "project", { updatedAt: NOW - 15 * DAY, properties: { deadline: "2026-10-01" } });
  const result = evaluate([project]);
  assert.deepEqual(result.map((item) => item.ruleId), ["project_no_next_action", "project_idle"]);
  assert.match(result[0].reason, /24 hours/);
  assert.match(result[1].reason, /14 days/);
  const task = entity("action", "task", { updatedAt: NOW - 15 * DAY });
  const relation = { id: "rel", workspaceId: "personal", sourceEntityId: task.id, targetEntityId: project.id,
    relationType: "belongs_to_project", createdAt: NOW - 15 * DAY };
  assert.equal(evaluate([project, task], [relation]).some((item) => item.ruleId === "project_no_next_action"), false);
  assert.equal(evaluate([entity("waiting", "project", { properties: { waiting: true } })]).some((item) => item.ruleId === "project_no_next_action"), false);
  assert.equal(evaluate([project], [], { claims: [{ id: "claim", workspaceId: "personal", projectId: project.id, predicate: "waiting_for", revision: 1,
    updatedAt: NOW - 15 * DAY, confirmed: true, current: true }] }).some((item) => item.ruleId === "project_no_next_action"), false);
  assert.equal(evaluate([project], [], { claims: [{ id: "recent", workspaceId: "personal", projectId: project.id, predicate: "importance", revision: 2,
    updatedAt: NOW - DAY, confirmed: true, current: true }] }).some((item) => item.ruleId === "project_idle"), false);
});

test("project thresholds are inclusive and do not trigger early", () => {
  const withDeadline = { deadline: "2026-10-01" };
  const at24 = entity("at24", "project", { createdAt: NOW - DAY, updatedAt: NOW - DAY, properties: withDeadline });
  const before24 = entity("before24", "project", { createdAt: NOW - DAY + 1, updatedAt: NOW - DAY + 1, properties: withDeadline });
  const at14 = entity("at14", "project", { createdAt: NOW - 14 * DAY, updatedAt: NOW - 14 * DAY, properties: withDeadline });
  const before14 = entity("before14", "project", { createdAt: NOW - 14 * DAY + 1, updatedAt: NOW - 14 * DAY + 1, properties: withDeadline });
  const result = evaluate([at24, before24, at14, before14]);
  assert.equal(result.some((item) => item.subjectId === "at24" && item.ruleId === "project_no_next_action"), true);
  assert.equal(result.some((item) => item.subjectId === "before24"), false);
  assert.equal(result.some((item) => item.subjectId === "at14" && item.ruleId === "project_idle"), true);
  assert.equal(result.some((item) => item.subjectId === "before14" && item.ruleId === "project_idle"), false);
});

test("empty project without a deadline does not create Attention", () => {
  assert.deepEqual(evaluate([entity("empty", "project")]), []);
});

test("workspace scope, deterministic order, stable keys, and source revisions", () => {
  const overdue = entity("overdue", "task", { properties: { deadline: "2026-10-01", priority: "low" } });
  const soonLow = entity("soon-low", "task", { properties: { deadline: "2026-10-05", priority: "low" } });
  const soonHigh = entity("soon-high", "task", { properties: { deadline: "2026-10-05", priority: "high" } });
  const other = entity("other", "task", { workspaceId: "other", properties: { deadline: "2026-10-01" } });
  const original = evaluate([soonLow, other, overdue, soonHigh]);
  const reversed = evaluate([soonHigh, overdue, other, soonLow]);
  assert.deepEqual(original.map((item) => item.subjectId), ["overdue", "soon-high", "soon-low"]);
  assert.deepEqual(original.map((item) => item.attentionKey), reversed.map((item) => item.attentionKey));
  assert.equal(original[0].sourceRevisions.overdue, overdue.updatedAt);
  assert.equal(original[0].evaluatedDataRevision, 7);
  assert.equal(original[0].evaluatedAt, NOW);
  const renamed = evaluate([{ ...overdue, title: "Changed", updatedAt: NOW }, soonLow, soonHigh]);
  assert.equal(original[0].attentionKey, renamed[0].attentionKey);
});

test("a waiting task comes back on its follow-up date in the local timezone", () => {
  const task = entity("wait-date", "task", { updatedAt: NOW - DAY, properties: { waiting: true, waitingFor: "Petr", waitingSince: NOW - DAY, followUpDate: "2026-10-05" } });
  // 2026-10-05 starts at 2026-10-04T22:00Z in Prague (summer time).
  assert.deepEqual(evaluate([task], [], { evaluatedAt: Date.parse("2026-10-04T21:59:59.999Z") }), []);
  const [item] = evaluate([task], [], { evaluatedAt: Date.parse("2026-10-04T22:00:00Z") });
  assert.equal(item.ruleId, "waiting_follow_up");
  assert.equal(item.severity, 3);
  assert.equal(item.relevantDate, "2026-10-05");
  assert.equal(item.reasonFacts.waitingFor, "Petr");
});

test("a waiting task without a date comes back after 7 days", () => {
  const task = (since) => entity("wait-week", "task", { updatedAt: since, properties: { waiting: true, waitingSince: since } });
  assert.deepEqual(evaluate([task(NOW - 7 * DAY + 1)]), []);
  const [item] = evaluate([task(NOW - 7 * DAY)]);
  assert.equal(item.ruleId, "waiting_follow_up");
  assert.equal(item.relevantAt, NOW);
});

test("a completed task or one no longer waiting is not a waiting item", () => {
  assert.deepEqual(evaluate([entity("done", "task", { status: "completed", properties: { waiting: true, waitingSince: NOW - 30 * DAY } })]), []);
  assert.deepEqual(evaluate([entity("stopped", "task", { properties: { waiting: false, waitingSince: NOW - 30 * DAY } })]), []);
});

test("waiting items rank after deadlines and before project hygiene; a new date is a new occurrence", () => {
  const overdue = entity("a-overdue", "task", { properties: { deadline: "2026-10-01" } });
  const soon = entity("b-soon", "task", { properties: { deadline: "2026-10-05" } });
  const waiting = entity("c-waiting", "task", { properties: { waiting: true, followUpDate: "2026-10-03" } });
  const project = entity("d-project", "project");
  const projectTask = entity("d-task", "task", { status: "completed" });
  const relation = { id: "r", workspaceId: "personal", sourceEntityId: "d-task", targetEntityId: "d-project", relationType: "belongs_to_project", createdAt: NOW - 30 * DAY };
  const result = evaluate([project, projectTask, waiting, soon, overdue], [relation]);
  assert.deepEqual(result.map((item) => item.ruleId), ["deadline_overdue", "deadline_soon", "waiting_follow_up", "project_no_next_action", "project_idle"]);
  const moved = evaluate([entity("c-waiting", "task", { properties: { waiting: true, followUpDate: "2026-10-04" } })]);
  assert.notEqual(moved[0].attentionKey, result[2].attentionKey);
  assert.equal(evaluate([waiting])[0].attentionKey, result[2].attentionKey);
});

test("a waiting time later than the task's own time stays on the fallback as the clock moves", () => {
  const created = NOW - 20 * DAY;
  const task = entity("wait-ahead", "task", { createdAt: created, updatedAt: NOW - 10 * DAY, properties: { waiting: true, waitingSince: NOW - 5 * DAY } });
  const keys = [NOW, NOW + 6 * DAY].map((evaluatedAt) => evaluate([task], [], { evaluatedAt })[0]);
  assert.equal(keys[0].reasonFacts.waitingSince, created);
  assert.equal(keys[1].attentionKey, keys[0].attentionKey);
});

test("a waiting time that is not a past time falls back to when the task was created", () => {
  const created = NOW - 8 * DAY;
  for (const waitingSince of [NOW + DAY, -5, 1.5, "soon", null]) {
    const [item] = evaluate([entity("wait-bad", "task", { createdAt: created, updatedAt: NOW, properties: { waiting: true, waitingSince } })]);
    assert.equal(item?.ruleId, "waiting_follow_up", String(waitingSince));
    assert.equal(item.reasonFacts.waitingSince, created);
  }
});

test("the key of a dated waiting item does not depend on the time zone", () => {
  const task = entity("wait-zone", "task", { properties: { waiting: true, waitingSince: NOW - DAY, followUpDate: "2026-10-03" } });
  const prague = evaluate([task])[0];
  const newYork = evaluate([task], [], { timezone: "America/New_York" })[0];
  assert.equal(prague.attentionKey, newYork.attentionKey);
  assert.notEqual(prague.relevantAt, newYork.relevantAt);
});

test("a task whose planned day has passed needs attention from the next local day", () => {
  const task = (when, overrides = {}) => entity(`planned-${when}`, "task", { properties: { when, ...overrides } });
  // NOW is 2026-10-04 14:00 in Prague.
  assert.deepEqual(evaluate([task("2026-10-04")]), []);
  const [item] = evaluate([task("2026-10-03")]);
  assert.equal(item.ruleId, "planned_date_passed");
  assert.equal(item.severity, 5);
  assert.equal(item.relevantAt, Date.parse("2026-10-03T22:00:00Z"));
  assert.equal(item.reasonFacts.plannedDate, "2026-10-03");
  assert.ok(item.attentionKey.endsWith(":date-2026-10-03"));
  assert.equal(evaluate([task("2026-10-03")], [], { evaluatedAt: Date.parse("2026-10-03T21:59:59.999Z") }).length, 0);
});

test("a passed planned day is not shown for waiting, someday, completed or already deadline-flagged tasks", () => {
  assert.deepEqual(evaluate([entity("w", "task", { properties: { when: "2026-10-01", waiting: true, waitingSince: NOW - DAY } , updatedAt: NOW - DAY })]).map((item) => item.ruleId), []);
  assert.deepEqual(evaluate([entity("s", "task", { properties: { when: "2026-10-01", someday: true } })]), []);
  assert.deepEqual(evaluate([entity("b", "task", { properties: { when: "2026-10-01", blocked: true } })]), []);
  assert.deepEqual(evaluate([entity("c", "task", { status: "completed", properties: { when: "2026-10-01" } })]), []);
  assert.deepEqual(evaluate([entity("bad", "task", { properties: { when: "2026-02-30" } })]), []);
  assert.deepEqual(evaluate([entity("d", "task", { properties: { when: "2026-10-01", deadline: "2026-10-02" } })]).map((item) => item.ruleId), ["deadline_overdue"]);
  // A deadline far away does not hide the passed planned day.
  assert.deepEqual(evaluate([entity("f", "task", { properties: { when: "2026-10-01", deadline: "2026-12-01" } })]).map((item) => item.ruleId), ["planned_date_passed"]);
});

test("planned-day items rank last, so many of them do not push out project items", () => {
  const planned = Array.from({ length: 40 }, (_, index) => entity(`p-${index}`, "task", { properties: { when: `2026-09-${String(index % 28 + 1).padStart(2, "0")}` } }));
  const ids = evaluate([
    ...planned,
    entity("w-waiting", "task", { updatedAt: NOW - 8 * DAY, properties: { waiting: true, waitingSince: NOW - 8 * DAY } }),
    entity("idle-project", "project", { createdAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY }),
    entity("idle-task", "task", { status: "completed", createdAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY }),
  ], [{ id: "idle-link", workspaceId: "personal", sourceEntityId: "idle-task", targetEntityId: "idle-project", relationType: "belongs_to_project", createdAt: NOW - 20 * DAY }]).map((item) => item.ruleId);
  assert.equal(ids[0], "waiting_follow_up");
  const firstPlanned = ids.indexOf("planned_date_passed");
  assert.ok(ids.slice(1, firstPlanned).includes("project_idle"));
  assert.equal(ids.length - firstPlanned, 40);
});
