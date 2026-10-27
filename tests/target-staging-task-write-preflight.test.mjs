import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2-write-preflight-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
const priorDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const authenticatedRead = await import("../lib/target-task-authenticated-read.ts");
const fixtures = [];

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const writer = new DatabaseSync(stage.databasePath);
  writer.exec("PRAGMA foreign_keys = ON");
  for (const actor of ["bob", "carol"]) {
    writer.prepare("INSERT INTO identities(id) VALUES (?)").run(actor);
    writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)")
      .run(actor + "-personal", actor);
    writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(actor + "-private", actor + " private", actor + "-personal", actor);
  }
  writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','viewer')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','carol','editor')").run();
  const task = writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
  task.run("private-alice", stage.unassignedAreaId, "Alice private");
  task.run("private-bob", "bob-private", "Bob private");
  task.run("team-task", "team-area", "Shared task");
  writer.prepare("INSERT INTO projects(id,area_id,title) VALUES ('team-project','team-area','Shared project')").run();
  writer.prepare("INSERT INTO tasks(id,project_id,title) VALUES ('project-task','team-project','Project task')").run();
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  });
  const data = { stage, writer, authority };
  fixtures.push(data);
  return data;
}

after(() => {
  for (const { authority, writer } of fixtures) {
    authority.close();
    writer.close();
  }
  if (priorDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = priorDataDir;
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
  rmSync(root, { recursive: true, force: true });
});

const denied = reason => ({ ok: false, reason, snapshotRevision: null });
const preview = (authority, token, taskId, extra = {}) =>
  authority.previewTaskTitleEdit(token, { taskId, ...extra });

test("private ownership and live shared roles gate the title-edit preview", () => {
  const { authority } = fixture();
  const alice = authority.issue("alice");
  const bob = authority.issue("bob");
  const carol = authority.issue("carol");
  assert.ok(alice && bob && carol);
  assert.equal(preview(authority, alice.sessionToken, "private-alice").ok, true);
  assert.equal(preview(authority, bob.sessionToken, "private-bob").ok, true);
  assert.deepEqual(preview(authority, bob.sessionToken, "private-alice"), denied("unavailable"));
  assert.deepEqual(preview(authority, carol.sessionToken, "private-bob"), denied("unavailable"));
  assert.deepEqual(preview(authority, bob.sessionToken, "team-task"), denied("unavailable"));
  assert.deepEqual(preview(authority, bob.sessionToken, "project-task"), denied("unavailable"));
  assert.deepEqual(preview(authority, bob.sessionToken, "missing"), denied("unavailable"));
  assert.equal(preview(authority, carol.sessionToken, "team-task").ok, true);
  assert.equal(preview(authority, carol.sessionToken, "project-task").ok, true);
  assert.equal(preview(authority, alice.sessionToken, "project-task").ok, true);
  assert.deepEqual(preview(authority, carol.sessionToken, "private-alice"), denied("unavailable"));
});

test("preview hashes the pinned bytes, makes no write and rejects stale revision", () => {
  const { stage, authority, writer } = fixture();
  const alice = authority.issue("alice");
  assert.ok(alice);
  const before = readFileSync(stage.databasePath);
  const first = preview(authority, alice.sessionToken, "team-task");
  assert.equal(first.ok, true);
  assert.equal(first.snapshotRevision, createHash("sha256").update(before).digest("hex"));
  assert.deepEqual(readFileSync(stage.databasePath), before);
  const second = preview(authority, alice.sessionToken, "team-task", {
    expectedRevision: first.snapshotRevision,
  });
  assert.deepEqual(second, first);
  writer.prepare("UPDATE tasks SET title='Changed since preview' WHERE id='team-task'").run();
  assert.deepEqual(preview(authority, alice.sessionToken, "team-task", {
    expectedRevision: first.snapshotRevision,
  }), denied("stale_revision"));
  const fresh = preview(authority, alice.sessionToken, "team-task");
  assert.equal(fresh.ok, true);
  assert.notEqual(fresh.snapshotRevision, first.snapshotRevision);
});

test("revoking shared edit privileges returns content-free unavailable before revision checks", () => {
  const { authority, writer } = fixture();
  const carol = authority.issue("carol");
  const bob = authority.issue("bob");
  assert.ok(carol && bob);
  const granted = preview(authority, carol.sessionToken, "project-task");
  assert.equal(granted.ok, true);
  writer.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='carol'").run();
  assert.deepEqual(preview(authority, carol.sessionToken, "project-task", {
    expectedRevision: granted.snapshotRevision,
  }), denied("unavailable"));
  writer.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal(preview(authority, bob.sessionToken, "team-task").ok, true);
  writer.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(preview(authority, bob.sessionToken, "team-task"), denied("unavailable"));
});

test("bad request, forged session, expired session and rotated generation fail closed", () => {
  const { authority, writer } = fixture();
  const alice = authority.issue("alice");
  assert.ok(alice);
  for (const bad of [
    null, [], {}, { taskId: "" }, { taskId: 7 }, { taskId: "team-task", scope: "shared" },
    { taskId: "team-task", actorUserId: "alice" }, { taskId: "team-task", areaId: "team-area" },
    { taskId: "team-task", expectedRevision: null },
    { taskId: "team-task", expectedRevision: "a".repeat(63) },
    { taskId: "team-task", expectedRevision: "A".repeat(64) },
    { taskId: "x".repeat(4097) },
  ]) {
    assert.deepEqual(authority.previewTaskTitleEdit(alice.sessionToken, bad), denied("invalid_request"));
  }
  assert.deepEqual(preview(authority, "forged-token", "team-task"), denied("unauthorized"));
  assert.equal(authority.revoke(alice.sessionToken), true);
  assert.deepEqual(preview(authority, alice.sessionToken, "team-task"), denied("unauthorized"));
  const second = authority.issue("alice");
  assert.ok(second);
  writer.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(randomUUID());
  assert.deepEqual(preview(authority, second.sessionToken, "team-task"), denied("unauthorized"));
  assert.equal(authority.issue("alice"), null);
});

test("role upgrades, unrelated snapshot edits and empty task IDs cannot bypass policy", () => {
  const { authority, writer } = fixture();
  const bob = authority.issue("bob");
  assert.ok(bob);
  assert.deepEqual(preview(authority, bob.sessionToken, "team-task"), denied("unavailable"));
  writer.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  const permitted = preview(authority, bob.sessionToken, "team-task");
  assert.equal(permitted.ok, true);
  writer.prepare("UPDATE tasks SET title=? WHERE id='private-alice'").run("Another task");
  assert.deepEqual(preview(authority, bob.sessionToken, "team-task", {
    expectedRevision: permitted.snapshotRevision,
  }), denied("stale_revision"));
  assert.deepEqual(preview(authority, bob.sessionToken, "private-alice"), denied("unavailable"));
});

test("two staging databases cannot swap authorization, generation or revision", () => {
  const first = fixture();
  const second = fixture();
  second.writer.prepare(
    "UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'",
  ).run();
  const viewer = first.authority.issue("bob");
  const editor = second.authority.issue("bob");
  assert.ok(viewer && editor);
  assert.deepEqual(preview(first.authority, viewer.sessionToken, "team-task"), denied("unavailable"));
  const allowed = preview(second.authority, editor.sessionToken, "team-task");
  assert.equal(allowed.ok, true);
  // Different credentials and pinned staging stores may not be interchanged.
  assert.deepEqual(preview(first.authority, editor.sessionToken, "team-task"), denied("unauthorized"));
  assert.deepEqual(preview(second.authority, viewer.sessionToken, "team-task"), denied("unauthorized"));
  const wrongStore = new TargetStagingSessionAuthority({
    stagingDirectory: first.stage.directory,
    expectedRestoreGeneration: second.stage.restoreGeneration,
  });
  try {
    assert.equal(wrongStore.issue("bob"), null);
  } finally {
    wrongStore.close();
  }
  second.writer.prepare("UPDATE tasks SET title=? WHERE id='team-task'").run("Second changed");
  assert.deepEqual(preview(second.authority, editor.sessionToken, "team-task", {
    expectedRevision: allowed.snapshotRevision,
  }), denied("stale_revision"));
  assert.deepEqual(preview(first.authority, viewer.sessionToken, "team-task"), denied("unavailable"));
  // No exported low-level title edit selector accepts an independently chosen
  // SQLite connection and a file descriptor from another staging database.
  assert.equal(Object.hasOwn(authenticatedRead, "authorizeAuthenticatedIsolatedTargetTaskTitleEdit"), false);
});

test("canonical schema tampering invalidates an authenticated preview", () => {
  const { authority, writer } = fixture();
  const alice = authority.issue("alice");
  assert.ok(alice);
  assert.equal(preview(authority, alice.sessionToken, "team-task").ok, true);
  writer.exec("DROP TRIGGER protected_private_fallback");
  assert.deepEqual(preview(authority, alice.sessionToken, "team-task"), denied("unauthorized"));
});
