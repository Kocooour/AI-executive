import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-work-session-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const work = await import("../lib/work-sessions.ts");
const store = await import("../lib/server-store.ts");

function addTask(id, updatedAt, properties = {}) {
  const task = { id, type: "task", title: `Task ${id}`, status: "open", workspaceId: "personal",
    properties, createdAt: updatedAt, updatedAt };
  store.getDatabase().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)")
    .run(task.id, JSON.stringify(task), task.updatedAt);
  return task;
}

test("one measured task is safely shared across devices, paused, resumed and finished", () => {
  let now = 1_000_000;
  const clock = () => now;
  const task = addTask("focus-task", now, { estimatedMinutes: 10 });
  const startInput = { workspaceId: "personal", action: "start", idempotencyKey: randomUUID(), taskId: task.id,
    expectedTaskUpdatedAt: task.updatedAt, expectedRevision: 0, expectedState: "idle" };
  const started = work.transitionWorkSession(startInput, clock);
  assert.equal(started.session.state, "running");
  assert.equal(started.session.estimatedMinutes, 10);
  assert.deepEqual(work.transitionWorkSession(startInput, clock), started);
  assert.equal(Number(store.getDatabase().prepare("SELECT COUNT(*) count FROM work_sessions").get().count), 1);

  const other = addTask("other-task", now, {});
  assert.throws(() => work.transitionWorkSession({ workspaceId: "personal", action: "start", idempotencyKey: randomUUID(),
    taskId: other.id, expectedTaskUpdatedAt: other.updatedAt, expectedRevision: 0, expectedState: "idle" }, clock),
  (error) => error.status === 409 && error.code === "active_session_conflict");

  now += 660_000;
  const paused = work.transitionWorkSession({ workspaceId: "personal", action: "pause", idempotencyKey: randomUUID(),
    expectedRevision: 1, expectedState: "running" }, clock);
  assert.equal(paused.session.accumulatedMs, 660_000);
  now += 600_000;
  const resumed = work.transitionWorkSession({ workspaceId: "personal", action: "resume", idempotencyKey: randomUUID(),
    expectedRevision: 2, expectedState: "paused" }, clock);
  now += 30_000;
  const finishInput = { workspaceId: "personal", action: "finish", idempotencyKey: randomUUID(),
    expectedRevision: resumed.session.revision, expectedState: "running" };
  const finished = work.transitionWorkSession(finishInput, clock);
  assert.deepEqual([finished.session.state, finished.session.elapsedMs, finished.session.overrun], ["completed", 690_000, true]);
  assert.deepEqual(work.transitionWorkSession(finishInput, clock), finished);
  assert.equal(work.getWorkSession("personal").active, null);
  const storedTask = JSON.parse(store.getDatabase().prepare("SELECT payload FROM entities WHERE id=?").get(task.id).payload);
  assert.equal(storedTask.status, "completed");
  assert.deepEqual([storedTask.properties.actualMinutes, storedTask.properties.workSessionHistory[0].estimatedMinutes], [12, 10]);
  assert.equal(Number(store.getDatabase().prepare("SELECT COUNT(*) count FROM work_session_intervals WHERE session_id=? AND ended_at IS NOT NULL").get(started.session.id).count), 2);
  assert.equal(work.measuredWorkHistory("personal").get(task.id)[0].actualMinutes, 12);
});

test("stale task versions and stale session revisions do not mutate state", () => {
  let now = 2_000_000;
  const clock = () => now;
  const task = addTask("stale-task", now);
  assert.throws(() => work.transitionWorkSession({ workspaceId: "personal", action: "start", idempotencyKey: randomUUID(),
    taskId: task.id, expectedTaskUpdatedAt: task.updatedAt - 1, expectedRevision: 0, expectedState: "idle" }, clock),
  (error) => error.status === 409 && error.code === "stale_state");
  const started = work.transitionWorkSession({ workspaceId: "personal", action: "start", idempotencyKey: randomUUID(),
    taskId: task.id, expectedTaskUpdatedAt: task.updatedAt, expectedRevision: 0, expectedState: "idle" }, clock);
  assert.equal(started.session.estimatedMinutes, 60);
  assert.throws(() => work.transitionWorkSession({ workspaceId: "personal", action: "pause", idempotencyKey: randomUUID(),
    expectedRevision: started.session.revision + 1, expectedState: "running" }, clock),
  (error) => error.status === 409 && error.code === "stale_state");
  assert.equal(work.getWorkSession("personal").active.revision, started.session.revision);
  store.getDatabase().prepare("DELETE FROM entities WHERE id=?").run(task.id);
  const closed = work.transitionWorkSession({ workspaceId: "personal", action: "finish", idempotencyKey: randomUUID(),
    expectedRevision: started.session.revision, expectedState: "running" }, clock);
  assert.equal(closed.taskCompleted, false);
  assert.equal(work.getWorkSession("personal").active, null);
});

test("finishing measured recurring work creates exactly one next occurrence with relations", () => {
  let now = Date.parse("2026-10-03T10:00:00Z");
  const clock = () => now;
  const task = addTask("weekly-task", now, { when: "2026-10-03", estimatedMinutes: 20,
    recurrence: { frequency: "weekly", interval: 1, mode: "scheduled" },
    waiting: true, waitingFor: "Petr", waitingSince: now - 1000, followUpDate: "2026-10-04" });
  const project = { id: "project-recurring", type: "project", title: "Project", status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now };
  store.getDatabase().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)").run(project.id, JSON.stringify(project), now);
  const relation = { id: randomUUID(), workspaceId: "personal", sourceEntityId: task.id, targetEntityId: project.id,
    relationType: "belongs_to_project", createdAt: now };
  store.getDatabase().prepare("INSERT INTO relations (id,payload,created_at) VALUES (?,?,?)").run(relation.id, JSON.stringify(relation), now);
  const started = work.transitionWorkSession({ workspaceId: "personal", action: "start", idempotencyKey: randomUUID(),
    taskId: task.id, expectedTaskUpdatedAt: task.updatedAt, expectedRevision: 0, expectedState: "idle" }, clock);
  now += 1_200_000;
  const finished = work.transitionWorkSession({ workspaceId: "personal", action: "finish", idempotencyKey: randomUUID(),
    expectedRevision: started.session.revision, expectedState: "running" }, clock);
  assert.equal(finished.taskCompleted, true);
  const nextId = `${task.id}:occurrence:2026-10-10`;
  const next = JSON.parse(store.getDatabase().prepare("SELECT payload FROM entities WHERE id=?").get(nextId).payload);
  assert.deepEqual([next.status, next.properties.when, next.properties.recurrenceSeriesId], ["open", "2026-10-10", task.id]);
  // Waiting belongs to the completed occurrence.
  assert.deepEqual(["waiting", "waitingFor", "waitingSince", "followUpDate"].filter((key) => key in next.properties), []);
  assert.equal(Number(store.getDatabase().prepare("SELECT COUNT(*) count FROM relations WHERE payload LIKE ?").get(`%${nextId}%`).count), 1);
});
