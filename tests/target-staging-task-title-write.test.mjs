import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
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

const writeTitle = (authority, token, taskId, title, expectedRevision) =>
  authority.updateTaskTitle(token, { taskId, title, expectedRevision });

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

test("stale revisions, including unrelated changes, never mutate a task", () => {
  const { authority, writer } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const version = preview(authority, alice.sessionToken, "team-task");
  assert.equal(version.ok, true);
  writer.prepare("UPDATE tasks SET title='Other change' WHERE id='private-task'").run();
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Unsafe",
    version.snapshotRevision), rejected("stale_revision"));
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "Team original");
  const fresh = preview(authority, alice.sessionToken, "team-task");
  assert.equal(fresh.ok, true);
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "First commit",
    fresh.snapshotRevision), { ok: true });
  assert.deepEqual(writeTitle(authority, alice.sessionToken, "team-task", "Replay",
    fresh.snapshotRevision), rejected("stale_revision"));
  assert.equal(writer.prepare("SELECT title FROM tasks WHERE id='team-task'").get().title,
    "First commit");
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
  const good = { taskId: "team-task", title: "Valid", expectedRevision: version.snapshotRevision };
  for (const bad of [
    { ...good, actorUserId: "alice" }, { ...good, workspaceId: "team" },
    { ...good, expectedRevision: undefined }, { ...good, expectedRevision: null },
    { ...good, expectedRevision: "a" }, { ...good, title: "" },
    { ...good, title: " " }, { ...good, title: " leading" },
    { ...good, title: "trailing " }, { ...good, title: "bad\0title" },
    { ...good, title: "X".repeat(4097) }, null, {},
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
