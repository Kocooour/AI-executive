import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readAuthorizedTargetNoteBootstrapPage as read } from "../lib/target-note-sync-bootstrap.ts";

const GENERATION_A = "00000000-0000-4000-8000-000000000001";
const GENERATION_B = "00000000-0000-4000-8000-000000000002";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE identities(id TEXT PRIMARY KEY);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, kind TEXT, owner_user_id TEXT);
    CREATE TABLE areas(id TEXT PRIMARY KEY, kind TEXT, workspace_id TEXT,
      owner_user_id TEXT, policy_revision INTEGER NOT NULL);
    CREATE TABLE area_members(area_id TEXT, user_id TEXT, role TEXT,
      PRIMARY KEY(area_id,user_id));
    CREATE TABLE projects(id TEXT PRIMARY KEY, area_id TEXT NOT NULL,
      title TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE notes(id TEXT PRIMARY KEY, project_id TEXT, area_id TEXT,
      title TEXT, body TEXT, revision INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO metadata VALUES (\'restore_generation\',?)").run(GENERATION_A);
  for (const id of ["alice", "bob", "carol", "erin", "outsider"])
    db.prepare("INSERT INTO identities VALUES (?)").run(id);
  for (const [id, kind, owner] of [
    ["alice-personal", "personal", "alice"],
    ["bob-personal", "personal", "bob"],
    ["team-space", "shared", "alice"],
  ]) db.prepare("INSERT INTO workspaces VALUES (?,?,?)").run(id, kind, owner);
  for (const [id, kind, workspace, owner] of [
    ["alice-private", "private", "alice-personal", "alice"],
    ["bob-private", "private", "bob-personal", "bob"],
    ["team-area", "shared", "team-space", "alice"],
  ]) db.prepare("INSERT INTO areas VALUES (?,?,?,?,0)").run(id, kind, workspace, owner);
  for (const [user, role] of [["alice", "admin"], ["bob", "editor"], ["carol", "viewer"]])
    db.prepare("INSERT INTO area_members VALUES ('team-area',?,?)").run(user, role);
  db.prepare("INSERT INTO projects VALUES ('team-project','team-area','Project',0)").run();
  const add = db.prepare("INSERT INTO notes VALUES (?,?,?,?,?,?)");
  add.run("private-note", null, "alice-private", "Private secret", "CONFIDENTIAL", 0);
  add.run("bob-private", null, "bob-private", "Bob secret", "PRIVATE", 0);
  add.run("direct", null, "team-area", "Team direct", "SHARED CONTENT", 1);
  add.run("child", "team-project", null, "Child note", "SECOND SHARED CONTENT", 2);
  return db;
}
function page(db, actor, area, limit = 100, afterId = null, expectedSnapshotRevision) {
  return read(db, { actorUserId: actor, areaId: area, limit, afterId, expectedSnapshotRevision });
}
const ids = p => p?.entries.map(x => x.id);

test("Area-bound manifest lists only permitted live IDs and structural revisions, never content", () => {
  const db = fixture();
  try {
    const privatePage = page(db, "alice", "alice-private");
    assert.deepEqual(ids(privatePage), ["private-note"]);
    assert.deepEqual(privatePage.entries[0], {
      id: "private-note", revision: 0, projectId: null, parentRevision: null,
    });
    assert.equal(privatePage.linearization.areas[0].access, "private-owner");
    assert.equal(page(db, "bob", "alice-private"), null);
    assert.equal(page(db, "alice", "bob-private"), null);
    assert.equal(page(db, "outsider", "team-area"), null);
    for (const [actor, role] of [
      ["alice", "admin"], ["bob", "editor"], ["carol", "viewer"],
    ]) {
      const shared = page(db, actor, "team-area");
      assert.deepEqual(ids(shared), ["child", "direct"]);
      assert.equal(shared.linearization.areas[0].access, role);
      assert.deepEqual(shared.entries[0], {
        id: "child", revision: 2, projectId: "team-project", parentRevision: 0,
      });
      const json = JSON.stringify(shared);
      for (const secret of ["CONFIDENTIAL", "SHARED CONTENT", "Child note", "Team direct"])
        assert.equal(json.includes(secret), false);
      assert.equal("body" in shared.entries[0], false);
      assert.equal("title" in shared.entries[0], false);
    }
  } finally { db.close(); }
});

test("bounded keyset pages share one Area snapshot revision and never repeat IDs", () => {
  const db = fixture();
  try {
    const first = page(db, "bob", "team-area", 1);
    const second = page(db, "bob", "team-area", 1, first.nextAfterId, first.snapshotRevision);
    assert.deepEqual(ids(first), ["child"]);
    assert.deepEqual(ids(second), ["direct"]);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextAfterId, null);
    assert.equal(first.snapshotRevision, second.snapshotRevision);
    assert.match(first.snapshotRevision, /^[a-f0-9]{64}$/);
    assert.deepEqual(ids(page(db, "bob", "team-area", 1, "z", first.snapshotRevision)), []);
    assert.equal(page(db, "bob", "team-area", 1, first.nextAfterId), null);
  } finally { db.close(); }
});

test("a new restore generation invalidates old continuation on identical Area and note data", () => {
  const beforeRestore = fixture();
  const afterRestore = fixture();
  try {
    const first = page(beforeRestore, "bob", "team-area", 1);
    const same = page(afterRestore, "bob", "team-area", 1);
    assert.deepEqual(first.entries, same.entries);
    assert.equal(first.snapshotRevision, same.snapshotRevision);
    assert.ok(first.nextAfterId, "two notes must require a second page");

    // Model the new store generation after restore; all Area and note rows
    // remain byte-for-byte equal, so only restore_generation may alter the digest.
    afterRestore.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'")
      .run(GENERATION_B);
    const restored = page(afterRestore, "bob", "team-area", 1);
    assert.deepEqual(restored.entries, first.entries);
    assert.notEqual(restored.snapshotRevision, first.snapshotRevision);
    assert.equal(page(afterRestore, "bob", "team-area", 1,
      first.nextAfterId, first.snapshotRevision), null);
    assert.deepEqual(ids(page(afterRestore, "bob", "team-area", 1,
      restored.nextAfterId, restored.snapshotRevision)), ["direct"]);
    assert.equal(page(beforeRestore, "bob", "team-area", 1,
      first.nextAfterId, first.snapshotRevision)?.entries[0].id, "direct");
  } finally {
    beforeRestore.close();
    afterRestore.close();
  }
});

test("missing and malformed canonical restore generations fail closed", () => {
  const db = fixture();
  try {
    for (const invalid of ["", "not-a-uuid", "0".repeat(36),
      "00000000-0000-0000-0000-000000000000", 123]) {
      db.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(invalid);
      assert.equal(page(db, "bob", "team-area"), null);
    }
    db.prepare("DELETE FROM metadata WHERE key='restore_generation'").run();
    assert.equal(page(db, "bob", "team-area"), null);
    db.prepare("INSERT INTO metadata VALUES ('restore_generation',?)").run(GENERATION_B);
    assert.ok(page(db, "bob", "team-area"));
    db.exec("DROP TABLE metadata");
    assert.equal(page(db, "bob", "team-area"), null);
  } finally { db.close(); }
});

test("edits, parent ABA, moves and deletions change the manifest digest", () => {
  const db = fixture();
  try {
    const initial = page(db, "bob", "team-area").snapshotRevision;
    db.prepare("UPDATE notes SET body='changed',revision=revision+1 WHERE id='direct'").run();
    const changed = page(db, "bob", "team-area").snapshotRevision;
    assert.notEqual(changed, initial);
    assert.equal(page(db, "bob", "team-area", 1, "child", initial), null);
    db.prepare("UPDATE notes SET body='SHARED CONTENT',revision=revision+1 WHERE id='direct'").run();
    const aba = page(db, "bob", "team-area").snapshotRevision;
    assert.notEqual(aba, initial);
    db.prepare("UPDATE projects SET title='Changed',revision=revision+1 WHERE id='team-project'").run();
    assert.notEqual(page(db, "bob", "team-area").snapshotRevision, aba);
    db.prepare("UPDATE notes SET project_id=NULL,area_id='alice-private',revision=revision+1 WHERE id='child'").run();
    assert.deepEqual(ids(page(db, "bob", "team-area")), ["direct"]);
    assert.deepEqual(ids(page(db, "alice", "alice-private")), ["child", "private-note"]);
    const beforeDeletion = page(db, "bob", "team-area").snapshotRevision;
    db.prepare("DELETE FROM notes WHERE id='direct'").run();
    assert.deepEqual(ids(page(db, "bob", "team-area")), []);
    assert.notEqual(page(db, "bob", "team-area").snapshotRevision, beforeDeletion);
  } finally { db.close(); }
});

test("ACL revocation and role/policy changes are reflected at each page, fail closed", () => {
  const db = fixture();
  try {
    const before = page(db, "carol", "team-area").snapshotRevision;
    db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='carol'").run();
    assert.notEqual(page(db, "carol", "team-area").snapshotRevision, before);
    db.prepare("UPDATE areas SET policy_revision=policy_revision+1 WHERE id='team-area'").run();
    const afterPolicy = page(db, "carol", "team-area").snapshotRevision;
    assert.notEqual(afterPolicy, before);
    db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='carol'").run();
    assert.equal(page(db, "carol", "team-area"), null);
    assert.ok(page(db, "bob", "team-area"));
    db.prepare("UPDATE areas SET owner_user_id=NULL WHERE id='team-area'").run();
    db.prepare("UPDATE workspaces SET owner_user_id=NULL WHERE id='team-space'").run();
    assert.equal(page(db, "bob", "team-area"), null);
    db.prepare("UPDATE areas SET owner_user_id='alice' WHERE id='team-area'").run();
    db.prepare("UPDATE workspaces SET owner_user_id='alice' WHERE id='team-space'").run();
    db.prepare("UPDATE workspaces SET kind='personal' WHERE id='team-space'").run();
    assert.equal(page(db, "bob", "team-area"), null);
  } finally { db.close(); }
});

test("malformed identifiers, bounds, invalid schema and excessive rows are rejected", () => {
  const db = fixture();
  try {
    const current = page(db, "bob", "team-area");
    for (const bad of ["", " ", "..", "x\u0001y", "x".repeat(513)]) {
      assert.equal(page(db, "bob", bad), null);
      assert.equal(page(db, "bob", "team-area", 2, bad, current.snapshotRevision), null);
    }
    assert.equal(read(db, { actorUserId: 123, areaId: "team-area", limit: 1, afterId: null }), null);
    assert.equal(read(db, { actorUserId: "bob", areaId: "team-area", limit: 1,
      afterId: "child", expectedSnapshotRevision: { toString: () => { throw Error("coerce"); } } }), null);
    assert.equal(page(db, "bob", "team-area", 1, "child", "invalid"), null);
    for (const limit of [0, 101, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(page(db, "bob", "team-area", limit), null);
    }
    assert.equal(page(db, "unknown", "team-area"), null);
    db.prepare("UPDATE notes SET revision=-1 WHERE id='child'").run();
    assert.equal(page(db, "bob", "team-area"), null);
    db.prepare("UPDATE notes SET revision=2 WHERE id='child'").run();
    db.exec("DROP TABLE projects");
    assert.equal(page(db, "bob", "team-area"), null);
  } finally { db.close(); }
});

test("the 4096-note staging ceiling is enforced before pagination, even for limit one", () => {
  const db = fixture();
  try {
    const insert = db.prepare("INSERT INTO notes VALUES (?,NULL,'team-area','N','B',0)");
    db.exec("BEGIN");
    for (let i = 0; i < 4096; i++) insert.run("extra-" + String(i).padStart(4, "0"));
    db.exec("COMMIT");
    assert.equal(page(db, "bob", "team-area", 1), null);
    db.prepare("DELETE FROM notes WHERE id='extra-0000'").run();
    assert.equal(page(db, "bob", "team-area", 1), null);
    db.prepare("DELETE FROM notes WHERE id='extra-0001'").run();
    assert.ok(page(db, "bob", "team-area", 1));
  } finally { db.close(); }
});
