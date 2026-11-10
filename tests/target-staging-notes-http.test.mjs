import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED", "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED", "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION", "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const old = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2d-note-http-"));
const legacy = path.join(root, "production-sentinel");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "keep"), "untouched");
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
  ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "isolated-r2d-note-http-session-secret-long-enough";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { GET, DELETE: DELETE_NOTE } = await import("../app/api/target-staging/notes/[noteId]/route.ts");
const { GET: EDIT_PREVIEW, PATCH: EDIT } = await import("../app/api/target-staging/notes/[noteId]/edit/route.ts");
const { POST: EDIT_STATUS } = await import("../app/api/target-staging/notes/[noteId]/edit/status/route.ts");
const { POST: EDIT_RECOVERY } = await import("../app/api/target-staging/notes/edit-recovery/route.ts");
const { POST: DELETE_STATUS } = await import("../app/api/target-staging/notes/[noteId]/delete/status/route.ts");
const { readStagingAuthorizedNoteInChild, parseStagingNoteDetail } =
  await import("../lib/target-staging-read-process.ts");
const { verifyStagingNoteBeforeRelease } = await import("../lib/target-staging-http-identity.ts");

after(() => {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(readFileSync(path.join(legacy, "keep"), "utf8"), "untouched");
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const user of ["bob", "carol", "dave"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run("personal-" + user, user);
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
      VALUES (?,'Unassigned','private',?,?,'unassigned')`)
      .run("private-" + user, "personal-" + user, user);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for (const [user, role] of [["alice", "admin"], ["bob", "editor"], ["carol", "viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(user, role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('team-project','team-area','Shared project')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('alice-private',?,'Diary','Private secret')")
    .run(stage.unassignedAreaId);
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('bob-private','private-bob','Secret','Bob confidential')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('shared','team-area','Shared','Shared contents')").run();
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('child','team-project','Child','Inherited contents')").run();
  db.close();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
  return { stage, store: { stagingDirectory: stage.directory,
    expectedRestoreGeneration: stage.restoreGeneration } };
}

const ownerCookie = () => sessionCookieName + "=" + createSessionToken();
function login(fx, user) {
  const created = durable.issueDurableTargetStagingSession(fx.store, user, 900);
  assert.equal(created.ok, true, JSON.stringify(created));
  return durable.TARGET_STAGING_SESSION_COOKIE + "=" + created.sessionToken;
}
function req(noteId, cookie, query = "") {
  return new Request("http://localhost:3001/api/target-staging/notes/" +
    encodeURIComponent(noteId) + query, { headers: {
      ...(cookie ? { cookie } : {}), "x-forwarded-for": "10.9.0.16",
    } });
}
function get(noteId, cookie, query = "") {
  return GET(req(noteId, cookie, query), { params: Promise.resolve({ noteId }) });
}
async function success(promise) {
  const response = await promise;
  const dto = await response.json();
  assert.equal(response.status, 200, JSON.stringify(dto));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(dto), ["note"], "internal ACL proof must never be public");
  assert.deepEqual(Object.keys(dto.note).sort(),
    ["areaId", "areaKind", "body", "id", "projectId", "revision", "title"]);
  return dto.note;
}
async function denied(promise, status) {
  const response = await promise;
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();
  assert.equal(JSON.stringify(data).includes("secret"), false);
  return data;
}

test("read private owner and shared editor/viewer notes, including project inheritance", async () => {
  const fx = fixture();
  const alice = ownerCookie();
  const bob = login(fx, "bob");
  const carol = login(fx, "carol");
  const dave = login(fx, "dave");
  assert.deepEqual(await success(get("alice-private", alice)), {
    id: "alice-private", title: "Diary", body: "Private secret", projectId: null,
    areaId: fx.stage.unassignedAreaId, areaKind: "private", revision: 0,
  });
  for (const cookie of [alice, bob, carol]) {
    const child = await success(get("child", cookie));
    assert.equal(child.body, "Inherited contents");
    assert.equal(child.projectId, "team-project");
    assert.equal(child.areaId, "team-area");
    assert.equal((await success(get("shared", cookie))).body, "Shared contents");
  }
  assert.equal((await success(get("bob-private", bob))).body, "Bob confidential");
  for (const [id, cookie] of [
    ["bob-private", alice], ["alice-private", bob], ["alice-private", carol],
    ["shared", dave], ["child", dave], ["not-found", bob],
  ]) {
    assert.deepEqual(await denied(get(id, cookie), 404), { error: "Not found" });
  }
});

test("durable session revocation, member removal and note edits never disclose stale content", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const child = await readStagingAuthorizedNoteInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice", sessionTokenHash: tokenHash,
  }, "child");
  assert.equal(child?.ok, true, JSON.stringify(child));
  const identity = { kind: "session", tokenHash };
  assert.equal(verifyStagingNoteBeforeRelease(req("child", bob), identity, fx.store,
    "alice", child.linearization, child.guard), "ok");
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE notes SET body='New revision' WHERE id='child'").run();
  assert.equal(verifyStagingNoteBeforeRelease(req("child", bob), identity, fx.store,
    "alice", child.linearization, child.guard), "stale");
  db.prepare("UPDATE notes SET body='Inherited contents' WHERE id='child'").run();
  assert.equal(verifyStagingNoteBeforeRelease(req("child", bob), identity, fx.store,
    "alice", child.linearization, child.guard), "stale", "ABA must stay stale");
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  db.close();
  assert.equal(verifyStagingNoteBeforeRelease(req("child", bob), identity, fx.store,
    "alice", child.linearization, child.guard), "stale");
  assert.deepEqual(await denied(get("child", bob), 404), { error: "Not found" });
  const revoked = durable.revokeDurableTargetStagingSession(fx.store,
    durable.verifyDurableTargetStagingSessionLive(fx.store, tokenHash).sessionId);
  assert.equal(revoked.ok, true);
  const rechecked = await denied(get("child", bob), 401);
  assert.equal(rechecked.code, "session_revoked");
});

test("parent title revision ABA invalidates a previously issued note guard", async () => {
  const fx = fixture();
  const cookie = login(fx, "carol");
  const tokenHash = durable.hashTargetStagingSessionToken(cookie.split("=")[1]);
  const read = await readStagingAuthorizedNoteInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice", sessionTokenHash: tokenHash,
  }, "child");
  assert.equal(read?.ok, true);
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE projects SET title='Other title' WHERE id='team-project'").run();
  db.prepare("UPDATE projects SET title='Shared project' WHERE id='team-project'").run();
  db.close();
  assert.equal(verifyStagingNoteBeforeRelease(req("child", cookie),
    { kind: "session", tokenHash }, fx.store, "alice", read.linearization, read.guard), "stale");
  assert.equal((await success(get("child", cookie))).body, "Inherited contents");
});

test("strict DTO parser rejects extra fields, forged guards, alternate identity and oversized strings", async () => {
  const fx = fixture();
  const read = await readStagingAuthorizedNoteInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice",
  }, "shared");
  assert.equal(read?.ok, true);
  const v = { ...read, ok: true };
  assert.equal(parseStagingNoteDetail(v, "shared")?.ok, true);
  for (const invalid of [
    { ...v, actorUserId: "bob" },
    { ...v, note: { ...v.note, privateMetadata: "do not expose" } },
    { ...v, note: { ...v.note, body: "a".repeat(131073) } },
    { ...v, note: { ...v.note, title: "" } },
    { ...v, note: { ...v.note, id: "other" } },
    { ...v, note: { ...v.note, revision: -1 } },
    { ...v, guard: { ...v.guard, noteRevision: 11 } },
    { ...v, guard: { ...v.guard, projectId: "team-project", parentRevision: 0 } },
    { ...v, guard: { ...v.guard, secret: true } },
    { ...v, linearization: { ...v.linearization, areas: [] } },
  ]) {
    assert.equal(parseStagingNoteDetail(invalid, "shared"), null);
  }
  // A syntactically valid alternate actor is still rejected by the live identity gate.
  const forgedActor = parseStagingNoteDetail({
    ...v, linearization: { ...v.linearization, actorUserId: "bogus" },
  }, "shared");
  assert.equal(verifyStagingNoteBeforeRelease(req("shared", ownerCookie()),
    { kind: "owner" }, fx.store, "alice", forgedActor.linearization, forgedActor.guard), "unavailable");
});

test("bad request IDs, queries, missing identity, disabled gate and invalid store config fail closed", async () => {
  const fx = fixture();
  const alice = ownerCookie();
  for (const id of ["", ".", "..", " x", "x\u0000y", "x".repeat(513)]) {
    assert.deepEqual(await denied(get(id, alice), 400), { error: "Invalid request" });
  }
  for (const query of ["?actorUserId=bob", "?areaId=team-area", "?include=links", "?limit=1"]) {
    assert.deepEqual(await denied(get("shared", alice, query), 400), { error: "Invalid request" });
  }
  assert.deepEqual(await denied(get("shared", null), 401), { error: "Authentication required" });
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED = "false";
  assert.deepEqual(await denied(get("shared", alice), 404), { error: "Not found" });
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED = "true";
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.deepEqual(await denied(get("shared", alice), 404), { error: "Not found" });
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
  const bob = login(fx, "bob");
  // Missing and foreign notes are still indistinguishable on a healthy store.
  assert.deepEqual(await denied(get("absent", alice), 404), { error: "Not found" });
  assert.deepEqual(await denied(get("bob-private", alice), 404), { error: "Not found" });
  assert.deepEqual(await denied(get("alice-private", bob), 404), { error: "Not found" });
  // An unavailable live store is a server failure regardless of cookie type
  // or note existence, and must never return content or a 404.
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = randomUUID();
  for (const cookie of [alice, bob]) {
    for (const noteId of ["shared", "absent"]) {
      assert.deepEqual(await denied(get(noteId, cookie), 503), { error: "Staging unavailable" });
    }
  }
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fx.stage.restoreGeneration;
  assert.equal((await success(get("shared", alice))).title, "Shared");
});

function editContext(noteId) { return { params: Promise.resolve({ noteId }) }; }
function editPreview(noteId, cookie, query = "") {
  return EDIT_PREVIEW(new Request("http://localhost:3001/api/target-staging/notes/" +
    encodeURIComponent(noteId) + "/edit" + query, { headers: {
      ...(cookie ? { cookie } : {}), "x-forwarded-for": "10.9.0.16",
    } }), editContext(noteId));
}
function edit(noteId, cookie, payload, options = {}) {
  return EDIT(new Request("http://localhost:3001/api/target-staging/notes/" +
    encodeURIComponent(noteId) + "/edit" + (options.query || ""), {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(options.protocol === null ? {} : { "x-lumi-target-protocol": options.protocol || "1" }),
      ...(options.origin === null ? {} : { origin: options.origin || "http://localhost:3001" }),
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": "10.9.0.17",
    },
    body: options.raw === undefined ? JSON.stringify(payload) : options.raw,
  }), editContext(noteId));
}
async function authorizedEditPreview(noteId, cookie) {
  const response = await editPreview(noteId, cookie);
  const dto = await response.json();
  assert.equal(response.status, 200, JSON.stringify(dto));
  assert.deepEqual(Object.keys(dto).sort(), ["expectedRevision", "restoreGeneration", "writeAreaId"]);
  assert.match(dto.expectedRevision, /^[a-f0-9]{64}$/);
  return dto;
}

test("note HTTP edit preflight rejects viewers, foreign and missing notes without content", async () => {
  const fx = fixture();
  const alice = ownerCookie();
  const bob = login(fx, "bob");
  const carol = login(fx, "carol");
  const dave = login(fx, "dave");
  assert.equal((await authorizedEditPreview("alice-private", alice)).writeAreaId,
    fx.stage.unassignedAreaId);
  assert.equal((await authorizedEditPreview("child", bob)).writeAreaId, "team-area");
  assert.equal((await authorizedEditPreview("shared", alice)).writeAreaId, "team-area");
  for (const [id, cookie] of [
    ["child", carol], ["shared", carol], ["shared", dave],
    ["alice-private", bob], ["bob-private", alice], ["absent", alice],
  ]) {
    assert.deepEqual(await denied(editPreview(id, cookie), 404), { error: "Not found" });
  }
  assert.deepEqual(await denied(editPreview("shared", null), 401),
    { error: "Authentication required" });
  assert.deepEqual(await denied(editPreview("shared", alice, "?actor=bob"), 400),
    { error: "Invalid request" });
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("DELETE FROM area_members WHERE user_id='bob' AND area_id='team-area'").run();
  db.close();
  assert.deepEqual(await denied(editPreview("child", bob), 404), { error: "Not found" });
});

test("note edit is atomic, auditable and idempotent, including >32 KiB content", async () => {
  const fx = fixture();
  const alice = ownerCookie();
  const preview = await authorizedEditPreview("alice-private", alice);
  const command = { ...preview, commandId: randomUUID(), title: "New title",
    body: "Long content".repeat(3500) };
  assert.deepEqual(await (await edit("alice-private", alice, command)).json(), { ok: true });
  assert.deepEqual(await (await edit("alice-private", alice, command)).json(),
    { ok: true, replayed: true });
  const db = new DatabaseSync(fx.stage.databasePath);
  assert.equal(db.prepare("SELECT title FROM notes WHERE id='alice-private'").get().title, "New title");
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='alice-private'").get().body, command.body);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit WHERE note_id='alice-private'").get().n, 1);
  assert.equal((await edit("alice-private", alice, { ...command, body: "changed" })).status, 409);
  assert.equal((await edit("alice-private", alice, { ...command, commandId: randomUUID() })).status, 409);
  assert.equal((await authorizedEditPreview("alice-private", alice)).writeAreaId,
    fx.stage.unassignedAreaId);
  assert.equal((await success(get("alice-private", alice))).body, command.body);
  db.close();
});

test("shared note editing enforces current Area role, project parent revision and durable session", async () => {
  const fx = fixture();
  const bob = login(fx, "bob"), carol = login(fx, "carol"), dave = login(fx, "dave");
  const preview = await authorizedEditPreview("child", bob);
  const command = { ...preview, title: "Team note", body: "Changed by editor",
    commandId: randomUUID() };
  for (const cookie of [carol, dave]) {
    assert.deepEqual(await denied(edit("child", cookie, command), 404), { error: "Not found" });
  }
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE projects SET title='Temporary' WHERE id='team-project'").run();
  db.prepare("UPDATE projects SET title='Shared project' WHERE id='team-project'").run();
  assert.equal((await edit("child", bob, command)).status, 409, "parent ABA must conflict");
  const fresh = await authorizedEditPreview("child", bob);
  assert.deepEqual(await (await edit("child", bob, { ...command, ...fresh })).json(), { ok: true });
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(await denied(edit("child", bob, { ...command, ...fresh }), 404),
    { error: "Not found" }, "even command replay requires current write access");
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live = durable.verifyDurableTargetStagingSessionLive(fx.store, tokenHash);
  assert.equal(live.ok, true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, live.sessionId).ok, true);
  const revoked = await denied(edit("child", bob, command), 401);
  assert.equal(revoked.code, "session_revoked");
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='child'").get().body, "Changed by editor");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit WHERE note_id='child'").get().n, 1);
  db.close();
});

test("note edit rejects disabled, cross-origin, legacy, bad protocol and malformed commands without mutation", async () => {
  const fx = fixture();
  const alice = ownerCookie();
  const preview = await authorizedEditPreview("alice-private", alice);
  const command = { ...preview, commandId: randomUUID(), title: "Never", body: "Do not write" };
  const db = new DatabaseSync(fx.stage.databasePath);
  const before = db.prepare("SELECT revision FROM notes WHERE id='alice-private'").get().revision;
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "false";
  assert.equal((await editPreview("alice-private", alice)).status, 404);
  assert.equal((await edit("alice-private", alice, command)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "true";
  assert.equal((await edit("alice-private", alice, command, { origin: null })).status, 403);
  assert.equal((await edit("alice-private", alice, command, { origin: "https://other.test" })).status, 403);
  assert.equal((await edit("alice-private", alice, command, { protocol: null })).status, 400);
  assert.equal((await edit("alice-private", alice, { entities: [] })).status, 400);
  assert.equal((await edit("alice-private", alice, { ...command, actorUserId: "alice" })).status, 400);
  assert.equal((await edit("alice-private", alice, { ...command, body: "a".repeat(131073) })).status, 400);
  assert.equal((await edit("alice-private", alice, command, {
    raw: Buffer.alloc(192 * 1024 + 1, 0x20),
  })).status, 413);
  assert.deepEqual(await denied(edit("absent", alice, command), 404), { error: "Not found" });
  assert.equal((await edit("alice-private", alice, { ...command, restoreGeneration: randomUUID() })).status, 409);
  // This staging-only route is intentionally exempt from the *legacy* backup
  // fence, but a mismatched live staging generation must still block writes
  // before accessing the note or dispatching the transactional child.
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = randomUUID();
  assert.deepEqual(await denied(edit("alice-private", alice, command), 503),
    { error: "Staging unavailable" });
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fx.stage.restoreGeneration;
  const wrongArea = await edit("alice-private", alice, { ...command, writeAreaId: "team-area" });
  assert.equal(wrongArea.status, 409, "a writer of both Areas gets a mismatch, not a move");
  assert.equal((await edit("alice-private", alice, { ...command, writeAreaId: "unknown-area" })).status, 404);
  assert.equal((await edit("alice-private", alice, command, {
    raw: Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]),
  })).status, 400);
  assert.equal((await edit("alice-private", alice, { ...command, noteId: "foreign" })).status, 400);
  assert.equal(db.prepare("SELECT revision FROM notes WHERE id='alice-private'").get().revision, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit WHERE note_id='alice-private'").get().n, 0);
  db.close();
});

function status(noteId, cookie, payload, options = {}) {
  return EDIT_STATUS(new Request("http://localhost:3001/api/target-staging/notes/" +
    encodeURIComponent(noteId) + "/edit/status" + (options.query || ""), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.protocol === null ? {} : { "x-lumi-target-protocol": options.protocol || "1" }),
      ...(options.origin === null ? {} : { origin: options.origin || "http://localhost:3001" }),
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": "10.9.0.18",
    },
    body: options.raw === undefined ? JSON.stringify(payload) : options.raw,
  }), editContext(noteId));
}
function recovery(cookie,commandId){
  return EDIT_RECOVERY(new Request("http://localhost:3001/api/target-staging/notes/edit-recovery",{
    method:"POST",headers:{"content-type":"application/json","x-lumi-target-protocol":"1",
      origin:"http://localhost:3001",...(cookie?{cookie}:{}),"x-forwarded-for":"10.9.0.28"},
    body:JSON.stringify({commandId}),
  }));
}

test("content-free recovery proves only a current actor's authorized committed note edit",async()=>{
  const fx=fixture();
  const bob=login(fx,"bob"),carol=login(fx,"carol");
  const preview=await authorizedEditPreview("shared",bob);
  const command={...preview,commandId:randomUUID(),title:"Recovered",body:"Private content"};
  assert.deepEqual(await (await recovery(bob,command.commandId)).json(),{status:"not_recorded"});
  assert.equal((await edit("shared",bob,command)).status,200);
  assert.deepEqual(await (await recovery(bob,command.commandId)).json(),{status:"committed"});
  assert.deepEqual(await (await recovery(ownerCookie(),command.commandId)).json(),{status:"not_recorded"});
  assert.deepEqual(await (await recovery(carol,command.commandId)).json(),{status:"not_recorded"});
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  db.close();
  assert.equal((await recovery(bob,command.commandId)).status,404);
});

test("note command reconciliation distinguishes missing, committed and conflicting receipts without writing", async () => {
  const fx = fixture();
  const alice = ownerCookie();
  const preview = await authorizedEditPreview("alice-private", alice);
  const command = { ...preview, commandId: randomUUID(), title: "Edited", body: "Private status content" };
  const before = await status("alice-private", alice, command);
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { status: "not_recorded" });
  assert.deepEqual(await (await edit("alice-private", alice, command)).json(), { ok: true });
  const committed = await status("alice-private", alice, command);
  assert.equal(committed.status, 200);
  assert.equal(committed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await committed.json(), { status: "committed" });

  const conflict = await status("alice-private", alice, { ...command, body: "Different body" });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "Revision conflict" });
  // Another edit changes today's note CAS; the ORIGINAL durable receipt stays valid.
  const later = { ...(await authorizedEditPreview("alice-private", alice)),
    commandId: randomUUID(), title: "Later", body: "Next" };
  assert.equal((await edit("alice-private", alice, later)).status, 200);
  assert.deepEqual(await (await status("alice-private", alice, command)).json(),
    { status: "committed" });
  const db = new DatabaseSync(fx.stage.databasePath);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_edit_audit").get().n, 2);
  assert.equal(db.prepare("SELECT body FROM notes WHERE id='alice-private'").get().body, "Next");
  db.close();
});

test("note receipt status is isolated by actor, Area, role and durable session", async () => {
  const fx = fixture();
  const bob = login(fx, "bob"), carol = login(fx, "carol"), dave = login(fx, "dave");
  const preview = await authorizedEditPreview("child", bob);
  const command = { ...preview, commandId: randomUUID(),
    title: "Shared editor update", body: "Sensitive value" };
  assert.equal((await edit("child", bob, command)).status, 200);
  // Alice is an admin of the SAME shared note, but Bob's receipt is not hers.
  assert.deepEqual(await (await status("child", ownerCookie(), command)).json(),
    { status: "not_recorded" });
  for (const cookie of [carol, dave]) {
    assert.deepEqual(await denied(status("child", cookie, command), 404), { error: "Not found" });
  }
  assert.deepEqual(await denied(status("alice-private", bob, command), 404),
    { error: "Not found" });
  assert.deepEqual(await denied(status("child", null, command), 401),
    { error: "Authentication required" });
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(await denied(status("child", bob, command), 404), { error: "Not found" });
  db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(await (await status("child", bob, command)).json(), { status: "committed" });
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live = durable.verifyDurableTargetStagingSessionLive(fx.store, tokenHash);
  assert.equal(live.ok, true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, live.sessionId).ok, true);
  assert.equal((await denied(status("child", bob, command), 401)).code, "session_revoked");
  db.close();
});

test("note status rejects malformed, legacy, wrong-origin or disabled requests without mutations", async () => {
  const fx = fixture();
  const alice = ownerCookie();
  const preview = await authorizedEditPreview("alice-private", alice);
  const command = { ...preview, commandId: randomUUID(), title: "Never", body: "Never written" };
  assert.deepEqual(await denied(status("alice-private", alice, command, { origin: null }), 403),
    { error: "Origin header is required" });
  assert.deepEqual(await denied(status("alice-private", alice, command, { origin: "https://other.test" }), 403),
    { error: "Cross-origin request rejected" });
  assert.equal((await status("alice-private", alice, command, { protocol: null })).status, 400);
  assert.equal((await status("alice-private", alice, { entities: [] })).status, 400);
  assert.equal((await status("alice-private", alice, { ...command, actorUserId: "alice" })).status, 400);
  assert.equal((await status("alice-private", alice, { ...command, noteId: "other" })).status, 400);
  assert.equal((await status("alice-private", alice, command, { query: "?actor=alice" })).status, 400);
  assert.equal((await status("alice-private", alice, { ...command, body: "x".repeat(131073) })).status, 400);
  assert.equal((await status("alice-private", alice, command, { raw: Buffer.alloc(192 * 1024 + 1, 0x20) })).status, 413);
  assert.deepEqual(await denied(status("absent", alice, command), 404), { error: "Not found" });
  assert.equal((await status("alice-private", alice, { ...command, restoreGeneration: randomUUID() })).status, 409);
  assert.equal((await status("alice-private", alice, { ...command, writeAreaId: "team-area" })).status, 409);
  assert.equal((await status("alice-private", alice, { ...command, writeAreaId: "foreign" })).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "false";
  assert.equal((await status("alice-private", alice, command)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "true";
  const db = new DatabaseSync(fx.stage.databasePath);
  assert.equal(db.prepare("SELECT revision FROM notes WHERE id='alice-private'").get().revision, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_edit_audit").get().n, 0);
  db.close();
});


function deleteNote(noteId, cookie, command, options = {}) {
  return DELETE_NOTE(new Request("http://localhost:3001/api/target-staging/notes/" +
    encodeURIComponent(noteId) + (options.query || ""), {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      ...(options.protocol === null ? {} : { "x-lumi-target-protocol": options.protocol || "1" }),
      ...(options.origin === null ? {} : { origin: options.origin || "http://localhost:3001" }),
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": "10.9.0.19",
    },
    body: options.raw === undefined ? JSON.stringify(command) : options.raw,
  }), editContext(noteId));
}
const deleteCommand = (preview) => ({ ...preview, commandId: randomUUID() });

test("note HTTP DELETE permanently tombstones with exact actor replay and one audit", async () => {
  const fx = fixture(), alice = ownerCookie(), bob = login(fx, "bob");
  const command = deleteCommand(await authorizedEditPreview("alice-private", alice));
  const first = await deleteNote("alice-private", alice, command);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), { ok: true });
  assert.deepEqual(await (await deleteNote("alice-private", alice, command)).json(),
    { ok: true, replayed: true });
  assert.deepEqual(await denied(get("alice-private", alice), 404), { error: "Not found" });
  assert.deepEqual(await denied(deleteNote("alice-private", bob, command), 404),
    { error: "Not found" });
  assert.deepEqual(await denied(deleteNote("alice-private", alice,
    { ...command, expectedRevision: "a".repeat(64) }), 409), { error: "Revision conflict" });
  const db = new DatabaseSync(fx.stage.databasePath);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notes WHERE id='alice-private'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_delete_audit WHERE note_id='alice-private'").get().n, 1);
  const tomb = db.prepare("SELECT area_id,revision FROM note_tombstones WHERE id='alice-private'").get();
  assert.equal(tomb.area_id, fx.stage.unassignedAreaId);
  assert.equal(tomb.revision, 1);
  assert.throws(() => db.prepare(
    "INSERT INTO notes(id,area_id,title,body) VALUES ('alice-private',?,'Resurrect','Secret')"
  ).run(fx.stage.unassignedAreaId));
  db.close();
});

test("note HTTP DELETE enforces inherited Area edit role, CAS, parent ABA and revocation", async () => {
  const fx = fixture();
  const bob = login(fx, "bob"), carol = login(fx, "carol"), dave = login(fx, "dave");
  const command = deleteCommand(await authorizedEditPreview("child", bob));
  for (const cookie of [carol, dave]) {
    assert.deepEqual(await denied(deleteNote("child", cookie, command), 404),
      { error: "Not found" });
  }
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE projects SET title='Changed' WHERE id='team-project'").run();
  db.prepare("UPDATE projects SET title='Shared project' WHERE id='team-project'").run();
  assert.equal((await deleteNote("child", bob, command)).status, 409, "parent ABA must fail CAS");
  const fresh = deleteCommand(await authorizedEditPreview("child", bob));
  assert.deepEqual(await (await deleteNote("child", bob, fresh)).json(), { ok: true });
  assert.deepEqual(await (await deleteNote("child", bob, fresh)).json(),
    { ok: true, replayed: true });
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(await denied(deleteNote("child", bob, fresh), 404), { error: "Not found" });
  db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live = durable.verifyDurableTargetStagingSessionLive(fx.store, tokenHash);
  assert.equal(live.ok, true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, live.sessionId).ok, true);
  assert.equal((await denied(deleteNote("child", bob, fresh), 401)).code, "session_revoked");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_delete_audit WHERE note_id='child'").get().n, 1);
  assert.equal(db.prepare("SELECT project_id FROM note_tombstones WHERE id='child'").get().project_id,
    "team-project");
  db.close();
});

test("note HTTP DELETE rejects malformed/legacy/cross-origin/disabled requests without mutation", async () => {
  const fx = fixture(), alice = ownerCookie();
  const command = deleteCommand(await authorizedEditPreview("alice-private", alice));
  for (const options of [{ origin: null }, { origin: "https://other.test" }])
    assert.equal((await deleteNote("alice-private", alice, command, options)).status, 403);
  assert.equal((await deleteNote("alice-private", alice, command, { protocol: null })).status, 400);
  assert.equal((await deleteNote("alice-private", alice, { entities: [] })).status, 400);
  assert.equal((await deleteNote("alice-private", alice, { ...command, actorUserId: "alice" })).status, 400);
  assert.equal((await deleteNote("alice-private", alice, { ...command, noteId: "other" })).status, 400);
  assert.equal((await deleteNote("alice-private", alice, command, { query: "?actor=bob" })).status, 400);
  assert.equal((await deleteNote("alice-private", alice, command, {
    raw: Buffer.alloc(16 * 1024 + 1, 0x20),
  })).status, 413);
  assert.equal((await deleteNote("alice-private", alice, command, {
    raw: Buffer.from([0xc3, 0x28]),
  })).status, 400);
  assert.equal((await deleteNote("alice-private", alice, command, { raw: "{" })).status, 400);
  assert.deepEqual(await denied(deleteNote("bad note id ", alice, command), 400),
    { error: "Invalid request" });
  assert.deepEqual(await denied(deleteNote("absent", alice, command), 404), { error: "Not found" });
  assert.deepEqual(await denied(deleteNote("bob-private", alice, command), 404), { error: "Not found" });
  assert.equal((await deleteNote("alice-private", alice, { ...command, restoreGeneration: randomUUID() })).status, 409);
  assert.equal((await deleteNote("alice-private", alice, { ...command, writeAreaId: "team-area" })).status, 409);
  assert.equal((await deleteNote("alice-private", alice, { ...command, writeAreaId: "private-bob" })).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "false";
  assert.equal((await deleteNote("alice-private", alice, command)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "true";
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = randomUUID();
  assert.deepEqual(await denied(deleteNote("alice-private", alice, command), 503),
    { error: "Staging unavailable" });
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fx.stage.restoreGeneration;
  const db = new DatabaseSync(fx.stage.databasePath);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notes WHERE id='alice-private'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_delete_audit").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_tombstones").get().n, 0);
  db.close();
});


test("revoked durable session cannot delete a live note or leave a tombstone", async () => {
  const fx = fixture(), bob = login(fx, "bob");
  const command = deleteCommand(await authorizedEditPreview("shared", bob));
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live = durable.verifyDurableTargetStagingSessionLive(fx.store, tokenHash);
  assert.equal(live.ok, true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, live.sessionId).ok, true);
  assert.equal((await denied(deleteNote("shared", bob, command), 401)).code, "session_revoked");
  const db = new DatabaseSync(fx.stage.databasePath);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notes WHERE id='shared'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_tombstones WHERE id='shared'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM note_delete_audit").get().n, 0);
  db.close();
});

function deleteStatus(noteId, cookie, command, options = {}) {
  return DELETE_STATUS(new Request("http://localhost:3001/api/target-staging/notes/" +
    encodeURIComponent(noteId) + "/delete/status" + (options.query || ""), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.protocol === null ? {} : { "x-lumi-target-protocol": options.protocol || "1" }),
      ...(options.origin === null ? {} : { origin: options.origin || "http://localhost:3001" }),
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": "10.9.0.20",
    },
    body: options.raw === undefined ? JSON.stringify(command) : options.raw,
  }), editContext(noteId));
}

test("note delete status is read-only: before, after commit, replay and changed digest", async () => {
  const fx = fixture(), alice = ownerCookie();
  const command = deleteCommand(await authorizedEditPreview("alice-private", alice));
  const before = await deleteStatus("alice-private", alice, command);
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { status: "not_recorded" });
  assert.deepEqual(await (await deleteNote("alice-private", alice, command)).json(), { ok: true });
  const afterDelete = await deleteStatus("alice-private", alice, command);
  assert.equal(afterDelete.status, 200);
  assert.equal(afterDelete.headers.get("cache-control"), "no-store");
  assert.deepEqual(await afterDelete.json(), { status: "committed" });
  assert.deepEqual(await (await deleteStatus("alice-private", alice, command)).json(),
    { status: "committed" });
  assert.deepEqual(await denied(deleteStatus("alice-private", alice,
    { ...command, expectedRevision: "b".repeat(64) }), 409), { error: "Revision conflict" });
  assert.deepEqual(await denied(deleteStatus("alice-private", alice,
    { ...command, commandId: randomUUID() }), 404), { error: "Not found" });
  assert.deepEqual(await denied(deleteStatus("absent", alice, command), 404), { error: "Not found" });
  const db = new DatabaseSync(fx.stage.databasePath);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_tombstones").get().n, 1);
  db.close();
});

test("note delete status is actor scoped and requires live Area role and session", async () => {
  const fx = fixture();
  const bob = login(fx, "bob"), carol = login(fx, "carol"), dave = login(fx, "dave");
  const command = deleteCommand(await authorizedEditPreview("child", bob));
  assert.deepEqual(await (await deleteStatus("child", bob, command)).json(),
    { status: "not_recorded" });
  assert.equal((await deleteNote("child", bob, command)).status, 200);
  assert.deepEqual(await (await deleteStatus("child", bob, command)).json(),
    { status: "committed" });
  // Admin can write the same Area, but cannot inspect another actor's receipt.
  for (const cookie of [ownerCookie(), carol, dave]) {
    assert.deepEqual(await denied(deleteStatus("child", cookie, command), 404),
      { error: "Not found" });
  }
  assert.deepEqual(await denied(deleteStatus("child", null, command), 401),
    { error: "Authentication required" });
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(await denied(deleteStatus("child", bob, command), 404),
    { error: "Not found" });
  db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(await (await deleteStatus("child", bob, command)).json(),
    { status: "committed" });
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live = durable.verifyDurableTargetStagingSessionLive(fx.store, tokenHash);
  assert.equal(live.ok, true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, live.sessionId).ok, true);
  assert.equal((await denied(deleteStatus("child", bob, command), 401)).code,
    "session_revoked");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit").get().n, 1);
  db.close();
});

test("note delete status fails closed on bad origin, protocol, legacy body, flags and restore", async () => {
  const fx = fixture(), alice = ownerCookie();
  const command = deleteCommand(await authorizedEditPreview("alice-private", alice));
  for (const opts of [{ origin: null }, { origin: "https://other.test" }])
    assert.equal((await deleteStatus("alice-private", alice, command, opts)).status, 403);
  assert.equal((await deleteStatus("alice-private", alice, command, { protocol: null })).status, 400);
  assert.equal((await deleteStatus("alice-private", alice, { entities: [] })).status, 400);
  assert.equal((await deleteStatus("alice-private", alice, { ...command, actorUserId: "alice" })).status, 400);
  assert.equal((await deleteStatus("alice-private", alice, { ...command, noteId: "other" })).status, 400);
  assert.equal((await deleteStatus("alice-private", alice, command, { query: "?area=team-area" })).status, 400);
  assert.equal((await deleteStatus("alice-private", alice, command, { raw: Buffer.alloc(16 * 1024 + 1, 0x20) })).status, 413);
  assert.equal((await deleteStatus("alice-private", alice, command, { raw: Buffer.from([0xc3, 0x28]) })).status, 400);
  assert.equal((await deleteStatus("alice-private", alice, command, { raw: "{" })).status, 400);
  assert.deepEqual(await denied(deleteStatus("alice-private", alice,
    { ...command, restoreGeneration: randomUUID() }), 409),
    { error: "Resync required", code: "resync_required" });
  assert.equal((await deleteStatus("alice-private", alice,
    { ...command, writeAreaId: "team-area" })).status, 409);
  assert.equal((await deleteStatus("alice-private", alice,
    { ...command, writeAreaId: "private-bob" })).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "false";
  assert.equal((await deleteStatus("alice-private", alice, command)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = "true";
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = randomUUID();
  assert.equal((await deleteStatus("alice-private", alice, command)).status, 503);
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fx.stage.restoreGeneration;
  const db = new DatabaseSync(fx.stage.databasePath);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM note_tombstones").get().n, 0);
  db.close();
});
