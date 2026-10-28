import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r1-target-"));
const legacy = path.join(root, "legacy-store");
mkdirSync(legacy);
const sentinel = path.join(legacy, "store.sqlite");
writeFileSync(sentinel, "do-not-touch-legacy-database");
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
after(() => rmSync(root, { recursive: true, force: true }));

const { bootstrapIsolatedTargetStore, verifyTargetStagingPath } =
  await import("../lib/target-store-bootstrap.ts");

function fresh(name, ownerUserId = "owner") {
  return bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, name), ownerUserId,
  });
}
function open(result) {
  const db = new DatabaseSync(result.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
const plainRows = (rows) => rows.map((row) => ({ ...row }));
function seedShared(db, owner, suffix) {
  const workspace = "workspace:shared:" + suffix;
  const area = "area:shared:" + suffix;
  db.prepare("INSERT INTO workspaces(id, kind, owner_user_id) VALUES (?, 'shared', ?)")
    .run(workspace, owner);
  db.prepare("INSERT INTO areas(id, title, kind, workspace_id, owner_user_id) VALUES (?, ?, 'shared', ?, ?)")
    .run(area, "Shared", workspace, owner);
  return { workspace, area };
}

test("R1 creates a separate inactive store with one private Unassigned Area and no user data", () => {
  const result = fresh("empty-model");
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.directory, path.join(root, "empty-model"));
  assert.equal(result.databasePath, path.join(result.directory, "lumi-target.sqlite"));
  assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch-legacy-database");
  assert.deepEqual(readdirSync(legacy), ["store.sqlite"]);

  const db = open(result);
  try {
    const metadata = Object.fromEntries(db.prepare("SELECT key, value FROM metadata").all()
      .map(row => [row.key, row.value]));
    assert.equal(metadata.schema_version, "4");
    assert.equal(metadata.write_protocol, "per-item-only");
    assert.equal(metadata.activated, "false");
    assert.equal(metadata.restore_generation, result.restoreGeneration);
    assert.ok(result.restoreGeneration.length > 16);
    assert.deepEqual(plainRows(db.prepare("SELECT id, kind, owner_user_id FROM workspaces").all()),
      [{ id: result.personalWorkspaceId, kind: "personal", owner_user_id: "owner" }]);
    assert.deepEqual(plainRows(db.prepare("SELECT id, title, kind, system_key FROM areas").all()),
      [{ id: result.unassignedAreaId, title: "Nezařazeno", kind: "private", system_key: "unassigned" }]);
    for (const table of ["area_members", "projects", "tasks"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("R2a revision counters increase monotonically and reject same-ID replacement", () => {
  const store = fresh("monotonic-revisions");
  const db = open(store);
  try {
    db.prepare("INSERT INTO tasks(id, area_id, title) VALUES ('t1', ?, 'First')")
      .run(store.unassignedAreaId);
    const revision = () => db.prepare("SELECT revision FROM tasks WHERE id='t1'").get().revision;
    assert.equal(revision(), 0);
    db.prepare("UPDATE tasks SET title='Second' WHERE id='t1'").run();
    db.prepare("UPDATE tasks SET title='First' WHERE id='t1'").run();
    assert.equal(revision(), 2);
    db.prepare("UPDATE tasks SET title=title WHERE id='t1'").run();
    assert.equal(revision(), 2);
    assert.throws(() => db.prepare("UPDATE tasks SET revision=0 WHERE id='t1'").run(),
      /task revision must increment by one/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO tasks(id, area_id, title) VALUES ('t1', ?, 'Reset')")
      .run(store.unassignedAreaId), /task replacement is not allowed/);
    assert.equal(revision(), 2);
    assert.throws(() => db.prepare("DELETE FROM tasks WHERE id='t1'").run(),
      /task deletion requires tombstone protocol/);
    assert.equal(revision(), 2);

    const shared = seedShared(db, "owner", "version");
    const version = () => db.prepare("SELECT policy_revision FROM areas WHERE id=?")
      .get(shared.area).policy_revision;
    assert.equal(version(), 0);
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?, 'owner', 'admin')")
      .run(shared.area);
    assert.equal(version(), 1);
    db.prepare("UPDATE area_members SET role='editor' WHERE area_id=? AND user_id='owner'")
      .run(shared.area);
    assert.equal(version(), 2);
    db.prepare("UPDATE area_members SET role='admin' WHERE area_id=? AND user_id='owner'")
      .run(shared.area);
    assert.equal(version(), 3);
    assert.throws(() => db.prepare("UPDATE areas SET policy_revision=0 WHERE id=?")
      .run(shared.area), /Area policy revision must increment by one/);
    assert.equal(version(), 3);
  } finally {
    db.close();
  }
});

test("project revision survives title ABA and rejects counter reset or ID recycling", () => {
  const store = fresh("project-monotonic-revisions");
  const db = open(store);
  try {
    db.prepare("INSERT INTO projects(id, area_id, title) VALUES ('p', ?, 'A')")
      .run(store.unassignedAreaId);
    const row = () => db.prepare("SELECT title, revision FROM projects WHERE id='p'").get();
    assert.deepEqual({ ...row() }, { title: "A", revision: 0 });
    db.prepare("UPDATE projects SET title='B' WHERE id='p'").run();
    db.prepare("UPDATE projects SET title='A' WHERE id='p'").run();
    assert.deepEqual({ ...row() }, { title: "A", revision: 2 });
    db.prepare("UPDATE projects SET title=title WHERE id='p'").run();
    assert.equal(row().revision, 2);
    assert.throws(() => db.prepare("UPDATE projects SET revision=0 WHERE id='p'").run(),
      /project revision must increment by one/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO projects(id, area_id, title) VALUES ('p', ?, 'A')")
      .run(store.unassignedAreaId), /project replacement is not allowed/);
    assert.throws(() => db.prepare("UPDATE projects SET id='renamed' WHERE id='p'").run(),
      /project ID is immutable/);
    assert.throws(() => db.prepare("DELETE FROM projects WHERE id='p'").run(),
      /project deletion requires tombstone protocol/);
    // A rowid collision must not bypass the delete guard through SQLite REPLACE.
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO projects(rowid,id,area_id,title) VALUES (1,'other',?,'Reset')")
      .run(store.unassignedAreaId), /rowid/i);
    assert.throws(() => db.prepare("UPDATE OR REPLACE projects SET rowid=2 WHERE id='p'").run(),
      /rowid/i);
    assert.throws(() => db.prepare("UPDATE OR REPLACE projects SET id='renamed' WHERE id='p'").run(),
      /project ID is immutable/);
    assert.deepEqual({ ...row() }, { title: "A", revision: 2 });
  } finally {
    db.close();
  }
});

test("staging audit protects the minimum retention window but permits expired cleanup", () => {
  const store = fresh("audit-retention");
  const db = open(store);
  try {
    db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('audit-task',?,'Before')")
      .run(store.unassignedAreaId);
    db.prepare("UPDATE tasks SET title='After' WHERE id='audit-task'").run();
    const put = (suffix, when) => {
      const key = "r2:task-title-receipt-v2:" + suffix.repeat(64);
      db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(key, "f".repeat(64));
      db.prepare(`
        INSERT INTO task_title_audit(
          receipt_key,actor_user_id,task_id,area_id,policy_revision,
          revision_before,revision_after,expected_revision,restore_generation,committed_at_ms
        ) VALUES (?,'owner','audit-task',?,0,0,1,?,?,?)
      `).run(key, store.unassignedAreaId, "c".repeat(64), store.restoreGeneration, when);
      return key;
    };
    const expiredKey = put("a", Date.now() - 91 * 86400000);
    assert.throws(() => db.prepare("UPDATE task_title_audit SET task_id='changed'").run(),
      /audit events are immutable/);
    db.prepare("DELETE FROM task_title_audit WHERE receipt_key=?").run(expiredKey);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_title_audit").get().n, 0);
    const recentKey = put("b", Date.now());
    assert.throws(() => db.prepare("DELETE FROM task_title_audit WHERE receipt_key=?")
      .run(recentKey), /audit retention window is active/);
    assert.throws(() => db.prepare(
      "INSERT OR REPLACE INTO task_title_audit(receipt_key,actor_user_id,task_id,area_id,policy_revision,revision_before,revision_after,expected_revision,restore_generation,committed_at_ms) VALUES (?,'owner','audit-task',?,0,0,1,?,?,?)",
    ).run(recentKey, store.unassignedAreaId, "c".repeat(64), store.restoreGeneration, Date.now()),
    /audit replacement is forbidden/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_title_audit").get().n, 1);
  } finally {
    db.close();
  }
});

test("R1 refuses existing, overlapping, relative, symlink or invalid target paths without changes", () => {
  assert.throws(() => fresh("empty-model"), /already exists/);
  assert.throws(() => bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(legacy, "child"), ownerUserId: "owner",
  }), /overlaps/);
  assert.throws(() => bootstrapIsolatedTargetStore({
    stagingDirectory: legacy, ownerUserId: "owner",
  }), /already exists/);
  assert.throws(() => verifyTargetStagingPath("./relative"), /absolute/);
  assert.throws(() => verifyTargetStagingPath(`${root}/missing-parent/../unexpected`), /parent does not exist/);
  assert.throws(() => bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "bad-id"), ownerUserId: " owner ",
  }), /stable owner/);
  symlinkSync(legacy, path.join(root, "legacy-link"), "dir");
  assert.throws(() => verifyTargetStagingPath(path.join(root, "legacy-link")), /already exists/);
  assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch-legacy-database");
  assert.deepEqual(readdirSync(legacy), ["store.sqlite"]);
});

test("R1 resolves symlinks before dot-dot in both staging and configured legacy paths", () => {
  const nested = path.join(legacy, "nested");
  mkdirSync(nested);
  const alias = path.join(root, "nested-link");
  symlinkSync(nested, alias, "dir");
  assert.throws(() => verifyTargetStagingPath(alias + path.sep + ".." + path.sep + "inside-legacy"), /overlaps/);
  const configured = process.env.AI_EXECUTIVE_DATA_DIR;
  try {
    process.env.AI_EXECUTIVE_DATA_DIR = alias + path.sep + "..";
    assert.throws(() => verifyTargetStagingPath(path.join(legacy, "inside-legacy")), /overlaps/);
  } finally {
    process.env.AI_EXECUTIVE_DATA_DIR = configured;
  }
  assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch-legacy-database");
});

test("R1 enforces project inheritance and exactly one effective Area for each task", () => {
  const result = fresh("effective-areas");
  const db = open(result);
  try {
    db.prepare("INSERT INTO projects(id, area_id, title) VALUES (?, ?, ?)").run("p1", result.unassignedAreaId, "P");
    db.prepare("INSERT INTO tasks(id, project_id, title) VALUES (?, ?, ?)").run("t-project", "p1", "In project");
    db.prepare("INSERT INTO tasks(id, area_id, title) VALUES (?, ?, ?)").run("t-standalone", result.unassignedAreaId, "Standalone");
    assert.deepEqual(plainRows(db.prepare("SELECT task_id, effective_area_id FROM task_effective_areas ORDER BY task_id").all()), [
      { task_id: "t-project", effective_area_id: result.unassignedAreaId },
      { task_id: "t-standalone", effective_area_id: result.unassignedAreaId },
    ]);
    assert.throws(() => db.prepare("INSERT INTO tasks(id, title) VALUES (?, ?)").run("no-area", "Invalid"), /CHECK constraint/);
    assert.throws(() => db.prepare("INSERT INTO tasks(id, area_id, project_id, title) VALUES (?, ?, ?, ?)").run("double-area", result.unassignedAreaId, "p1", "Invalid"), /CHECK constraint/);
    assert.throws(() => db.prepare("INSERT INTO tasks(id, project_id, title) VALUES (?, ?, ?)").run("missing-project", "absent", "Invalid"), /FOREIGN KEY constraint/);
    assert.throws(() => db.prepare("DELETE FROM areas WHERE id = ?").run(result.unassignedAreaId), /cannot delete private Unassigned/);
  } finally {
    db.close();
  }
});

test("R1 prevents implicit sharing and enforces 1:1 shared Area to internal workspace", () => {
  const result = fresh("area-partition");
  const db = open(result);
  try {
    assert.throws(() => db.prepare("INSERT INTO areas(id, title, kind, workspace_id, owner_user_id) VALUES ('bad', 'Bad', 'shared', ?, 'owner')")
      .run(result.personalWorkspaceId), /FOREIGN KEY constraint/);
    assert.throws(() => db.prepare("INSERT INTO area_members(area_id, user_id, role) VALUES (?, 'owner', 'admin')")
      .run(result.unassignedAreaId), /membership requires a shared area/);
    const shared = seedShared(db, "owner", "one");
    assert.throws(() => db.prepare("INSERT INTO areas(id, title, kind, workspace_id, owner_user_id) VALUES ('shared-two', 'Bad', 'shared', ?, 'owner')")
      .run(shared.workspace), /Area replacement is not allowed/);
    assert.throws(() => db.prepare("UPDATE areas SET kind = 'private' WHERE id = ?").run(shared.area),
      /Area security boundary is immutable/);
    assert.throws(() => db.prepare("UPDATE workspaces SET kind = 'personal' WHERE id = ?").run(shared.workspace),
      /workspace security boundary is immutable/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM area_members").get().count, 0);
  } finally {
    db.close();
  }
});

test("R1 only permits assignment to current shared editors/admins, including inherited Areas", () => {
  const result = fresh("assignee-guards");
  const db = open(result);
  try {
    db.prepare("INSERT INTO identities(id) VALUES ('member')").run();
    db.prepare("INSERT INTO identities(id) VALUES ('viewer')").run();
    const shared = seedShared(db, "owner", "assignees");
    db.prepare("INSERT INTO area_members(area_id, user_id, role) VALUES (?, 'member', 'editor')").run(shared.area);
    db.prepare("INSERT INTO area_members(area_id, user_id, role) VALUES (?, 'viewer', 'viewer')").run(shared.area);
    db.prepare("INSERT INTO projects(id, area_id, title) VALUES ('p', ?, 'Shared project')").run(shared.area);
    assert.throws(() => db.prepare("INSERT INTO tasks(id, area_id, title, assignee_user_id) VALUES ('private', ?, 'No', 'member')")
      .run(result.unassignedAreaId), /assignee must be a shared-area editor/);
    assert.throws(() => db.prepare("INSERT INTO tasks(id, area_id, title, assignee_user_id) VALUES ('viewer-task', ?, 'No', 'viewer')")
      .run(shared.area), /assignee must be a shared-area editor/);
    db.prepare("INSERT INTO tasks(id, project_id, title, assignee_user_id) VALUES ('assigned', 'p', 'Yes', 'member')").run();
    assert.deepEqual(plainRows(db.prepare("SELECT task_id, effective_area_id, assignee_user_id FROM task_effective_areas").all()),
      [{ task_id: "assigned", effective_area_id: shared.area, assignee_user_id: "member" }]);
    assert.throws(() => db.prepare("UPDATE projects SET area_id = ? WHERE id = 'p'").run(result.unassignedAreaId),
      /project move requires R2 confirmation/);
    assert.throws(() => db.prepare("DELETE FROM area_members WHERE area_id = ? AND user_id = 'member'").run(shared.area),
      /unassign tasks before removing membership/);
    assert.throws(() => db.prepare("UPDATE area_members SET role = 'viewer' WHERE area_id = ? AND user_id = 'member'").run(shared.area),
      /unassign tasks before downgrading membership/);
    assert.throws(() => db.prepare("UPDATE area_members SET user_id = 'viewer' WHERE area_id = ? AND user_id = 'member'").run(shared.area),
      /membership identity is immutable/);
    db.prepare("UPDATE tasks SET assignee_user_id = NULL WHERE id = 'assigned'").run();
    db.prepare("DELETE FROM area_members WHERE area_id = ? AND user_id = 'member'").run(shared.area);
    assert.equal(db.prepare("SELECT assignee_user_id FROM tasks WHERE id = 'assigned'").get().assignee_user_id, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("R1 blocks scope-changing project moves even for unassigned tasks", () => {
  const result = fresh("unassigned-project-move");
  const db = open(result);
  try {
    const shared = seedShared(db, "owner", "move");
    db.prepare("INSERT INTO projects(id, area_id, title) VALUES ('p', ?, 'Private')").run(result.unassignedAreaId);
    db.prepare("INSERT INTO tasks(id, project_id, title) VALUES ('t', 'p', 'Private task')").run();
    assert.throws(() => db.prepare("UPDATE projects SET area_id = ? WHERE id = 'p'").run(shared.area),
      /project move requires R2 confirmation/);
    assert.equal(db.prepare("SELECT area_id FROM projects WHERE id = 'p'").get().area_id, result.unassignedAreaId);
    // Even an empty project's title is private until R2 can confirm sharing.
    db.prepare("INSERT INTO projects(id, area_id, title) VALUES ('empty', ?, 'Empty')").run(result.unassignedAreaId);
    assert.throws(() => db.prepare("UPDATE projects SET area_id = ? WHERE id = 'empty'").run(shared.area),
      /project move requires R2 confirmation/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO projects(id, area_id, title) VALUES ('empty', ?, 'Moved')").run(shared.area),
      /project move requires R2 confirmation/);
  } finally { db.close(); }
});

test("R1 conflicting replacements cannot bypass boundary and assignment guards", () => {
  const result = fresh("replace-guards");
  const db = open(result); // foreign_keys ON, recursive_triggers deliberately left at SQLite default OFF.
  try {
    assert.equal(db.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 0);
    db.prepare("INSERT INTO identities(id) VALUES ('member')").run();
    const shared = seedShared(db, "owner", "replace");
    db.prepare("INSERT INTO area_members(area_id, user_id, role) VALUES (?, 'member', 'editor')").run(shared.area);
    db.prepare("INSERT INTO tasks(id, area_id, title, assignee_user_id) VALUES ('assigned', ?, 'A', 'member')").run(shared.area);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO area_members(area_id, user_id, role) VALUES (?, 'member', 'viewer')").run(shared.area),
      /unassign tasks before downgrading membership/);
    assert.equal(db.prepare("SELECT role FROM area_members WHERE area_id = ? AND user_id = 'member'").get(shared.area).role, "editor");
    db.prepare("INSERT INTO identities(id) VALUES ('viewer')").run();
    db.prepare("INSERT INTO area_members(area_id, user_id, role) VALUES (?, 'viewer', 'viewer')").run(shared.area);
    assert.throws(() => db.prepare("UPDATE OR REPLACE area_members SET user_id = 'member' WHERE area_id = ? AND user_id = 'viewer'").run(shared.area),
      /membership identity is immutable/);
    assert.equal(db.prepare("SELECT role FROM area_members WHERE area_id = ? AND user_id = 'member'").get(shared.area).role, "editor");

    db.prepare("INSERT INTO projects(id, area_id, title) VALUES ('p', ?, 'P')").run(shared.area);
    db.prepare("INSERT INTO tasks(id, project_id, title, assignee_user_id) VALUES ('in-p', 'p', 'A', 'member')").run();
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO projects(id, area_id, title) VALUES ('p', ?, 'Moved')").run(result.unassignedAreaId),
      /project move requires R2 confirmation/);
    assert.equal(db.prepare("SELECT area_id FROM projects WHERE id = 'p'").get().area_id, shared.area);

    db.prepare("INSERT INTO tasks(id, area_id, title) VALUES ('private', ?, 'Private')").run(result.unassignedAreaId);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO areas(id, title, kind, workspace_id, owner_user_id) VALUES (?, 'Leaked', 'shared', ?, 'owner')")
      .run(result.unassignedAreaId, shared.workspace), /Area replacement is not allowed/);
    assert.equal(db.prepare("SELECT kind FROM areas WHERE id = ?").get(result.unassignedAreaId).kind, "private");
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO areas(id, title, kind, workspace_id, owner_user_id) VALUES ('other', 'Leaked', 'shared', ?, 'owner')")
      .run(shared.workspace), /Area replacement is not allowed/);
    db.prepare("INSERT INTO areas(id, title, kind, workspace_id, owner_user_id) VALUES ('private-other', 'Other', 'private', ?, 'owner')")
      .run(result.personalWorkspaceId);
    assert.throws(() => db.prepare("UPDATE OR REPLACE areas SET id = ? WHERE id = 'private-other'").run(result.unassignedAreaId),
      /Area ID is immutable/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO workspaces(id, kind, owner_user_id) VALUES (?, 'shared', 'owner')")
      .run(result.personalWorkspaceId), /workspace replacement is not allowed/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    // Non-conflicting inserts and safe updates still work.
    db.prepare("UPDATE projects SET title = 'Renamed' WHERE id = 'p'").run();
    db.prepare("UPDATE area_members SET role = 'admin' WHERE area_id = ? AND user_id = 'member'").run(shared.area);
  } finally { db.close(); }
});
