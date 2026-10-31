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
    CREATE TABLE projects(id TEXT PRIMARY KEY, area_id TEXT NOT NULL,
      title TEXT NOT NULL, revision INTEGER NOT NULL);
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
  ]) db.prepare("INSERT INTO projects VALUES (?,?,?,0)").run(id, area, id + " title");
  const insert = db.prepare("INSERT INTO notes VALUES (?,?,?,?,?,?)");
  insert.run("private-note", null, "alice-private", "Private", "Alice secret", 0);
  insert.run("bob-private", null, "bob-private", "Bob", "Bob secret", 0);
  insert.run("family-direct", "family-project", null, "Meeting", "Shared decisions", 2);
  insert.run("family-standalone", null, "family", "Inbox", "Shared idea", 0);
  insert.run("other-direct", "other-project", null, "Elsewhere", "Erin secret", 0);
  // A literal text mention is not a persisted relation or backlink. Typed
  // relation ACL tests belong to R2d.2 once the canonical relation schema exists.
  insert.run("private-mention", null, "alice-private", "Text mention",
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

test("literal project mentions do not grant access; missing, foreign and malformed notes are indistinguishable", () => {
  const db = fixture();
  try {
    for (const id of ["private-note", "private-mention", "missing", "dual-parent"]) {
      assert.equal(get(db, "carol", id), null);
    }
    assert.equal(get(db, "alice", "dual-parent"), null);
    assert.equal(get(db, "bob", "private-mention"), null);
    assert.equal(get(db, "alice", "private-mention")?.note.areaKind, "private");
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

test("same-Area edits and ABA update note and project guards without changing parentage", () => {
  const db = fixture();
  try {
    const before = get(db, "bob", "family-direct");
    assert.ok(before);
    const expect = (noteRevision, parentRevision) => {
      const current = get(db, "bob", "family-direct");
      assert.ok(current);
      assert.equal(current.note.areaId, "family");
      assert.equal(current.note.projectId, "family-project");
      assert.deepEqual(current.guard, {
        noteId: "family-direct", projectId: "family-project", areaId: "family",
        noteRevision, parentRevision,
      });
      return current;
    };

    db.prepare("UPDATE notes SET title=?, revision=revision+1 WHERE id='family-direct'")
      .run("Renamed meeting");
    assert.equal(expect(3, 0).note.title, "Renamed meeting");

    db.prepare("UPDATE notes SET body=?, revision=revision+1 WHERE id='family-direct'")
      .run("Revised decisions");
    assert.equal(expect(4, 0).note.body, "Revised decisions");

    // Even when title/body return to their original values (ABA), a stale
    // snapshot guard must not match the later revision.
    db.prepare("UPDATE notes SET title=?, body=?, revision=revision+1 WHERE id='family-direct'")
      .run("Meeting", "Shared decisions");
    const afterNoteABA = expect(5, 0);
    assert.equal(afterNoteABA.note.title, before.note.title);
    assert.equal(afterNoteABA.note.body, before.note.body);
    assert.notDeepEqual(afterNoteABA.guard, before.guard);

    // A project-title change does not move the note, but its parent revision
    // must still change so a future live-release guard detects stale parent data.
    db.prepare("UPDATE projects SET title=?, revision=revision+1 WHERE id='family-project'")
      .run("Renamed family project");
    expect(5, 1);
    db.prepare("UPDATE projects SET title=?, revision=revision+1 WHERE id='family-project'")
      .run("family-project title");
    const afterParentABA = expect(5, 2);
    assert.notDeepEqual(afterParentABA.guard, before.guard);
    assert.equal(db.prepare("SELECT title FROM projects WHERE id='family-project'").get().title,
      "family-project title");
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
