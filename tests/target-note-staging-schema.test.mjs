import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { TARGET_SCHEMA_SQL, TARGET_STORE_SCHEMA_VERSION, bootstrapIsolatedTargetStore } from "../lib/target-store-bootstrap.ts";
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
    assert.equal(TARGET_STORE_SCHEMA_VERSION, 13);
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

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-notes-v13-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
const previousDataDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
after(() => {
  if (previousDataDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

test("fresh v13 staging preflight accepts notes and rejects bypassed CHECK constraints", () => {
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
