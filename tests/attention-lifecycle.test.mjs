import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-attention-lifecycle-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const { evaluateAttention, ongoingConditions } = await import("../lib/attention.ts");
const { attentionFingerprint, reconcileAttention, setAttentionState } = await import("../lib/attention-lifecycle.ts");
const { getDatabase } = await import("../lib/server-store.ts");
const now = Date.parse("2026-10-04T12:00:00Z");
const task = (updatedAt = 1, deadline = "2026-10-05") => ({ id: "task", type: "task", title: "Task", status: "open", workspaceId: "personal",
  properties: { deadline }, createdAt: 1, updatedAt });
const candidates = (entity, at = now) => evaluateAttention({ entities: [entity], relations: [], workspaceId: "personal",
  timezone: "Europe/Prague", evaluatedAt: at, dataRevision: 1 });

test("snooze survives reevaluation, expires, and records history without task content", () => {
  const item = candidates(task())[0];
  const first = reconcileAttention("personal", [item], now);
  assert.equal(first.items.length, 1);
  setAttentionState(item, "snooze", attentionFingerprint(item), now + 60_000, now);
  assert.deepEqual(reconcileAttention("personal", [item], now + 1).hidden, { snoozed: 1, dismissed: 0 });
  assert.equal(reconcileAttention("personal", [item], now + 60_000).items.length, 1);
  const history = getDatabase().prepare("SELECT reason, to_state FROM attention_history WHERE attention_key=? ORDER BY id").all(item.attentionKey);
  assert.deepEqual(history.map((row) => row.reason), ["detected", "user_snoozed", "snooze_expired"]);
  assert.equal(JSON.stringify(history).includes("Task"), false);
});

test("dismissal persists only for the unchanged source fingerprint", () => {
  const item = candidates(task())[0];
  setAttentionState(item, "dismiss", attentionFingerprint(item), null, now);
  assert.deepEqual(reconcileAttention("personal", [item], now + 1).hidden, { snoozed: 0, dismissed: 1 });
  const changed = candidates(task(2))[0];
  assert.equal(changed.attentionKey, item.attentionKey);
  assert.equal(reconcileAttention("personal", [changed], now + 2).items.length, 1);
  assert.throws(() => setAttentionState(changed, "dismiss", attentionFingerprint(item), null, now + 2), /changed/);
});

test("resolved conditions and replaced deadlines retire the old state", () => {
  const old = candidates(task())[0];
  reconcileAttention("personal", [], now + 1);
  const resolved = getDatabase().prepare("SELECT state FROM attention_states WHERE attention_key=?").get(old.attentionKey);
  assert.equal(resolved.state, "resolved");
  const replacement = candidates(task(3, "2026-10-05T18:00:00Z"))[0];
  reconcileAttention("personal", [old], now + 2);
  reconcileAttention("personal", [replacement], now + 3);
  const superseded = getDatabase().prepare("SELECT state FROM attention_states WHERE attention_key=?").get(old.attentionKey);
  assert.equal(superseded.state, "superseded");
});

// `revision` stands for later writes of the task (its time grows with it).
const waitingTask = (followUpDate = "2026-10-04", status = "open", revision = 1) => ({ id: "waiting-task", type: "task", title: "Waiting task", status,
  workspaceId: "personal", properties: { waiting: true, waitingFor: "Petr", waitingSince: now - 86_400_000, followUpDate }, createdAt: 1, updatedAt: now - 1000 + revision });

test("waiting follow-up: stable keys, snooze until the chosen instant, completion resolves", () => {
  const item = candidates(waitingTask())[0];
  assert.equal(item.ruleId, "waiting_follow_up");
  assert.equal(candidates(waitingTask(), now + 1)[0].attentionKey, item.attentionKey);
  assert.equal(reconcileAttention("personal", [item], now).items.length, 1);
  assert.equal(reconcileAttention("personal", candidates(waitingTask(), now + 1), now + 1).items.length, 1);
  setAttentionState(item, "snooze", attentionFingerprint(item), now + 3_600_000, now + 2);
  assert.deepEqual(reconcileAttention("personal", candidates(waitingTask(), now + 3), now + 3).hidden, { snoozed: 1, dismissed: 0 });
  assert.equal(reconcileAttention("personal", candidates(waitingTask(), now + 3_600_000), now + 3_600_000).items.length, 1);
  setAttentionState(item, "snooze", attentionFingerprint(item), now + 7_200_000, now + 3_600_001);
  // Completed before the snooze ends: no candidate any more, the item is resolved.
  assert.equal(candidates(waitingTask("2026-10-04", "completed", 2), now + 3_600_002).length, 0);
  reconcileAttention("personal", [], now + 3_600_002);
  const state = getDatabase().prepare("SELECT state FROM attention_states WHERE attention_key=?").get(item.attentionKey);
  assert.equal(state.state, "resolved");
  const history = getDatabase().prepare("SELECT to_state FROM attention_history WHERE attention_key=? ORDER BY id").all(item.attentionKey);
  assert.equal(history.filter((row) => row.to_state === "active").length, 2, "detected once and active again only after the snooze");
});

test("waiting follow-up: a changed date supersedes the item of the old date", () => {
  const old = candidates(waitingTask("2026-10-03", "open", 5))[0];
  reconcileAttention("personal", [old], now);
  const moved = candidates(waitingTask("2026-10-04", "open", 6))[0];
  assert.notEqual(moved.attentionKey, old.attentionKey);
  reconcileAttention("personal", [moved], now + 1);
  const state = getDatabase().prepare("SELECT state FROM attention_states WHERE attention_key=?").get(old.attentionKey);
  assert.equal(state.state, "superseded");
});

test("waiting follow-up: a date moved into the future or cleared supersedes, ending the waiting resolves", () => {
  for (const [label, followUpDate, waiting, expected] of [["future", "2026-10-20", true, "superseded"], ["cleared", "", true, "superseded"], ["ended", "", false, "resolved"]]) {
    const id = `waiting-${label}`;
    const due = { ...waitingTask("2026-10-02", "open", 10), id };
    const [item] = candidates(due);
    reconcileAttention("personal", [item], now);
    const moved = { ...due, updatedAt: due.updatedAt + 1, properties: { ...due.properties, waiting, followUpDate } };
    const next = evaluateAttention({ entities: [moved], relations: [], workspaceId: "personal", timezone: "Europe/Prague", evaluatedAt: now + 1, dataRevision: 2 });
    assert.equal(next.length, 0, label);
    reconcileAttention("personal", next, now + 1, ongoingConditions([moved], "personal"));
    const state = getDatabase().prepare("SELECT state FROM attention_states WHERE attention_key=?").get(item.attentionKey);
    assert.equal(state.state, expected, label);
  }
});

test("planned day: a new date supersedes the item of the old one", () => {
  const plannedTask = (when, updatedAt) => ({ id: "planned-task", type: "task", title: "Planned", status: "open", workspaceId: "personal",
    properties: { when }, createdAt: 1, updatedAt });
  const [old] = candidates(plannedTask("2026-10-01", 1));
  assert.equal(old.ruleId, "planned_date_passed");
  reconcileAttention("personal", [old], now);
  const [moved] = candidates(plannedTask("2026-10-02", 2));
  assert.notEqual(moved.attentionKey, old.attentionKey);
  reconcileAttention("personal", [moved], now + 1);
  assert.equal(getDatabase().prepare("SELECT state FROM attention_states WHERE attention_key=?").get(old.attentionKey).state, "superseded");
});

test("planned day: moved forward supersedes, cleared or done resolves", () => {
  const plannedTask = (id, when, status = "open", updatedAt = 1) => ({ id, type: "task", title: "Planned", status, workspaceId: "personal",
    properties: { when }, createdAt: 1, updatedAt });
  for (const [label, when, status, expected] of [["future", "2026-10-20", "open", "superseded"], ["cleared", "", "open", "resolved"], ["done", "2026-10-01", "completed", "resolved"]]) {
    const id = `planned-${label}`;
    const [item] = candidates(plannedTask(id, "2026-10-01"));
    reconcileAttention("personal", [item], now);
    const moved = plannedTask(id, when, status, 2);
    const next = evaluateAttention({ entities: [moved], relations: [], workspaceId: "personal", timezone: "Europe/Prague", evaluatedAt: now + 1, dataRevision: 2 });
    assert.equal(next.length, 0, label);
    reconcileAttention("personal", next, now + 1, ongoingConditions([moved], "personal"));
    assert.equal(getDatabase().prepare("SELECT state FROM attention_states WHERE attention_key=?").get(item.attentionKey).state, expected, label);
  }
});
