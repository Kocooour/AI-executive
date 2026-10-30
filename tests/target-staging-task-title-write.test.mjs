import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2-stage-write-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
const oldDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore, TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_RECEIPT_PREFIX } =
  await import("../lib/target-store-bootstrap.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const fixtures = [];

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const writer = new DatabaseSync(stage.databasePath);
  writer.exec("PRAGMA foreign_keys=ON");
  writer.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
  writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
  writer.prepare(
    "INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob','private','bob-personal','bob','unassigned')",
  ).run();
  writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('private-task',?,'Alice private')").run(stage.unassignedAreaId);
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('bob-task','bob-private','Bob private')").run();
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('team-task','team-area','Team original')").run();
  writer.prepare("INSERT INTO projects(id,area_id,title) VALUES ('team-project','team-area','Project')").run();
  writer.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('project-task','team-project','Project original')").run();
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  });
  const item = { stage, writer, authority };
  fixtures.push(item);
  owners.set(authority, item);
  return item;
}

after(() => {
  for (const { writer, authority } of fixtures) {
    authority.close();
    writer.close();
  }
  if (oldDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = oldDataDir;
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
  rmSync(root, { recursive: true, force: true });
});

const preview = (authority, token, taskId) =>
  authority.previewTaskTitleEdit(token, { taskId });

// R2c.3: a client names the Area it writes into and the restore generation it synced to.
const owners = new WeakMap();
const contractOf = (authority, taskId) => {
  const { stage, writer } = owners.get(authority);
  return { writeAreaId: writer.prepare(`SELECT COALESCE(t.area_id,p.area_id) AS id FROM tasks t
    LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?`).get(taskId).id,
  restoreGeneration: stage.restoreGeneration };
};
const writeTitle = (authority, token, taskId, title, expectedRevision, commandId = randomUUID()) =>
  authority.updateTaskTitle(token, { commandId, taskId, title, expectedRevision,
    ...contractOf(authority, taskId) });

const rejected = reason => ({ ok: false, reason });

test("session-bound transaction updates private and inherited-Area tasks only for writers", () => {
  const { authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  const bob = authority.issueWritable("bob");
  assert.ok(alice && bob);
  const own = preview(authority, alice.sessionToken, "private-task");
  assert.equal(own.ok, true);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "private-task", "Private edited",
    own.snapshotRevision), { ok: true });
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='private-task'").get().title, "Private edited");

  const foreign = preview(authority, bob.sessionToken, "private-task");
  assert.deepEqual(foreign, { ok: false, reason: "unavailable", snapshotRevision: null });
  const team = preview(authority, bob.sessionToken, "project-task");
  assert.equal(team.ok, true);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "project-task", "Project edited",
    team.snapshotRevision), { ok: true });
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='project-task'").get().title,
    "Project edited");
  const bobPrivate = preview(authority, bob.sessionToken, "bob-task");
  assert.equal(bobPrivate.ok, true);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "bob-task", "Bob edited",
    bobPrivate.snapshotRevision), { ok: true });
});

test("read-only staging tokens can preview but cannot mutate even editable tasks", () => {
  const { authority, writer } = fixture();
  const readOnly = authority.issue("alice");
  assert.ok(readOnly);
  const version = preview(authority, readOnly.sessionToken, "team-task");
  assert.equal(version.ok, true);
  assert.deepEqual(writeTitle(authority, readOnly.sessionToken, "team-task", "Unauthorized",
    version.snapshotRevision), rejected("unauthorized"));
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Team original");
});

test("no-op mutations do not succeed or consume a byte-fingerprint revision", () => {
  const { authority, writer } = fixture();
  const actor = authority.issueWritable("alice");
  assert.ok(actor);
  const version = preview(authority, actor.sessionToken, "team-task");
  assert.equal(version.ok, true);
  assert.deepEqual(writeTitle(authority, actor.sessionToken, "team-task", "Team original",
    version.snapshotRevision), rejected("unchanged"));
  // A no-op is a rejected request, not a successful replayable mutation.
  assert.deepEqual(writeTitle(authority, actor.sessionToken, "team-task", "Changed",
    version.snapshotRevision), { ok: true });
  assert.deepEqual(writeTitle(authority, actor.sessionToken, "team-task", "Replay",
    version.snapshotRevision), rejected("stale_revision"));
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Changed");
});

test("staging writes reject public directories and database hardlinks", () => {
  const { stage, authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const version = preview(authority, alice.sessionToken, "team-task");
  assert.equal(version.ok, true);
  chmodSync(stage.directory, 0o755);
  try {
    assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Not allowed",
      version.snapshotRevision), rejected("unauthorized"));
  } finally {
    chmodSync(stage.directory, 0o700);
  }

  const alias = path.join(root, randomUUID() + "-linked");
  linkSync(stage.databasePath, alias);
  try {
    assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Not allowed",
      version.snapshotRevision), rejected("unauthorized"));
  } finally {
    unlinkSync(alias);
  }
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Team original");
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Allowed",
    version.snapshotRevision), { ok: true });
});

test("committed title edits have one content-free, immutable staging audit row", () => {
  const { stage, authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  const bob = authority.issueWritable("bob");
  const readOnly = authority.issue("bob");
  assert.ok(alice && bob && readOnly);
  const version = preview(authority, alice.sessionToken, "team-task");
  assert.equal(version.ok, true);
  const commandId = randomUUID();
  const audit = () => writer.prepare("SELECT * FROM task_title_audit ORDER BY id").all();
  assert.deepEqual(audit(), []);

  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Secret new title",
    version.snapshotRevision, commandId), { ok: true });
  const rows = audit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_user_id, "alice");
  assert.equal(rows[0].task_id, "team-task");
  assert.equal(rows[0].area_id, "team-area");
  assert.equal(rows[0].revision_before, 0);
  assert.equal(rows[0].revision_after, 1);
  assert.equal(rows[0].expected_revision, version.snapshotRevision);
  assert.equal(rows[0].restore_generation, stage.restoreGeneration);
  assert.ok(Number.isSafeInteger(rows[0].committed_at_ms));
  assert.ok(!JSON.stringify(rows).includes("Secret new title"));
  assert.ok(!JSON.stringify(rows).includes("Team original"));

  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Secret new title",
    version.snapshotRevision, commandId), { ok: true, replayed: true });
  const fresh = preview(authority, alice.sessionToken, "team-task");
  assert.equal(fresh.ok, true);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Secret new title",
    fresh.snapshotRevision), rejected("unchanged"));
  assert.deepEqual(writeTitle(authority, readOnly.sessionToken, "team-task", "Denied",
    fresh.snapshotRevision), rejected("unauthorized"));
  const privateVersion = preview(authority, alice.sessionToken, "private-task");
  assert.equal(privateVersion.ok, true);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "private-task", "Denied",
    privateVersion.snapshotRevision), rejected("unavailable"));
  assert.equal(audit().length, 1);
  assert.throws(() => writer.prepare("UPDATE task_title_audit SET actor_user_id='bob'").run(),
    /audit events are immutable/);
  assert.throws(() => writer.prepare("DELETE FROM task_title_audit").run(),
    /audit retention window is active/);
  assert.equal(audit().length, 1);
});

test("audit insertion failure rolls back title, revision and idempotency receipt", () => {
  const { authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const first = preview(authority, alice.sessionToken, "team-task");
  assert.equal(first.ok, true);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "First change",
    first.snapshotRevision), { ok: true });
  const next = preview(authority, alice.sessionToken, "team-task");
  assert.equal(next.ok, true);
  const before = writer.prepare("SELECT title,revision FROM tasks WHERE id='team-task'").get();
  const receipts = () => writer.prepare(
    "SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'r2:task-title-receipt-v2:%'",
  ).get().n;
  const count = receipts();
  // An exhausted AUTOINCREMENT sequence forces the final audit INSERT to fail,
  // after the title UPDATE and receipt INSERT, inside the same transaction.
  writer.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='task_title_audit'")
    .run("9223372036854775807");
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Must rollback",
    next.snapshotRevision), rejected("write_failed"));
  assert.deepEqual(writer.prepare("SELECT title,revision FROM tasks WHERE id='team-task'").get(),
    before);
  assert.equal(receipts(), count);
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM task_title_audit").get().n, 1);
});

test("task/policy CAS allows unrelated changes but detects same-task edits", () => {
  const { authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const version = preview(authority, alice.sessionToken, "team-task");
  assert.equal(version.ok, true);
  const taskRevision = writer.prepare("SELECT revision FROM tasks WHERE id='team-task'");
  assert.equal(taskRevision.get().revision, 0);
  writer.prepare("UPDATE tasks SET title='Other change' WHERE id='private-task'").run();
  // A write to an independent task no longer invalidates a valid preview.
  assert.deepEqual(preview(authority, alice.sessionToken, "team-task"), version);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Independent",
    version.snapshotRevision), { ok: true });
  assert.equal(taskRevision.get().revision, 1);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Replay",
    version.snapshotRevision), rejected("stale_revision"));

  const fresh = preview(authority, alice.sessionToken, "team-task");
  assert.equal(fresh.ok, true);
  // A value that changes and then reverts still advances the durable epoch.
  writer.prepare("UPDATE tasks SET title='Transient' WHERE id='team-task'").run();
  writer.prepare("UPDATE tasks SET title='Independent' WHERE id='team-task'").run();
  assert.equal(taskRevision.get().revision, 3);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Unsafe",
    fresh.snapshotRevision), rejected("stale_revision"));
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Independent");

  // No-op SQL UPDATE and a rolled-back edit must not consume revisions.
  const unchanged = taskRevision.get().revision;
  writer.prepare("UPDATE tasks SET title=title WHERE id='team-task'").run();
  writer.exec("BEGIN IMMEDIATE");
  try {
    writer.prepare("UPDATE tasks SET title='Will rollback' WHERE id='team-task'").run();
  } finally {
    writer.exec("ROLLBACK");
  }
  assert.equal(taskRevision.get().revision, unchanged);
});

test("task primary keys cannot be renamed and reused to replay a preview", () => {
  const { authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const original = preview(authority, alice.sessionToken, "team-task");
  assert.equal(original.ok, true);

  // Without an UPDATE-of-id guard, the old ID can be reused with revision 0,
  // making an old task/policy CAS token valid for a completely different task.
  assert.throws(
    () => writer.prepare("UPDATE tasks SET id='renamed-task' WHERE id='team-task'").run(),
    /task ID is immutable/,
  );
  assert.equal(writer.prepare("SELECT 1 FROM tasks WHERE id='renamed-task'").get(), undefined);
  assert.throws(
    () => writer.prepare(
      "INSERT INTO tasks(id,area_id,title) VALUES ('team-task','team-area','Replacement')",
    ).run(),
    /task replacement is not allowed/,
  );
  assert.equal(writer.prepare("SELECT revision FROM tasks WHERE id='team-task'").get().revision, 0);
  assert.deepEqual(preview(authority, alice.sessionToken, "team-task"), original);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Legitimate edit",
    original.snapshotRevision), { ok: true });
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Legitimate edit");
});

test("shared Area policy epochs detect revocation and restored permissions", () => {
  const { authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  const bob = authority.issueWritable("bob");
  assert.ok(alice && bob);
  const first = preview(authority, alice.sessionToken, "team-task");
  assert.equal(first.ok, true);
  const getPolicy = () => writer.prepare("SELECT policy_revision FROM areas WHERE id='team-area'")
    .get().policy_revision;
  const original = getPolicy();
  writer.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal(getPolicy(), original + 1);
  assert.deepEqual(preview(authority, bob.sessionToken, "team-task"),
    { ok: false, reason: "unavailable", snapshotRevision: null });
  writer.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal(getPolicy(), original + 2);
  // Even though Bob has edit permission again, the original policy-bound
  // preview cannot be replayed; permissions might have been revoked meanwhile.
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Stale",
    first.snapshotRevision), rejected("stale_revision"));
  const renewed = preview(authority, alice.sessionToken, "team-task");
  assert.equal(renewed.ok, true);
  assert.notEqual(renewed.snapshotRevision, first.snapshotRevision);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Allowed",
    renewed.snapshotRevision), { ok: true });
});

test("revoked and downgraded members cannot replay an authorized preview", () => {
  const { authority, writer } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const allowed = preview(authority, bob.sessionToken, "team-task");
  assert.equal(allowed.ok, true);
  writer.prepare(
    "UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'",
  ).run();
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Leaked",
    allowed.snapshotRevision), rejected("unavailable"));
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Team original");
  writer.prepare(
    "UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'",
  ).run();
  const fresh = preview(authority, bob.sessionToken, "team-task");
  assert.equal(fresh.ok, true);
  assert.equal(authority.revoke(bob.sessionToken), true);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Revoked",
    fresh.snapshotRevision), rejected("unauthorized"));
});

test("invalid title, actor overrides, missing revision and forged token fail closed", () => {
  const { authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const version = preview(authority, alice.sessionToken, "team-task");
  assert.equal(version.ok, true);
  const original = readFileSync(writer.prepare("PRAGMA database_list").all()[0].file);
  const good = { commandId: randomUUID(), taskId: "team-task", title: "Valid",
    expectedRevision: version.snapshotRevision, ...contractOf(authority, "team-task") };
  for (const bad of [
    { ...good, actorUserId: "alice" }, { ...good, workspaceId: "team" },
    { ...good, commandId: undefined }, { ...good, commandId: "not-a-uuid" },
    { ...good, expectedRevision: undefined }, { ...good, expectedRevision: null },
    { ...good, expectedRevision: "a" }, { ...good, title: "" },
    { ...good, title: " " }, { ...good, title: " leading" },
    { ...good, title: "trailing " }, { ...good, title: "bad\0title" },
    { ...good, title: "X".repeat(4097) }, null, {},
    { ...good, writeAreaId: undefined }, { ...good, writeAreaId: "" }, { ...good, writeAreaId: "bad id" },
    { ...good, restoreGeneration: undefined }, { ...good, restoreGeneration: "not-a-uuid" },
  ]) {
    assert.deepEqual(authority.updateTaskTitle(alice.sessionToken, bad),
      rejected("invalid_request"));
  }
  assert.deepEqual(authority.updateTaskTitle("forged", good), rejected("unauthorized"));
  assert.deepEqual(readFileSync(writer.prepare("PRAGMA database_list").all()[0].file), original);
});

test("rotated generation and tampered canonical schema block a write", () => {
  const first = fixture();
  const alice = first.authority.issueWritable("alice");
  assert.ok(alice);
  const version = preview(first.authority, alice.sessionToken, "team-task");
  assert.equal(version.ok, true);
  first.writer.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(randomUUID());
  assert.deepEqual(writeTitle(first.authority, alice.sessionToken, "team-task", "No",
    version.snapshotRevision), rejected("unauthorized"));
  assert.equal(first.writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Team original");

  const second = fixture();
  const newSession = second.authority.issueWritable("alice");
  assert.ok(newSession);
  const fresh = preview(second.authority, newSession.sessionToken, "team-task");
  assert.equal(fresh.ok, true);
  second.writer.exec("DROP TRIGGER protected_private_fallback");
  assert.deepEqual(writeTitle(second.authority, newSession.sessionToken, "team-task", "No",
    fresh.snapshotRevision), rejected("unauthorized"));
  assert.equal(second.writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Team original");
});

/**
 * Two live SQLite connections are enough to exercise real file-lock
 * contention. No timers, mocked exceptions, or write operations against the
 * legacy sentinel: the locks belong to the isolated fixture database.
 */
const assertNoSidecars = databasePath => {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    assert.equal(existsSync(databasePath + suffix), false,
      `unexpected SQLite sidecar ${suffix}`);
  }
};

test("competing BEGIN IMMEDIATE fails without altering bytes, generation or lock state", () => {
  const { stage, authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const initial = preview(authority, alice.sessionToken, "team-task");
  assert.equal(initial.ok, true);
  const before = readFileSync(stage.databasePath);
  const generation = writer.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value;
  const competing = new DatabaseSync(stage.databasePath);
  try {
    competing.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    try {
      // The reserved write lock is real. Our command fails at its own
      // BEGIN IMMEDIATE rather than reading ACL and writing without a lock.
      assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Must not commit",
        initial.snapshotRevision), rejected("write_failed"));
      assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
        "Team original");
      assert.equal(writer.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value,
        generation);
      assert.deepEqual(readFileSync(stage.databasePath), before);
    } finally {
      competing.exec("ROLLBACK");
    }
  } finally {
    competing.close();
  }
  assertNoSidecars(stage.databasePath);
  const next = preview(authority, alice.sessionToken, "team-task");
  assert.equal(next.ok, true);
  assert.equal(next.snapshotRevision, initial.snapshotRevision);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "After lock",
    next.snapshotRevision), { ok: true });
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "After lock");
  assertNoSidecars(stage.databasePath);
});

test("COMMIT SQLITE_BUSY rolls back title and receipt; identical command retry succeeds", () => {
  const { stage, authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const initial = preview(authority, alice.sessionToken, "team-task");
  assert.equal(initial.ok, true);
  const before = readFileSync(stage.databasePath);
  const generation = writer.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value;
  const commandId = randomUUID();
  const receipts = writer.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?");
  const competingReader = new DatabaseSync(stage.databasePath, { readOnly: true });
  try {
    competingReader.exec("PRAGMA query_only=ON; BEGIN");
    // BEGIN alone is deferred: SELECT establishes the SHARED lock that blocks
    // the staging writer's EXCLUSIVE lock at COMMIT in rollback-journal mode.
    assert.equal(competingReader.prepare("SELECT title FROM tasks WHERE id='team-task'")
      .get().title, "Team original");
    try {
      // BEGIN IMMEDIATE and UPDATE can run, but COMMIT must fail SQLITE_BUSY.
      // The finally ROLLBACK must undo the task change and remove -journal.
      assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "After reader release",
        initial.snapshotRevision, commandId), rejected("write_failed"));
      assert.equal(competingReader.prepare("SELECT title FROM tasks WHERE id='team-task'")
        .get().title, "Team original");
    } finally {
      competingReader.exec("ROLLBACK");
    }
  } finally {
    competingReader.close();
  }
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Team original");
  assert.equal(writer.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value,
    generation);
  assert.deepEqual(readFileSync(stage.databasePath), before);
  assert.equal(receipts.get(TARGET_STAGING_RECEIPT_PREFIX + "%").n, 0);
  assertNoSidecars(stage.databasePath);
  const next = preview(authority, alice.sessionToken, "team-task");
  assert.equal(next.ok, true);
  assert.equal(next.snapshotRevision, initial.snapshotRevision);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "After reader release",
    next.snapshotRevision, commandId), { ok: true });
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "After reader release");
  assert.equal(receipts.get(TARGET_STAGING_RECEIPT_PREFIX + "%").n, 1);
  const afterCommit = readFileSync(stage.databasePath);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "After reader release",
    initial.snapshotRevision, commandId), { ok: true, replayed: true });
  assert.deepEqual(readFileSync(stage.databasePath), afterCommit);
  assertNoSidecars(stage.databasePath);
});

test("successful task mutation has a durable actor-scoped receipt across authorities", () => {
  const { stage, writer, authority } = fixture();
  const first = authority.issueWritable("alice");
  assert.ok(first);
  const rev = preview(authority, first.sessionToken, "team-task");
  assert.equal(rev.ok, true);
  const commandId = randomUUID();
  assert.deepEqual(writeTitle(authority, first.sessionToken, "team-task", "Committed", rev.snapshotRevision,
    commandId), { ok: true });
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title, "Committed");
  const afterCommit = readFileSync(stage.databasePath);
  // Constructing a fresh authority produces a new key and cannot reuse the
  // old session. The receipt must nevertheless survive in the SQLite store.
  authority.close();
  const freshAuthority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  });
  owners.set(freshAuthority, owners.get(authority));
  try {
    const next = freshAuthority.issueWritable("alice");
    assert.ok(next);
    assert.deepEqual(writeTitle(freshAuthority, next.sessionToken, "team-task", "Committed",
      rev.snapshotRevision, commandId), { ok: true, replayed: true });
    assert.deepEqual(readFileSync(stage.databasePath), afterCommit);
    assert.deepEqual(writeTitle(freshAuthority, next.sessionToken, "team-task", "Altered",
      rev.snapshotRevision, commandId), rejected("idempotency_conflict"));
    assert.deepEqual(readFileSync(stage.databasePath), afterCommit);
    // Same command UUID is independent for a different authenticated actor.
    const bob = freshAuthority.issueWritable("bob");
    assert.ok(bob);
    const bobRev = preview(freshAuthority, bob.sessionToken, "project-task");
    assert.equal(bobRev.ok, true);
    assert.deepEqual(writeTitle(freshAuthority, bob.sessionToken, "project-task", "Bob committed",
      bobRev.snapshotRevision, commandId), { ok: true });
    assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='project-task'").get().title,
      "Bob committed");
    assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
      .get(TARGET_STAGING_RECEIPT_PREFIX + "%").n, 2);
    assert.deepEqual(writeTitle(freshAuthority, bob.sessionToken, "project-task", "Bob committed",
      bobRev.snapshotRevision, commandId), { ok: true, replayed: true });
    assert.deepEqual(writeTitle(freshAuthority, next.sessionToken, "team-task", "Committed",
      rev.snapshotRevision, commandId), { ok: true, replayed: true });
  } finally {
    freshAuthority.close();
  }
});

test("stored receipt cannot bypass a later Area downgrade or token revocation", () => {
  const { stage, writer, authority } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const rev = preview(authority, bob.sessionToken, "team-task");
  assert.equal(rev.ok, true);
  const commandId = randomUUID();
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Committed",
    rev.snapshotRevision, commandId), { ok: true });
  writer.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  const beforeDenied = readFileSync(stage.databasePath);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Committed",
    rev.snapshotRevision, commandId), rejected("unavailable"));
  assert.deepEqual(readFileSync(stage.databasePath), beforeDenied);
  writer.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  const beforeReplay = readFileSync(stage.databasePath);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Committed",
    rev.snapshotRevision, commandId), { ok: true, replayed: true });
  assert.deepEqual(readFileSync(stage.databasePath), beforeReplay);
  assert.equal(authority.revoke(bob.sessionToken), true);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Committed",
    rev.snapshotRevision, commandId), rejected("unauthorized"));
});

test("receipt ledger permits its last slot but fails closed when full", () => {
  const { stage, writer, authority } = fixture();
  const insert = writer.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  // Seed canonical content-free hashes efficiently, without 4095 expensive
  // per-command preflights; exercise the real writer at the capacity boundary.
  writer.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < TARGET_STAGING_MAX_RECEIPTS - 1; i++) {
      const hash = i.toString(16).padStart(64, "0");
      insert.run(TARGET_STAGING_RECEIPT_PREFIX + hash, hash);
    }
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const rev = preview(authority, alice.sessionToken, "team-task");
  assert.equal(rev.ok, true);
  const commandId = randomUUID();
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Last slot",
    rev.snapshotRevision, commandId), { ok: true });
  const count = writer.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?");
  assert.equal(count.get(TARGET_STAGING_RECEIPT_PREFIX + "%").n, TARGET_STAGING_MAX_RECEIPTS);
  const current = preview(authority, alice.sessionToken, "team-task");
  assert.equal(current.ok, true);
  const atCapacity = readFileSync(stage.databasePath);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Cannot append",
    current.snapshotRevision, randomUUID()), rejected("write_failed"));
  assert.deepEqual(readFileSync(stage.databasePath), atCapacity);
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Last slot");
  assert.equal(count.get(TARGET_STAGING_RECEIPT_PREFIX + "%").n, TARGET_STAGING_MAX_RECEIPTS);
  // Existing receipts remain replayable even when new writes are blocked.
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Last slot",
    rev.snapshotRevision, commandId), { ok: true, replayed: true });
  assert.deepEqual(readFileSync(stage.databasePath), atCapacity);
});

test("denied and rolled-back commands leave no durable receipt", () => {
  const { stage, writer, authority } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const allowed = preview(authority, bob.sessionToken, "team-task");
  assert.equal(allowed.ok, true);
  const commandId = randomUUID();
  writer.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Denied",
    allowed.snapshotRevision, commandId), rejected("unavailable"));
  writer.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  const fresh = preview(authority, bob.sessionToken, "team-task");
  assert.equal(fresh.ok, true);
  assert.deepEqual(writeTitle(authority, bob.sessionToken, "team-task", "Granted",
    fresh.snapshotRevision, commandId), { ok: true });

  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const next = preview(authority, alice.sessionToken, "team-task");
  assert.equal(next.ok, true);
  const lockedCommand = randomUUID();
  const competitor = new DatabaseSync(stage.databasePath);
  try {
    competitor.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Blocked",
      next.snapshotRevision, lockedCommand), rejected("write_failed"));
    competitor.exec("ROLLBACK");
  } finally {
    competitor.close();
  }
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "After lock",
    next.snapshotRevision, lockedCommand), { ok: true });
});

test("malformed receipt namespace fails canonical staging preflight", () => {
  const { writer, authority } = fixture();
  const token = authority.issueWritable("alice");
  assert.ok(token);
  writer.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run(TARGET_STAGING_RECEIPT_PREFIX + "malformed", "not-a-hash");
  assert.deepEqual(preview(authority, token.sessionToken, "team-task"),
    { ok: false, reason: "unauthorized", snapshotRevision: null });
  const fakeRevision = "a".repeat(64);
  assert.deepEqual(writeTitle(authority, token.sessionToken, "team-task", "Denied", fakeRevision),
    rejected("unauthorized"));
});

test("old actor-only receipts fail closed instead of losing their idempotency history", () => {
  const { stage, writer, authority } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const rev = preview(authority, alice.sessionToken, "team-task");
  assert.equal(rev.ok, true);
  const request = {
    commandId: randomUUID(), taskId: "team-task", title: "Must not apply",
    expectedRevision: rev.snapshotRevision, writeAreaId: "team-area", restoreGeneration: stage.restoreGeneration,
  };
  // The actor-only namespace belongs to #138 and cannot prove the original
  // task for ACL checks. An old staging DB must be re-bootstrapped, not reused.
  writer.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run("r2:task-title-receipt:" + "a".repeat(64), "b".repeat(64));
  const previous = readFileSync(stage.databasePath);
  assert.deepEqual(authority.taskTitleCommandStatus(alice.sessionToken, request),
    rejected("unauthorized"));
  assert.deepEqual(authority.updateTaskTitle(alice.sessionToken, request),
    rejected("unauthorized"));
  assert.equal(authority.issueWritable("alice"), null);
  assert.deepEqual(readFileSync(stage.databasePath), previous);
});

test("read-only command reconciliation is durable, actor/task-scoped and not a mutation", () => {
  const { stage, authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  const bob = authority.issueWritable("bob");
  const readOnly = authority.issue("alice");
  assert.ok(alice && bob && readOnly);
  const rev = preview(authority, alice.sessionToken, "team-task");
  assert.equal(rev.ok, true);
  const request = {
    commandId: randomUUID(), taskId: "team-task", title: "Committed", expectedRevision: rev.snapshotRevision,
    writeAreaId: "team-area", restoreGeneration: stage.restoreGeneration,
  };
  const status = (session, input = request) => authority.taskTitleCommandStatus(session, input);
  const untouched = readFileSync(stage.databasePath);
  assert.deepEqual(status(alice.sessionToken), { ok: true, status: "not_recorded" });
  assert.deepEqual(status(bob.sessionToken), { ok: true, status: "not_recorded" });
  assert.deepEqual(status(readOnly.sessionToken), rejected("unauthorized"));
  assert.deepEqual(status(alice.sessionToken, { ...request, commandId: "invalid" }),
    rejected("invalid_request"));
  assert.deepEqual(status(alice.sessionToken, { ...request, taskId: "missing-task" }),
    rejected("unavailable"));
  assert.deepEqual(readFileSync(stage.databasePath), untouched);

  assert.deepEqual(authority.updateTaskTitle(alice.sessionToken, request), { ok: true });
  const committedBytes = readFileSync(stage.databasePath);
  assert.deepEqual(status(alice.sessionToken), { ok: true, status: "committed" });
  assert.deepEqual(status(alice.sessionToken, { ...request, title: "Changed" }),
    rejected("idempotency_conflict"));
  assert.deepEqual(status(bob.sessionToken), { ok: true, status: "not_recorded" });
  assert.deepEqual(readFileSync(stage.databasePath), committedBytes);

  // Confirmation remains about the original commit, not current task state.
  const fresh = preview(authority, alice.sessionToken, "team-task");
  assert.equal(fresh.ok, true);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Later change",
    fresh.snapshotRevision), { ok: true });
  const laterBytes = readFileSync(stage.databasePath);
  assert.deepEqual(status(alice.sessionToken), { ok: true, status: "committed" });
  assert.deepEqual(readFileSync(stage.databasePath), laterBytes);
});

test("command status rechecks current ACL and session across restart", () => {
  const { stage, authority, writer } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const rev = preview(authority, bob.sessionToken, "team-task");
  assert.equal(rev.ok, true);
  const request = {
    commandId: randomUUID(), taskId: "team-task", title: "Bob committed",
    expectedRevision: rev.snapshotRevision, writeAreaId: "team-area", restoreGeneration: stage.restoreGeneration,
  };
  assert.deepEqual(authority.updateTaskTitle(bob.sessionToken, request), { ok: true });
  authority.close();
  const freshAuthority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  });
  try {
    const next = freshAuthority.issueWritable("bob");
    assert.ok(next);
    assert.deepEqual(freshAuthority.taskTitleCommandStatus(next.sessionToken, request),
      { ok: true, status: "committed" });
    writer.prepare(
      "UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'",
    ).run();
    const afterDowngrade = readFileSync(stage.databasePath);
    assert.deepEqual(freshAuthority.taskTitleCommandStatus(next.sessionToken, request),
      rejected("unavailable"));
    assert.deepEqual(readFileSync(stage.databasePath), afterDowngrade);
    writer.prepare(
      "UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'",
    ).run();
    assert.deepEqual(freshAuthority.taskTitleCommandStatus(next.sessionToken, request),
      { ok: true, status: "committed" });
    freshAuthority.revoke(next.sessionToken);
    assert.deepEqual(freshAuthority.taskTitleCommandStatus(next.sessionToken, request),
      rejected("unauthorized"));
  } finally {
    freshAuthority.close();
  }
});

test("rolled-back and stale writes remain unrecorded during reconciliation", () => {
  const { stage, authority } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const rev = preview(authority, alice.sessionToken, "team-task");
  assert.equal(rev.ok, true);
  const request = {
    commandId: randomUUID(), taskId: "team-task", title: "Blocked",
    expectedRevision: rev.snapshotRevision, writeAreaId: "team-area", restoreGeneration: stage.restoreGeneration,
  };
  const competing = new DatabaseSync(stage.databasePath);
  try {
    competing.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    assert.deepEqual(authority.updateTaskTitle(alice.sessionToken, request),
      rejected("write_failed"));
    competing.exec("ROLLBACK");
  } finally {
    competing.close();
  }
  const after = readFileSync(stage.databasePath);
  assert.deepEqual(authority.taskTitleCommandStatus(alice.sessionToken, request),
    { ok: true, status: "not_recorded" });
  assert.deepEqual(readFileSync(stage.databasePath), after);
  assert.deepEqual(authority.updateTaskTitle(alice.sessionToken, request), { ok: true });
  assert.deepEqual(authority.taskTitleCommandStatus(alice.sessionToken, request),
    { ok: true, status: "committed" });

  // A different UUID using the stale pre-write snapshot is not committed.
  const stale = { ...request, commandId: randomUUID(), title: "Stale" };
  assert.deepEqual(authority.updateTaskTitle(alice.sessionToken, stale),
    rejected("stale_revision"));
  assert.deepEqual(authority.taskTitleCommandStatus(alice.sessionToken, stale),
    { ok: true, status: "not_recorded" });
});

test("revoked command cannot be probed via another editable task", () => {
  const { stage, writer, authority } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const teamRev = preview(authority, bob.sessionToken, "team-task");
  assert.equal(teamRev.ok, true);
  const teamCommand = {
    commandId: randomUUID(), taskId: "team-task", title: "Committed team",
    expectedRevision: teamRev.snapshotRevision, writeAreaId: "team-area", restoreGeneration: stage.restoreGeneration,
  };
  const status = input => authority.taskTitleCommandStatus(bob.sessionToken, input);
  assert.deepEqual(authority.updateTaskTitle(bob.sessionToken, teamCommand), { ok: true });
  assert.deepEqual(status(teamCommand), { ok: true, status: "committed" });

  writer.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(status(teamCommand), rejected("unavailable"));
  const beforeProbe = readFileSync(stage.databasePath);
  // Bob still owns bob-task. Swapping the request's taskId must not
  // disclose the committed command for the now-inaccessible team-task.
  assert.deepEqual(status({ ...teamCommand, taskId: "bob-task", writeAreaId: "bob-private" }),
    { ok: true, status: "not_recorded" });
  assert.deepEqual(readFileSync(stage.databasePath), beforeProbe);

  // UUID reuse across DIFFERENT tasks is independent; within the same task
  // a changed payload still conflicts.
  const personalRev = preview(authority, bob.sessionToken, "bob-task");
  assert.equal(personalRev.ok, true);
  const privateCommand = {
    ...teamCommand, taskId: "bob-task", title: "Committed private",
    expectedRevision: personalRev.snapshotRevision, writeAreaId: "bob-private",
  };
  assert.deepEqual(status(privateCommand), { ok: true, status: "not_recorded" });
  assert.deepEqual(authority.updateTaskTitle(bob.sessionToken, privateCommand), { ok: true });
  assert.deepEqual(status(privateCommand), { ok: true, status: "committed" });
  assert.deepEqual(status({ ...privateCommand, title: "Modified" }),
    rejected("idempotency_conflict"));
  assert.deepEqual(authority.updateTaskTitle(bob.sessionToken,
    { ...privateCommand, title: "Modified" }), rejected("idempotency_conflict"));

  writer.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(status(teamCommand), { ok: true, status: "committed" });
  assert.deepEqual(status(privateCommand), { ok: true, status: "committed" });
});

test("separate staging authorities cannot use each other's session tokens", () => {
  const first = fixture();
  const second = fixture();
  const alice = first.authority.issueWritable("alice");
  assert.ok(alice);
  const version = preview(first.authority, alice.sessionToken, "team-task");
  assert.equal(version.ok, true);
  assert.deepEqual(writeTitle(second.authority, alice.sessionToken, "team-task", "Wrong store",
    version.snapshotRevision), rejected("unauthorized"));
  assert.equal(second.writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Team original");
});
