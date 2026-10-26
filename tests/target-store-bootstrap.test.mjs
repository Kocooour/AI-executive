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
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.directory, path.join(root, "empty-model"));
  assert.equal(result.databasePath, path.join(result.directory, "lumi-target.sqlite"));
  assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch-legacy-database");
  assert.deepEqual(readdirSync(legacy), ["store.sqlite"]);

  const db = open(result);
  try {
    const metadata = Object.fromEntries(db.prepare("SELECT key, value FROM metadata").all()
      .map(row => [row.key, row.value]));
    assert.equal(metadata.schema_version, "1");
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

test("R1 refuses existing, overlapping, relative, symlink or invalid target paths without changes", () => {
  assert.throws(() => fresh("empty-model"), /already exists/);
  assert.throws(() => bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(legacy, "child"), ownerUserId: "owner",
  }), /overlaps/);
  assert.throws(() => bootstrapIsolatedTargetStore({
    stagingDirectory: legacy, ownerUserId: "owner",
  }), /already exists/);
  assert.throws(() => verifyTargetStagingPath("./relative"), /absolute/);
  assert.throws(() => bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "bad-id"), ownerUserId: " owner ",
  }), /stable owner/);
  symlinkSync(legacy, path.join(root, "legacy-link"), "dir");
  assert.throws(() => verifyTargetStagingPath(path.join(root, "legacy-link")), /already exists/);
  assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch-legacy-database");
  assert.deepEqual(readdirSync(legacy), ["store.sqlite"]);
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
      .run(shared.workspace), /UNIQUE constraint/);
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
      /project move would invalidate an assignee/);
    assert.throws(() => db.prepare("DELETE FROM area_members WHERE area_id = ? AND user_id = 'member'").run(shared.area),
      /unassign tasks before removing membership/);
    assert.throws(() => db.prepare("UPDATE area_members SET role = 'viewer' WHERE area_id = ? AND user_id = 'member'").run(shared.area),
      /unassign tasks before downgrading membership/);
    assert.throws(() => db.prepare("UPDATE area_members SET user_id = 'viewer' WHERE area_id = ? AND user_id = 'member'").run(shared.area),
      /unassign tasks before moving membership/);
    db.prepare("UPDATE tasks SET assignee_user_id = NULL WHERE id = 'assigned'").run();
    db.prepare("DELETE FROM area_members WHERE area_id = ? AND user_id = 'member'").run(shared.area);
    assert.equal(db.prepare("SELECT assignee_user_id FROM tasks WHERE id = 'assigned'").get().assignee_user_id, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
