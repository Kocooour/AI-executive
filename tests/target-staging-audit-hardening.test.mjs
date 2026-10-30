import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const {
  bootstrapIsolatedTargetStore, TARGET_STAGING_AUDIT_MAX_EVENTS,
  TARGET_STAGING_RECEIPT_PREFIX,
} = await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-audit-hardening-"));
const fixtures = [];
after(() => {
  for (const { db, authority } of fixtures) {
    authority.close();
    db.close();
  }
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "owner",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('task',?,'Before')")
    .run(stage.unassignedAreaId);
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  });
  const value = { stage, db, authority };
  fixtures.push(value);
  return value;
}

const auditCount = db => db.prepare("SELECT COUNT(*) AS n FROM task_title_audit").get().n;
const receiptCount = db => db.prepare(
  "SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",
).get(TARGET_STAGING_RECEIPT_PREFIX + "%").n;
const preflight = stage => inspectIsolatedTargetStore({
  stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  mode: "r2-model",
});
function writable(authority) {
  const session = authority.issueWritable("owner");
  assert.ok(session);
  return session.sessionToken;
}
function preview(authority, token) {
  const result = authority.previewTaskTitleEdit(token, { taskId: "task" });
  assert.equal(result.ok, true);
  return result.snapshotRevision;
}
function write(authority, token, title, expectedRevision) {
  const { stage } = fixtures.find(value => value.authority === authority);
  return authority.updateTaskTitle(token, {
    commandId: randomUUID(), taskId: "task", title, expectedRevision,
    writeAreaId: stage.unassignedAreaId, restoreGeneration: stage.restoreGeneration,
  });
}
function insertAudit(db, stage, key, revision = "c".repeat(64),
  generation = stage.restoreGeneration) {
  db.prepare(`
    INSERT INTO task_title_audit(
      receipt_key,actor_user_id,task_id,area_id,policy_revision,
      revision_before,revision_after,expected_revision,restore_generation,committed_at_ms
    ) VALUES (?,'owner','task',?,0,0,1,?,?,?)
  `).run(key, stage.unassignedAreaId, revision, generation, Date.now());
}

test("preflight rejects orphan receipt linkage, wrong generation and malformed revision", () => {
  for (const [name, change] of [
    ["orphan receipt", { receipt: false }],
    ["wrong restore generation", { generation: randomUUID() }],
    ["malformed expected revision", { revision: "z".repeat(64) }],
  ]) {
    const { stage, db } = fixture();
    const key = TARGET_STAGING_RECEIPT_PREFIX + "a".repeat(64);
    if (change.receipt !== false) {
      db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
        .run(key, "b".repeat(64));
    }
    insertAudit(db, stage, key, change.revision, change.generation);
    assert.deepEqual(preflight(stage).issues, ["audit_invalid"], name);
  }
});

test("audit ledger accepts slot 4096 and then fails closed at capacity", () => {
  const { stage, db, authority } = fixture();
  const receipt = db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < TARGET_STAGING_AUDIT_MAX_EVENTS - 1; i++) {
      const hash = i.toString(16).padStart(64, "0");
      const key = TARGET_STAGING_RECEIPT_PREFIX + hash;
      receipt.run(key, hash);
      insertAudit(db, stage, key, hash);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  assert.deepEqual(preflight(stage), { ok: true, mode: "r2-model", issues: [] });
  const token = writable(authority);
  const initial = preview(authority, token);
  assert.deepEqual(write(authority, token, "Last audited edit", initial), { ok: true });
  assert.equal(auditCount(db), TARGET_STAGING_AUDIT_MAX_EVENTS);
  assert.equal(receiptCount(db), TARGET_STAGING_AUDIT_MAX_EVENTS);
  assert.throws(() => insertAudit(db, stage,
    TARGET_STAGING_RECEIPT_PREFIX + "f".repeat(64)), /audit capacity reached/);

  const current = preview(authority, token);
  const before = readFileSync(stage.databasePath);
  const task = db.prepare("SELECT title,revision FROM tasks WHERE id='task'").get();
  assert.deepEqual(write(authority, token, "Must not commit", current),
    { ok: false, reason: "write_failed" });
  assert.deepEqual(db.prepare("SELECT title,revision FROM tasks WHERE id='task'").get(), task);
  assert.equal(auditCount(db), TARGET_STAGING_AUDIT_MAX_EVENTS);
  assert.equal(receiptCount(db), TARGET_STAGING_AUDIT_MAX_EVENTS);
  assert.deepEqual(readFileSync(stage.databasePath), before);
});

test("explicit audit row-ID conflict cannot replace an event", () => {
  const { stage, db, authority } = fixture();
  const token = writable(authority);
  assert.deepEqual(write(authority, token, "Audited", preview(authority, token)), { ok: true });
  const row = db.prepare("SELECT * FROM task_title_audit").get();
  const before = readFileSync(stage.databasePath);
  assert.throws(() => db.prepare(`
    INSERT OR REPLACE INTO task_title_audit(
      id,receipt_key,actor_user_id,task_id,area_id,policy_revision,
      revision_before,revision_after,expected_revision,restore_generation,committed_at_ms
    ) VALUES (?,?,'owner','task',?,0,0,1,?,?,?)
  `).run(row.id, TARGET_STAGING_RECEIPT_PREFIX + "e".repeat(64),
    stage.unassignedAreaId, row.expected_revision, stage.restoreGeneration, Date.now()),
  /audit replacement is forbidden/);
  assert.deepEqual(db.prepare("SELECT * FROM task_title_audit").get(), row);
  assert.deepEqual(readFileSync(stage.databasePath), before);
});
