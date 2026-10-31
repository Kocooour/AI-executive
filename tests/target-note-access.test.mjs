import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readAuthorizedTargetNote } from "../lib/target-note-access.ts";

/**
 * R2d.2a uses a synthetic note schema until a canonical staging v13 schema,
 * write/sync protocol, preflight and live-release guard are implemented.
 */
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE identities(id TEXT PRIMARY KEY);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, kind TEXT, owner_user_id TEXT);
    CREATE TABLE areas(id TEXT PRIMARY KEY, kind TEXT, workspace_id TEXT,
      owner_user_id TEXT, policy_revision INTEGER);
    CREATE TABLE area_members(area_id TEXT, user_id TEXT, role TEXT,
      PRIMARY KEY(area_id,user_id));
    CREATE TABLE projects(id TEXT PRIMARY KEY, area_id TEXT NOT NULL, revision INTEGER);
    CREATE TABLE notes(id TEXT PRIMARY KEY, project_id TEXT, area_id TEXT,
      title TEXT, body TEXT, revision INTEGER);
  `);
  for (const id of ["alice", "bob", "carol", "dave", "erin"])
    db.prepare("INSERT INTO identities VALUES (?)").run(id);
  for (const [id, kind, owner] of [
    ["alice-personal", "personal", "alice"], ["bob-personal", "personal", "bob"],
    ["erin-personal", "personal", "erin"], ["family-ws", "shared", "alice"],
    ["other-ws", "shared", "erin"],
  ]) db.prepare("INSERT INTO workspaces VALUES (?,?,?)").run(id, kind, owner);
  for (const [id, kind, ws, owner] of [
    ["alice-private", "private", "alice-personal", "alice"],
    ["bob-private", "private", "bob-personal", "bob"],
    ["erin-private", "private", "erin-personal", "erin"],
    ["family", "shared", "family-ws", "alice"],
    ["other", "shared", "other-ws", "erin"],
  ]) db.prepare("INSERT INTO areas VALUES (?,?,?,?,0)").run(id, kind, ws, owner);
  for (const [area, actor, role] of [
    ["family", "alice", "admin"], ["family", "bob", "editor"],
    ["family", "carol", "viewer"], ["other", "erin", "admin"],
  ]) db.prepare("INSERT INTO area_members VALUES (?,?,?)").run(area, actor, role);
  for (const [id, area] of [
    ["private-project", "alice-private"], ["family-project", "family"],
    ["other-project", "other"],
  ]) db.prepare("INSERT INTO projects VALUES (?,?,0)").run(id, area);
  const insert = db.prepare("INSERT INTO notes VALUES (?,?,?,?,?,?)");
  insert.run("private-note", null, "alice-private", "Private", "Alice secret", 0);
  insert.run("bob-private", null, "bob-private", "Bob", "Bob secret", 0);
  insert.run("family-direct", "family-project", null, "Meeting", "Shared decisions", 2);
  insert.run("family-standalone", null, "family", "Inbox", "Shared idea", 0);
  insert.run("other-direct", "other-project", null, "Elsewhere", "Erin secret", 0);
  insert.run("private-reference", null, "alice-private", "Link",
    "Mentions family-project but stays private", 0);
  // A corrupt dual-parent record must never be quietly interpreted as shared.
  insert.run("dual-parent", "family-project", "alice-private", "Wrong", "No disclosure", 0);
  return db;
}
const get = (db, actor, noteId) => readAuthorizedTargetNote(db, { actorUserId: actor, noteId });

test("standalone note belongs to its own Area; a direct project note inherits the project Area", () => {
  const db = fixture();
  try {
    assert.equal(get(db, "alice", "private-note")?.note.body, "Alice secret");
    assert.equal(get(db, "bob", "private-note"), null);
    assert.equal(get(db, "alice", "bob-private"), null);
    assert.equal(get(db, "bob", "bob-private")?.note.body, "Bob secret");
    for (const [user, role] of [["alice", "admin"], ["bob", "editor"], ["carol", "viewer"]]) {
      const result = get(db, user, "family-direct");
      assert.deepEqual(result?.note, {
        id: "family-direct", title: "Meeting", body: "Shared decisions",
        projectId: "family-project", areaId: "family", areaKind: "shared", revision: 2,
      });
      assert.deepEqual(result?.linearization, {
        actorUserId: user, areas: [{
          areaId: "family", areaKind: "shared", policyRevision: 0, access: role,
        }],
      });
      assert.deepEqual(result?.guard, {
        noteId: "family-direct", projectId: "family-project", areaId: "family",
        noteRevision: 2, parentRevision: 0,
      });
      assert.equal(get(db, user, "family-standalone")?.note.areaId, "family");
      assert.equal(get(db, user, "other-direct"), null);
    }
    assert.equal(get(db, "dave", "family-direct"), null);
    assert.equal(get(db, "erin", "other-direct")?.note.body, "Erin secret");
  } finally {
    db.close();
  }
});

test("backlinks do not grant access; missing, foreign and malformed notes are indistinguishable", () => {
  const db = fixture();
  try {
    for (const id of ["private-note", "private-reference", "missing", "dual-parent"]) {
      assert.equal(get(db, "carol", id), null);
    }
    assert.equal(get(db, "alice", "dual-parent"), null);
    assert.equal(get(db, "bob", "private-reference"), null);
    assert.equal(get(db, "alice", "private-reference")?.note.areaKind, "private");
    for (const id of ["", " ", "..", "x\u0000y", "n".repeat(513), "' OR 1=1 --"]) {
      assert.equal(get(db, "alice", id), null);
    }
    assert.equal(get(db, "unknown", "family-direct"), null);
  } finally {
    db.close();
  }
});

test("new reads respect live membership and parent movement; no content at stale scope", () => {
  const db = fixture();
  try {
    assert.equal(get(db, "carol", "family-direct")?.note.body, "Shared decisions");
    db.prepare("DELETE FROM area_members WHERE area_id='family' AND user_id='carol'").run();
    db.prepare("UPDATE areas SET policy_revision=1 WHERE id='family'").run();
    assert.equal(get(db, "carol", "family-direct"), null);
    assert.equal(get(db, "bob", "family-direct")?.linearization.areas[0].policyRevision, 1);
    db.prepare("UPDATE projects SET area_id='alice-private', revision=revision+1 WHERE id='family-project'").run();
    assert.equal(get(db, "bob", "family-direct"), null);
    assert.equal(get(db, "alice", "family-direct")?.note.areaId, "alice-private");
    assert.deepEqual(get(db, "alice", "family-direct")?.guard, {
      noteId: "family-direct", projectId: "family-project", areaId: "alice-private",
      noteRevision: 2, parentRevision: 1,
    });
    db.prepare("UPDATE notes SET project_id=NULL, area_id='other', revision=revision+1 WHERE id='family-direct'").run();
    assert.deepEqual(get(db, "erin", "family-direct")?.guard, {
      noteId: "family-direct", projectId: null, areaId: "other",
      noteRevision: 3, parentRevision: null,
    });
    assert.equal(get(db, "alice", "family-direct"), null);
    assert.equal(get(db, "erin", "family-direct")?.note.body, "Shared decisions");
  } finally {
    db.close();
  }
});

test("corrupt note payloads and missing note schema fail closed", () => {
  const db = fixture();
  try {
    db.prepare("UPDATE notes SET body=? WHERE id='private-note'").run("X".repeat(128 * 1024 + 1));
    assert.equal(get(db, "alice", "private-note"), null);
    db.prepare("UPDATE notes SET revision=-1 WHERE id='family-standalone'").run();
    assert.equal(get(db, "alice", "family-standalone"), null);
    db.prepare("UPDATE workspaces SET kind='personal' WHERE id='family-ws'").run();
    assert.equal(get(db, "bob", "family-direct"), null);
    db.exec("DROP TABLE notes");
    assert.equal(get(db, "alice", "private-note"), null);
  } finally {
    db.close();
  }
});
