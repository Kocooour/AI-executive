import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TARGET_SCHEMA_SQL } from "../lib/target-store-bootstrap.ts";
import {
  checkTargetNoteWriteContract, previewTargetNoteWrite,
  validTargetNoteWriteContractRequest,
} from "../lib/target-note-write-contract.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(TARGET_SCHEMA_SQL);
  const generation = randomUUID();
  db.prepare("INSERT INTO metadata(key,value) VALUES('restore_generation',?)").run(generation);
  for (const user of ["alice", "bob", "carol", "erin"]) {
    db.prepare("INSERT INTO identities(id) VALUES(?)").run(user);
  }
  for (const [id, kind, owner] of [
    ["wa", "personal", "alice"], ["we", "personal", "erin"],
    ["ws", "shared", "alice"], ["ws2", "shared", "erin"],
  ]) db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES(?,?,?)")
    .run(id, kind, owner);
  for (const [id, kind, workspace, owner] of [
    ["private", "private", "wa", "alice"], ["foreign", "private", "we", "erin"],
    ["team", "shared", "ws", "alice"], ["other", "shared", "ws2", "erin"],
  ]) db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES(?,?,?,?,?)")
    .run(id, id, kind, workspace, owner);
  for (const [area, user, role] of [
    ["team", "alice", "admin"], ["team", "bob", "editor"], ["team", "carol", "viewer"],
    ["other", "erin", "admin"],
  ]) db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES(?,?,?)")
    .run(area, user, role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES('project','team','P')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES('own','private','Private','Secret')").run();
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES('direct','project','Shared','Body')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES('standalone','team','Team','Text')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES('elsewhere','foreign','E','Hidden')").run();
  return { db, generation };
}
const preview = (db, actor, noteId) => previewTargetNoteWrite(db, actor, noteId);
const check = (db, actor, r) => checkTargetNoteWriteContract(db, actor, r);
const rejected = reason => ({ ok: false, reason });
const allowed = (db, actor, noteId) => {
  const result = preview(db, actor, noteId);
  assert.equal(result.ok, true, JSON.stringify(result));
  return { noteId, expectedRevision: result.expectedRevision,
    writeAreaId: result.writeAreaId, restoreGeneration: result.restoreGeneration };
};

test("note preflight protects private, shared and project-inherited Area without returning content", () => {
  const { db } = fixture();
  try {
    for (const [actor, id] of [["alice", "own"], ["bob", "direct"], ["alice", "direct"],
      ["bob", "standalone"], ["erin", "elsewhere"]]) {
      const request = allowed(db, actor, id);
      assert.deepEqual(Object.keys(request).sort(),
        ["expectedRevision", "noteId", "restoreGeneration", "writeAreaId"]);
      assert.ok(!JSON.stringify(request).includes("Secret"));
      assert.ok(!JSON.stringify(request).includes("Body"));
      assert.deepEqual(check(db, actor, request).ok, true);
    }
    for (const [actor, id] of [
      ["bob", "own"], ["carol", "direct"], ["carol", "standalone"],
      ["erin", "direct"], ["alice", "elsewhere"], ["bob", "missing"],
    ]) assert.deepEqual(preview(db, actor, id), rejected("unavailable"));
    const privateRequest = allowed(db, "alice", "own");
    assert.deepEqual(check(db, "bob", privateRequest), rejected("unavailable"));
    assert.deepEqual(check(db, "carol", allowed(db, "bob", "direct")), rejected("unavailable"));
  } finally { db.close(); }
});

test("stale note, parent and Area policy ABA revisions all invalidate a previous preview", () => {
  const { db } = fixture();
  try {
    const original = allowed(db, "bob", "direct");
    db.prepare("UPDATE notes SET body='Changed' WHERE id='direct'").run();
    assert.deepEqual(check(db, "bob", original), rejected("stale_revision"));
    db.prepare("UPDATE notes SET body='Body' WHERE id='direct'").run();
    assert.deepEqual(check(db, "bob", original), rejected("stale_revision"));
    const second = allowed(db, "bob", "direct");
    db.prepare("UPDATE projects SET title='new' WHERE id='project'").run();
    db.prepare("UPDATE projects SET title='P' WHERE id='project'").run();
    assert.deepEqual(check(db, "bob", second), rejected("stale_revision"));
    const third = allowed(db, "bob", "direct");
    db.prepare("UPDATE area_members SET role='admin' WHERE area_id='team' AND user_id='bob'").run();
    db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team' AND user_id='bob'").run();
    assert.deepEqual(check(db, "bob", third), rejected("stale_revision"));
    assert.equal(check(db, "bob", allowed(db, "bob", "direct")).ok, true);
  } finally { db.close(); }
});

test("role revocation, parent move and foreign write Area fail closed", () => {
  const { db } = fixture();
  try {
    const old = allowed(db, "bob", "direct");
    const foreignArea = { ...old, writeAreaId: "private" };
    assert.deepEqual(check(db, "bob", foreignArea), rejected("unavailable"));
    // Both Areas editable by Alice, but the client cannot redirect a note's Area.
    assert.deepEqual(check(db, "alice", { ...allowed(db, "alice", "direct"),
      writeAreaId: "private" }), rejected("write_area_mismatch"));
    db.prepare("DELETE FROM area_members WHERE area_id='team' AND user_id='bob'").run();
    assert.deepEqual(check(db, "bob", old), rejected("unavailable"));
    assert.deepEqual(preview(db, "bob", "direct"), rejected("unavailable"));
    db.prepare("UPDATE projects SET area_id='private' WHERE id='project'").run();
    assert.deepEqual(check(db, "alice", { ...old }), rejected("write_area_mismatch"));
    assert.equal(check(db, "alice", allowed(db, "alice", "direct")).ok, true);
    assert.deepEqual(preview(db, "bob", "direct"), rejected("unavailable"));
  } finally { db.close(); }
});

test("generation and malformed requests fail without changing any note", () => {
  const { db, generation } = fixture();
  try {
    const request = allowed(db, "alice", "own");
    const before = db.prepare("SELECT * FROM notes WHERE id='own'").get();
    assert.equal(validTargetNoteWriteContractRequest(request), true);
    assert.deepEqual(check(db, "alice", { ...request, restoreGeneration: randomUUID() }),
      rejected("resync_required"));
    const invalid = [
      { ...request, noteId: ".." }, { ...request, expectedRevision: "x" },
      { ...request, ignored: "field" }, { ...request, writeAreaId: "" },
      { ...request, noteId: "x\u0000y" }, { ...request, noteId: "z".repeat(513) },
    ];
    for (const r of invalid) {
      assert.equal(validTargetNoteWriteContractRequest(r), false);
      assert.deepEqual(check(db, "alice", r), rejected("invalid_request"));
    }
    assert.equal(preview(db, "alice", "..").ok, false);
    db.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'")
      .run(randomUUID());
    assert.deepEqual(check(db, "alice", request), rejected("resync_required"));
    assert.notEqual(db.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value,
      generation);
    assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id='own'").get(), before);
  } finally { db.close(); }
});

test("malformed notes fail closed even if direct SQL bypassed CHECK constraints", () => {
  const { db } = fixture();
  try {
    db.exec("PRAGMA ignore_check_constraints=ON");
    db.prepare("UPDATE notes SET body=? WHERE id='own'").run("X".repeat(131073));
    assert.deepEqual(preview(db, "alice", "own"), rejected("unavailable"));
    assert.deepEqual(check(db, "alice", {
      ...allowed(db, "bob", "direct"), noteId: "own",
    }), rejected("unavailable"));
  } finally { db.close(); }
});
