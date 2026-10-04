import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-attention-lifecycle-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));
const { evaluateAttention } = await import("../lib/attention.ts");
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
