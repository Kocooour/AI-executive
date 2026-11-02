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
const { validTargetStagingNoteDeleteRequest, targetNoteDeleteReceiptKey } =
  await import("../lib/target-note-delete-writer.ts");
const { inspectIsolatedTargetStore } =
  await import("../lib/target-store-preflight.ts");
const { hashTargetStagingSessionToken, issueDurableTargetStagingSession,
  revokeDurableTargetStagingSession } =
  await import("../lib/target-staging-durable-session.ts");

const fixtures = [];
function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const id of ["bob", "carol"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(id);
    // Canonical staging requires a personal workspace and Unassigned Area for EVERY identity.
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(`personal-${id}`, id);
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
      VALUES (?,'Unassigned','private',?,?,'unassigned')`)
      .run(`unassigned-${id}`, `personal-${id}`, id);
  }
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
  assert.deepEqual({ ...db.prepare("SELECT title,body,revision FROM notes WHERE id='child'").get() },
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
  const changes = db.prepare("SELECT seq,kind,note_id,area_id,project_id,revision FROM note_change_journal ORDER BY seq").all();
  assert.deepEqual(changes.map(x => [x.seq,x.kind,x.note_id,x.revision]), [
    [1,"edit","own",1], [2,"edit","child",1],
  ]);
  assert.equal(changes[1].area_id,"team-area");
  assert.equal(changes[1].project_id,"project");
  assert.equal(JSON.stringify(changes).includes("Highly confidential body"),false);
});

test("idempotent replay survives note revision changes; changed payload conflicts", () => {
  const { authority, db } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const first = command(db, "bob", "child", "First edit", "X");
  assert.deepEqual(authority.updateNote(bob.sessionToken, first), { ok: true });
  assert.deepEqual(authority.updateNote(bob.sessionToken, first), { ok: true, replayed: true });
  const second = command(db, "bob", "child", "Second edit", "Z");
  assert.deepEqual(authority.updateNote(bob.sessionToken, second), { ok: true });
  // A retry acknowledges the original command even after another edit,
  // but it must not overwrite the later content or insert another audit.
  assert.deepEqual(authority.updateNote(bob.sessionToken, first), { ok: true, replayed: true });
  assert.deepEqual(authority.updateNote(bob.sessionToken, { ...first, body: "Y" }),
    refused("idempotency_conflict"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_change_journal").get().n, 2,
    "idempotent replay must not append a new event");
  assert.equal(db.prepare("SELECT revision FROM notes WHERE id='child'").get().revision, 2);
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='child'").get().body, "Z");
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

test("live durable session binds actor to note writes and revocation blocks retries and fresh edits", () => {
  const { authority, db, stage } = fixture();
  const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const durable = issueDurableTargetStagingSession(store, "bob");
  const foreign = issueDurableTargetStagingSession(store, "alice");
  assert.equal(durable.ok, true, JSON.stringify(durable));
  assert.equal(foreign.ok, true, JSON.stringify(foreign));
  const request = command(db, "bob", "child", "Durable edit", "Before revocation");
  assert.deepEqual(authority.updateNote(bob.sessionToken, request,
    hashTargetStagingSessionToken(foreign.sessionToken)), refused("session_revoked"));
  assert.equal(db.prepare("SELECT revision FROM notes WHERE id='child'").get().revision, 0);
  const tokenHash = hashTargetStagingSessionToken(durable.sessionToken);
  assert.deepEqual(authority.updateNote(bob.sessionToken, request, tokenHash), { ok: true });
  const next = command(db, "bob", "child", "Forbidden later edit", "After revocation");
  assert.deepEqual(revokeDurableTargetStagingSession(store, durable.sessionId),
    { ok: true, changed: true });
  assert.deepEqual(authority.updateNote(bob.sessionToken, request, tokenHash),
    refused("session_revoked"), "even previously committed retries need a live session");
  assert.deepEqual(authority.updateNote(bob.sessionToken, next, tokenHash),
    refused("session_revoked"), "revoked durable session cannot write new content");
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='child'").get().body, "Before revocation");
  assert.equal(db.prepare("SELECT revision FROM notes WHERE id='child'").get().revision, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit").get().n, 1);
});

test("invalid payload, foreign Area, unknown durable hash and orphan audit fail closed", () => {
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
  // The pinned-store security gate denies access before the note writer is entered.
  const forged = TARGET_STAGING_NOTE_RECEIPT_PREFIX + "a".repeat(64);
  db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(forged, "b".repeat(64));
  assert.deepEqual(authority.updateNote(alice.sessionToken, c), refused("unauthorized"));
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='own'").get().body, "Confidential");
});

function deleteCommand(db, actor, noteId, commandId = randomUUID()) {
  const preview = previewTargetNoteWrite(db, actor, noteId);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const { ok: _authorized, ...fields } = preview;
  return { ...fields, noteId, commandId };
}

test("signed note deletion is atomic and content-free: private + inherited shared Area", () => {
  const { stage, db, authority } = fixture();
  const alice = authority.issueWritable("alice");
  const bob = authority.issueWritable("bob");
  assert.ok(alice && bob);
  const own = deleteCommand(db, "alice", "own");
  const child = deleteCommand(db, "bob", "child");
  assert.equal(validTargetStagingNoteDeleteRequest(own), true);
  assert.deepEqual(authority.deleteNote(alice.sessionToken, own), { ok: true });
  assert.deepEqual(authority.deleteNote(bob.sessionToken, child), { ok: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0);
  assert.deepEqual(db.prepare("SELECT note_id,project_id,area_id,revision_before,tombstone_revision FROM note_delete_audit ORDER BY id").all()
    .map(x => ({ ...x })), [
    { note_id: "own", project_id: null, area_id: stage.unassignedAreaId, revision_before: 0, tombstone_revision: 1 },
    { note_id: "child", project_id: "project", area_id: "team-area", revision_before: 0, tombstone_revision: 1 },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_tombstones").get().n, 2);
  assert.deepEqual(db.prepare("SELECT seq,kind,note_id,area_id,revision FROM note_change_journal ORDER BY seq").all()
    .map(e => [e.seq,e.kind,e.note_id,e.revision]), [
      [1,"delete","own",1], [2,"delete","child",1],
    ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_change_journal WHERE kind='delete'").get().n, 2);

  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.deepEqual(inspectIsolatedTargetStore({ stagingDirectory: stage.directory }),
    { ok: true, mode: "stage", issues: [] });
  const serialized = JSON.stringify(db.prepare("SELECT * FROM note_delete_audit").all()) +
    readFileSync(path.join(stage.directory, "lumi-target.journal"), "utf8");
  assert.ok(!serialized.includes("Confidential") && !serialized.includes("Initial"));
  assert.ok(serialized.includes("note_delete"), "delete recorded in irreversible journal");
  assert.throws(() => db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES('child','project','Return','Secret')").run());
});

test("note deletion replay is actor-scoped, exact-request and requires current Area access", () => {
  const { db, authority } = fixture();
  const bob = authority.issueWritable("bob"), alice = authority.issueWritable("alice");
  const carol = authority.issueWritable("carol");
  assert.ok(bob && alice && carol);
  const request = deleteCommand(db, "bob", "child");
  assert.deepEqual(authority.deleteNote(bob.sessionToken, request), { ok: true });
  assert.deepEqual(authority.deleteNote(bob.sessionToken, request), { ok: true, replayed: true });
  assert.deepEqual(authority.deleteNote(bob.sessionToken, { ...request, expectedRevision: "f".repeat(64) }),
    refused("idempotency_conflict"));
  assert.deepEqual(authority.deleteNote(bob.sessionToken, { ...request, commandId: randomUUID() }),
    refused("unavailable"));
  assert.deepEqual(authority.deleteNote(carol.sessionToken, request), refused("unavailable"));
  assert.deepEqual(authority.deleteNote(alice.sessionToken, request), refused("unavailable"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit").get().n, 1);
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(authority.deleteNote(bob.sessionToken, request), refused("unavailable"));
});

test("note deletion denies viewer, foreign private note, stale revisions and malformed commands", () => {
  const { db, authority } = fixture();
  const bob = authority.issueWritable("bob");
  const carol = authority.issueWritable("carol");
  const alice = authority.issueWritable("alice");
  assert.ok(bob && carol && alice);
  const stale = deleteCommand(db, "bob", "child");
  assert.deepEqual(authority.deleteNote(carol.sessionToken, stale), refused("unavailable"));
  assert.deepEqual(authority.deleteNote(bob.sessionToken, {
    ...stale, writeAreaId: "unassigned-bob",
  }), refused("write_area_mismatch"));
  assert.deepEqual(authority.deleteNote(bob.sessionToken, { ...stale, commandId: "invalid" }),
    refused("invalid_request"));
  assert.deepEqual(authority.deleteNote(bob.sessionToken, { ...stale, extraneous: true }),
    refused("invalid_request"));
  assert.deepEqual(authority.deleteNote(bob.sessionToken, {
    ...stale, restoreGeneration: randomUUID(),
  }), refused("resync_required"));
  db.prepare("UPDATE notes SET body='Mutation' WHERE id='child'").run();
  assert.deepEqual(authority.deleteNote(bob.sessionToken, stale), refused("stale_revision"));
  const privateRequest = deleteCommand(db, "alice", "own");
  assert.deepEqual(authority.deleteNote(bob.sessionToken, privateRequest), refused("unavailable"));
  assert.deepEqual(authority.deleteNote(alice.sessionToken, privateRequest), { ok: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit").get().n, 1);
});

test("durable note deletion session is tied to actor and blocks revoked credentials", () => {
  const { stage, db, authority } = fixture();
  const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const own = deleteCommand(db, "alice", "own");
  const session = issueDurableTargetStagingSession(store, "alice");
  const other = issueDurableTargetStagingSession(store, "bob");
  assert.equal(session.ok, true); assert.equal(other.ok, true);
  const otherHash = hashTargetStagingSessionToken(other.sessionToken);
  assert.deepEqual(authority.deleteNote(alice.sessionToken, own, otherHash), refused("session_revoked"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_tombstones").get().n, 0);
  const hash = hashTargetStagingSessionToken(session.sessionToken);
  assert.deepEqual(authority.deleteNote(alice.sessionToken, own, hash), { ok: true });
  assert.equal(revokeDurableTargetStagingSession(store, session.sessionId).ok, true);
  assert.deepEqual(authority.deleteNote(alice.sessionToken, own, hash), refused("session_revoked"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit").get().n, 1);
});

test("forged orphan note deletion receipts/audit fail canonical preflight before mutation", () => {
  const { stage, db, authority } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const req = deleteCommand(db, "alice", "own");
  const key = targetNoteDeleteReceiptKey("alice", req.noteId, req.commandId);
  db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(key, "a".repeat(64));
  const check = inspectIsolatedTargetStore({ stagingDirectory: stage.directory });
  assert.equal(check.ok, false);
  assert.ok(check.issues.includes("audit_invalid"), JSON.stringify(check));
  assert.notDeepEqual(authority.deleteNote(alice.sessionToken, req), { ok: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id='own'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_tombstones").get().n, 0);
});

test("note deletion preserves previous edit audit and prevents second delete audit for same note", () => {
  const { stage, db, authority } = fixture();
  const alice = authority.issueWritable("alice");
  assert.ok(alice);
  const edit = command(db, "alice", "own", "Revised", "Private text after edit");
  assert.deepEqual(authority.updateNote(alice.sessionToken, edit), { ok: true });
  const deletion = deleteCommand(db, "alice", "own");
  assert.deepEqual(authority.deleteNote(alice.sessionToken, deletion), { ok: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit WHERE note_id='own'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit WHERE note_id='own'").get().n, 1);
  assert.throws(() => db.prepare(`INSERT INTO note_delete_audit (
    receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
    revision_before,tombstone_revision,expected_revision,restore_generation,committed_at_ms
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    "r2:note-delete-receipt-v1:" + "f".repeat(64), "alice", "own", null,
    stage.unassignedAreaId, 0, 1, 2, "d".repeat(64), stage.restoreGeneration, Date.now(),
  ));
  assert.throws(() => db.prepare("UPDATE note_delete_audit SET policy_revision=5").run());
  assert.deepEqual(inspectIsolatedTargetStore({ stagingDirectory: stage.directory }),
    { ok: true, mode: "stage", issues: [] });
});

test("note delete requires unchanged parent project revision, not just note revision", () => {
  const { db, authority } = fixture();
  const bob = authority.issueWritable("bob");
  assert.ok(bob);
  const request = deleteCommand(db, "bob", "child");
  db.prepare("UPDATE projects SET title='Changed' WHERE id='project'").run();
  db.prepare("UPDATE projects SET title='Project' WHERE id='project'").run();
  assert.deepEqual(authority.deleteNote(bob.sessionToken, request), refused("stale_revision"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_tombstones").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit").get().n, 0);
});
