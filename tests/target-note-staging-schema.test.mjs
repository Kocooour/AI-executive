import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { TARGET_SCHEMA_SQL, TARGET_STORE_SCHEMA_VERSION, TARGET_STAGING_NOTE_RECEIPT_PREFIX, bootstrapIsolatedTargetStore } from "../lib/target-store-bootstrap.ts";
import { inspectIsolatedTargetStore } from "../lib/target-store-preflight.ts";
import { readAuthorizedTargetNote } from "../lib/target-note-access.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(TARGET_SCHEMA_SQL);
  for (const id of ["alice", "bob", "carol"])
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(id);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('w-private','personal','alice')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('w-shared','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('a-private','Private','private','w-private','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('a-shared','Shared','shared','w-shared','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('a-shared','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('a-shared','bob','viewer')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('p-shared','a-shared','Project')").run();
  db.prepare("INSERT INTO notes(id,project_id,area_id,title,body) VALUES ('n-private',NULL,'a-private','Private','Secret')").run();
  db.prepare("INSERT INTO notes(id,project_id,area_id,title,body) VALUES ('n-shared','p-shared',NULL,'Team','Shared content')").run();
  return db;
}
const read = (db, actor, noteId) => readAuthorizedTargetNote(db, { actorUserId: actor, noteId });
const rev = (db, id) => db.prepare("SELECT revision FROM notes WHERE id=?").get(id).revision;

test("R2d.2b canonical schema protects private/parent-inherited note reads", () => {
  const db = fixture();
  try {
    assert.equal(TARGET_STORE_SCHEMA_VERSION, 15);
    assert.equal(read(db, "alice", "n-private")?.note.body, "Secret");
    assert.equal(read(db, "bob", "n-private"), null);
    assert.equal(read(db, "bob", "n-shared")?.note.body, "Shared content");
    assert.equal(read(db, "bob", "n-shared")?.note.areaId, "a-shared");
    assert.equal(read(db, "carol", "n-shared"), null);
    assert.equal(read(db, "bob", "missing"), null);
    db.prepare("DELETE FROM area_members WHERE area_id='a-shared' AND user_id='bob'").run();
    assert.equal(read(db, "bob", "n-shared"), null);
  } finally { db.close(); }
});

test("notes keep immutable IDs and monotonic revisions across content ABA", () => {
  const db = fixture();
  try {
    assert.equal(rev(db, "n-private"), 0);
    db.prepare("UPDATE notes SET body='Modified' WHERE id='n-private'").run();
    assert.equal(rev(db, "n-private"), 1);
    db.prepare("UPDATE notes SET body='Secret' WHERE id='n-private'").run();
    assert.equal(rev(db, "n-private"), 2);
    assert.equal(read(db, "alice", "n-private")?.note.body, "Secret");
    assert.throws(() => db.prepare("UPDATE notes SET revision=0 WHERE id='n-private'").run());
    assert.throws(() => db.prepare("UPDATE notes SET revision=revision+2 WHERE id='n-private'").run());
    assert.throws(() => db.prepare("UPDATE notes SET body='X', revision=revision+1 WHERE id='n-private'").run());
    assert.throws(() => db.prepare("UPDATE notes SET id='new-id' WHERE id='n-private'").run());
    assert.throws(() => db.prepare("DELETE FROM notes WHERE id='n-private'").run());
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO notes(id,area_id,title,body) VALUES ('n-private','a-private','Leak','Leak')").run());
    assert.equal(read(db, "alice", "n-private")?.note.body, "Secret");
    assert.equal(rev(db, "n-private"), 2);
  } finally { db.close(); }
});

test("note parent exclusivity, foreign keys, malformed IDs and size limits fail closed", () => {
  const db = fixture();
  try {
    const insert = db.prepare("INSERT INTO notes(id,project_id,area_id,title,body) VALUES (?,?,?,?,?)");
    const bad = [
      ["dual", "p-shared", "a-private", "Wrong", "bad"],
      ["orphan", null, null, "Wrong", "bad"],
      ["missing-project", "absent", null, "Wrong", "bad"],
      ["missing-area", null, "absent", "Wrong", "bad"],
      ["big-body", null, "a-private", "Wrong", "x".repeat(131073)],
      ["big-title", null, "a-private", "x".repeat(4097), "bad"],
      ["..", null, "a-private", "Wrong", "bad"],
      ["control\u0001", null, "a-private", "Wrong", "bad"],
      ["x".repeat(513), null, "a-private", "Wrong", "bad"],
    ];
    for (const args of bad) assert.throws(() => insert.run(...args), String(args[0]).slice(0,30));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 2);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("R2d.2c.2f.1 note tombstones preserve Area/parent and forbid ID reuse", () => {
  const db = fixture();
  try {
    const insert = db.prepare(`INSERT INTO note_tombstones
      (id,area_id,project_id,revision,deleted_at_ms) VALUES (?,?,?,?,?)`);
    assert.throws(() => db.prepare("DELETE FROM notes WHERE id='n-private'").run());
    for (const invalid of [
      ["n-private", "a-shared", null, 1, Date.now()],
      ["n-private", "a-private", "p-shared", 1, Date.now()],
      ["n-private", "a-private", null, 2, Date.now()],
      ["n-shared", "a-private", "p-shared", 1, Date.now()],
      ["n-shared", "a-shared", null, 1, Date.now()],
      ["not-here", "a-private", null, 1, Date.now()],
    ]) assert.throws(() => insert.run(...invalid), String(invalid));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_tombstones").get().n, 0);
    db.exec("BEGIN IMMEDIATE");
    try {
      insert.run("n-shared", "a-shared", "p-shared", 1, Date.now());
      assert.throws(() => db.prepare("UPDATE notes SET body='Changed' WHERE id='n-shared'").run());
      assert.throws(() => insert.run("n-shared", "a-shared", "p-shared", 1, Date.now()));
      db.prepare("DELETE FROM notes WHERE id='n-shared'").run();
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    assert.equal(read(db, "alice", "n-shared"), null);
    assert.equal(read(db, "bob", "n-shared"), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id='n-shared'").get().n, 0);
    assert.deepEqual({ ...db.prepare("SELECT id,area_id,project_id,revision FROM note_tombstones").get() },
      { id: "n-shared", area_id: "a-shared", project_id: "p-shared", revision: 1 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id='p-shared'").get().n, 1);
    assert.throws(() => db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('n-shared','p-shared','Resurrect','secret')").run());
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO notes(id,project_id,title,body) VALUES ('n-shared','p-shared','Resurrect','secret')").run());
    assert.throws(() => db.prepare("UPDATE note_tombstones SET revision=2 WHERE id='n-shared'").run());
    assert.throws(() => db.prepare("DELETE FROM note_tombstones WHERE id='n-shared'").run());
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO note_tombstones(id,area_id,project_id,revision,deleted_at_ms) VALUES ('n-shared','a-shared','p-shared',2,1)").run());
  } finally { db.close(); }
});

test("content-free note edit audit survives a tombstoned deletion", () => {
  const db = fixture();
  try {
    db.prepare(`INSERT INTO note_edit_audit (
      receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
      revision_before,revision_after,expected_revision,restore_generation,committed_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      "test-receipt", "alice", "n-private", null, "a-private", 0,
      0, 1, "a".repeat(64), "test-generation", Date.now(),
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO note_tombstones(id,area_id,project_id,revision,deleted_at_ms) VALUES ('n-private','a-private',NULL,1,?)").run(Date.now());
      db.prepare("DELETE FROM notes WHERE id='n-private'").run();
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit WHERE note_id='n-private'").get().n, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("uncommitted tombstone + deletion rolls back atomically", () => {
  const db = fixture();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO note_tombstones(id,area_id,project_id,revision,deleted_at_ms) VALUES ('n-private','a-private',NULL,1,?)")
      .run(Date.now());
    db.prepare("DELETE FROM notes WHERE id='n-private'").run();
    db.exec("ROLLBACK");
    assert.equal(read(db, "alice", "n-private")?.note.body, "Secret");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_tombstones").get().n, 0);
  } finally { db.close(); }
});

test("note reparenting changes visibility and advances a non-ABA revision", () => {
  const db = fixture();
  try {
    const before = read(db, "bob", "n-shared");
    assert.ok(before);
    db.prepare("UPDATE notes SET project_id=NULL, area_id='a-private' WHERE id='n-shared'").run();
    assert.equal(read(db, "bob", "n-shared"), null);
    assert.equal(read(db, "alice", "n-shared")?.note.areaId, "a-private");
    assert.equal(rev(db, "n-shared"), 1);
    db.prepare("UPDATE notes SET project_id='p-shared', area_id=NULL WHERE id='n-shared'").run();
    assert.equal(read(db, "bob", "n-shared")?.note.areaId, "a-shared");
    const after = read(db, "bob", "n-shared");
    assert.ok(after);
    assert.equal(rev(db, "n-shared"), 2);
    assert.notDeepEqual(after.guard, before.guard);
  } finally { db.close(); }
});

test("an attached note blocks a project deletion even with a valid project tombstone", () => {
  const db = fixture();
  try {
    const project = db.prepare("SELECT area_id, revision FROM projects WHERE id='p-shared'").get();
    const next = db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM change_log").get().seq;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO project_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES (?,?,?,?,?)")
        .run("p-shared", project.area_id, project.revision + 1, next, Date.now());
      assert.throws(() => db.prepare("DELETE FROM projects WHERE id='p-shared'").run());
    } finally { db.exec("ROLLBACK"); }
    assert.equal(read(db, "bob", "n-shared")?.note.projectId, "p-shared");
  } finally { db.close(); }
});

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-notes-v15-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
const previousDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
after(() => {
  if (previousDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

test("fresh v15 staging preflight accepts notes and rejects bypassed CHECK constraints", () => {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "staging"), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES (?,?,?,?)")
      .run("n-1", stage.unassignedAreaId, "Title", "Body");
    const check = () => inspectIsolatedTargetStore({ stagingDirectory: stage.directory });
    assert.deepEqual(check(), { ok: true, mode: "stage", issues: [] });
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.prepare("UPDATE notes SET body=? WHERE id='n-1'").run(Buffer.from("bad"));
    const invalid = check();
    assert.equal(invalid.ok, false);
    assert.ok(invalid.issues.includes("note_invalid"), JSON.stringify(invalid));
  } finally { db.close(); }
});

test("v15 preflight rejects an orphaned pending note tombstone", () => {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "pending-tombstone"), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('pending',?,'Title','Body')").run(stage.unassignedAreaId);
    db.prepare(`INSERT INTO note_tombstones(id,area_id,project_id,revision,deleted_at_ms)
      VALUES ('pending',?,NULL,1,?)`).run(stage.unassignedAreaId, Date.now());
    const result = inspectIsolatedTargetStore({ stagingDirectory: stage.directory });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("tombstone_invalid"), JSON.stringify(result));
  } finally { db.close(); }
});

test("v15 preflight refuses a forged edit audit referencing neither live note nor tombstone", () => {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "orphan-edit-audit"), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const key = TARGET_STAGING_NOTE_RECEIPT_PREFIX + "a".repeat(64);
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(key, "b".repeat(64));
    db.prepare(`INSERT INTO note_edit_audit (
      receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
      revision_before,revision_after,expected_revision,restore_generation,committed_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      key, "alice", "never-existed", null, stage.unassignedAreaId, 0,
      0, 1, "c".repeat(64), stage.restoreGeneration, Date.now(),
    );
    const result = inspectIsolatedTargetStore({ stagingDirectory: stage.directory });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes("audit_invalid"), JSON.stringify(result));
  } finally { db.close(); }
});
