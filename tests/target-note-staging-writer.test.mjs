import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-note-edit-"));
const legacy = path.join(root, "production-sentinel");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "keep"), "unchanged");
const oldDir = process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore, TARGET_STAGING_NOTE_RECEIPT_PREFIX } =
  await import("../lib/target-store-bootstrap.ts");
const { TargetStagingSessionAuthority } =
  await import("../lib/target-staging-session-authority.ts");
const { previewTargetNoteWrite } =
  await import("../lib/target-note-write-contract.ts");
const { validTargetStagingNoteEditRequest, targetNoteEditReceiptKey } =
  await import("../lib/target-note-staging-writer.ts");

const fixtures = [];
function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const id of ["bob", "carol"]) db.prepare("INSERT INTO identities(id) VALUES (?)").run(id);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES('team-area','Team','shared','team','alice')").run();
  for (const [user, role] of [["alice", "admin"], ["bob", "editor"], ["carol", "viewer"]]) {
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES('team-area',?,?)").run(user, role);
  }
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES('project','team-area','Project')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES('own',?,'Private','Confidential')").run(stage.unassignedAreaId);
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES('child','project','Shared','Initial')").run();
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  });
  const item = { stage, db, authority };
  fixtures.push(item);
  return item;
}
after(() => {
  for (const { db, authority } of fixtures) {
    authority.close();
    db.close();
  }
  if (oldDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR = oldDir;
  assert.equal(readFileSync(path.join(legacy, "keep"), "utf8"), "unchanged");
  rmSync(root, { recursive: true, force: true });
});
function command(db, actor, noteId, title, body, commandId = randomUUID()) {
  const preview = previewTargetNoteWrite(db, actor, noteId);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const { ok: _authorized, ...fields } = preview;
  return { ...fields, noteId, title, body, commandId };
}
const refused = reason => ({ ok: false, reason });

test("signed write session edits notes; audit and receipt contain no note content", () => {
  const { authority, db } = fixture();
  const alice = authority.issueWritable("alice");
  const bob = authority.issueWritable("bob");
  assert.ok(alice && bob);
  const own = command(db, "alice", "own", "Private updated", "Highly confidential body");
  const shared = command(db, "bob", "child", "Project updated", "Updated child content");
  assert.equal(validTargetStagingNoteEditRequest(own), true);
  assert.deepEqual(authority.updateNote(alice.sessionToken, own), { ok: true });
  assert.deepEqual(authority.updateNote(bob.sessionToken, shared), { ok: true });
  assert.deepEqual(db.prepare("SELECT title,body,revision FROM notes WHERE id='child'").get(),
    { title: "Project updated", body: "Updated child content", revision: 1 });
  const audit = db.prepare("SELECT * FROM note_edit_audit ORDER BY id").all();
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map(a => [a.revision_before, a.revision_after]), [[0, 1], [0, 1]]);
  assert.equal(audit[1].area_id, "team-area");
  assert.equal(audit[1].project_id, "project");
  const serialized = JSON.stringify(audit);
  assert.ok(!serialized.includes("confidential"));
  assert.ok(!serialized.includes("Updated child content"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
    .get(TARGET_STAGING_NOTE_RECEIPT_PREFIX + "%").n, 2);
});

test("idempotent replay survives note revision changes; changed payload conflicts", () => {
  const { authority, db } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const first = command(db, "bob", "child", "First edit", "X");
  assert.deepEqual(authority.updateNote(bob.sessionToken, first), { ok: true });
  assert.deepEqual(authority.updateNote(bob.sessionToken, first), { ok: true, replayed: true });
  assert.deepEqual(authority.updateNote(bob.sessionToken, { ...first, body: "Y" }),
    refused("idempotency_conflict"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit").get().n, 1);
  assert.equal(db.prepare("SELECT revision FROM notes WHERE id='child'").get().revision, 1);
  const key = targetNoteEditReceiptKey("bob", "child", first.commandId);
  assert.ok(db.prepare("SELECT value FROM metadata WHERE key=?").get(key));
});

test("viewer, nonmember and read-only tokens cannot edit; no-op and stale preview cannot write", () => {
  const { authority, db } = fixture();
  const bob = authority.issueWritable("bob");
  const carol = authority.issueWritable("carol");
  const read = authority.issue("alice");
  assert.ok(bob && carol && read);
  const request = command(db, "bob", "child", "Different", "Diff");
  assert.deepEqual(authority.updateNote(carol.sessionToken, request), refused("unavailable"));
  assert.deepEqual(authority.updateNote(read.sessionToken, request), refused("unauthorized"));
  assert.deepEqual(authority.updateNote(bob.sessionToken, { ...request, noteId: "own" }),
    refused("unavailable"));
  const noop = command(db, "bob", "child", "Shared", "Initial");
  assert.deepEqual(authority.updateNote(bob.sessionToken, noop), refused("unchanged"));
  assert.deepEqual(authority.updateNote(bob.sessionToken, request), { ok: true });
  const later = { ...request, commandId: randomUUID(), title: "Later" };
  assert.deepEqual(authority.updateNote(bob.sessionToken, later), refused("stale_revision"));
  assert.equal(db.prepare("SELECT revision FROM notes WHERE id='child'").get().revision, 1);
});

test("membership revocation makes even a known successful command unavailable", () => {
  const { authority, db } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const request = command(db, "bob", "child", "Prior edit", "Prior");
  assert.deepEqual(authority.updateNote(bob.sessionToken, request), { ok: true });
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(authority.updateNote(bob.sessionToken, request), refused("unavailable"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit").get().n, 1);
});

test("invalid payload, foreign Area, revoked durable hash and orphan audit fail closed", () => {
  const { authority, db } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const c = command(db, "alice", "own", "Changed", "Secret content");
  for (const wrong of [
    { ...c, body: "x".repeat(131073) }, { ...c, title: "   " },
    { ...c, noteId: ".." }, { ...c, extra: "unexpected" },
  ]) {
    assert.equal(validTargetStagingNoteEditRequest(wrong), false);
    assert.deepEqual(authority.updateNote(alice.sessionToken, wrong), refused("invalid_request"));
  }
  const other = { ...c, writeAreaId: "team-area" };
  assert.deepEqual(authority.updateNote(alice.sessionToken, other), refused("write_area_mismatch"));
  assert.deepEqual(authority.updateNote(alice.sessionToken, c, "a".repeat(64)), refused("session_revoked"));
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='own'").get().body, "Confidential");
  // Even a syntactically valid receipt without an audit invalidates canonical preflight.
  const forged = TARGET_STAGING_NOTE_RECEIPT_PREFIX + "a".repeat(64);
  db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(forged, "b".repeat(64));
  assert.deepEqual(authority.updateNote(alice.sessionToken, c), refused("write_failed"));
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='own'").get().body, "Confidential");
});
