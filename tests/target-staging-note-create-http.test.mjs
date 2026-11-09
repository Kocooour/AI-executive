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
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-private-note-create-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "untouched");
Object.assign(process.env, {
  NODE_ENV: "production", AI_EXECUTIVE_DATA_DIR: legacy,
  AI_EXECUTIVE_AUTH_ENABLED: "true",
  AI_EXECUTIVE_PASSWORD_HASH: "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
    ":" + Buffer.alloc(64, 2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET: "r3-private-note-create-synthetic-secret-long-enough",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED: "true",
});
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { POST } = await import("../app/api/target-staging/notes/route.ts");
const { GET: GET_NOTE } = await import("../app/api/target-staging/notes/[noteId]/route.ts");
const { parseNoteCreateReply } = await import("../lib/target-staging-note-create-process.ts");

after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "untouched");
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-space','personal','bob')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Private','private','bob-space','bob','unassigned')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Shared','shared','team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','viewer')").run();
  db.close();
  Object.assign(process.env, {
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: "alice",
  });
  return { stage, store: {
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  } };
}
const owner = () => sessionCookieName + "=" + createSessionToken();
function session(fx, actor) {
  const result = durable.issueDurableTargetStagingSession(fx.store, actor, 900);
  assert.equal(result.ok, true, JSON.stringify(result));
  return durable.TARGET_STAGING_SESSION_COOKIE + "=" + result.sessionToken;
}
function body(fx, changes = {}) {
  return {
    noteId: randomUUID(), commandId: randomUUID(),
    areaId: fx.stage.unassignedAreaId,
    restoreGeneration: fx.stage.restoreGeneration,
    title: "Private idea", body: "Some captured text",
    ...changes,
  };
}
function send(data, cookie = owner(), headers = {}, url = "http://localhost:3001/api/target-staging/notes") {
  return POST(new Request(url, { method: "POST", headers: {
    ...(cookie ? { cookie } : {}),
    "origin": "http://localhost:3001",
    "content-type": "application/json",
    "x-lumi-target-protocol": "1",
    "x-forwarded-for": "10.9.0.25",
    ...headers,
  }, body: JSON.stringify(data) }));
}
function getNoteHttp(id, cookie) {
  const request = new Request(
    "http://localhost:3001/api/target-staging/notes/" + encodeURIComponent(id),
    { headers: {
      ...(cookie ? { cookie } : {}), "x-forwarded-for": "10.9.0.25",
    } },
  );
  return GET_NOTE(request, { params: Promise.resolve({ noteId: id }) });
}
function note(fx, id) {
  const db = new DatabaseSync(fx.stage.databasePath, { readOnly: true });
  try {
    return db.prepare("SELECT id,title,body,area_id,project_id FROM notes WHERE id=?").get(id);
  } finally { db.close(); }
}
async function checkedRead(response, status) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return data;
}
async function checked(response, status) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(data).includes("captured text"), false);
  return data;
}

test("owner creates a standalone private note, replay is idempotent and no legacy data changes", async () => {
  const fx = fixture();
  const command = body(fx);
  assert.deepEqual(await checked(await send(command), 201),
    { ok: true, noteId: command.noteId });
  assert.deepEqual({ ...note(fx, command.noteId) }, {
    id: command.noteId, title: command.title, body: command.body,
    area_id: fx.stage.unassignedAreaId, project_id: null,
  });
  const fetched = await checkedRead(await getNoteHttp(command.noteId, owner()), 200);
  assert.deepEqual(fetched.note, {
    id: command.noteId, title: command.title, body: command.body,
    areaId: fx.stage.unassignedAreaId, areaKind: "private",
    projectId: null, revision: 0,
  });
  assert.deepEqual(await checked(await send(command), 200),
    { ok: true, noteId: command.noteId, replayed: true });
  assert.equal((await checked(await send({ ...command, title: "Changed" }), 409)).error, "Revision conflict");
});
test("durable session may create only into its own private Area", async () => {
  const fx = fixture();
  const bob = session(fx, "bob");
  const allowed = body(fx, { areaId: "bob-private" });
  assert.equal((await checked(await send(allowed, bob), 201)).noteId, allowed.noteId);
  assert.equal((await checkedRead(await getNoteHttp(allowed.noteId, bob), 200)).note.id, allowed.noteId);
  assert.equal((await checked(await getNoteHttp(allowed.noteId, owner()), 404)).error, "Not found");
  const cross = body(fx);
  assert.equal((await checked(await send(cross, bob), 404)).error, "Not found");
  assert.equal(note(fx, cross.noteId), undefined);
  const shared = body(fx, { areaId: "team-area" });
  assert.equal((await checked(await send(shared, bob), 404)).error, "Not found");
  assert.equal(note(fx, shared.noteId), undefined);
  const ownerShared = body(fx, { areaId: "team-area" });
  assert.equal((await checked(await send(ownerShared), 404)).error, "Not found");
});
test("missing flag, unbound identity and invalid protocol/shape never write", async () => {
  const fx = fixture();
  const cmd = body(fx);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED = "false";
  assert.equal((await checked(await send(cmd), 404)).error, "Not found");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED = "true";
  assert.equal((await checked(await send(cmd, ""), 401)).error !== undefined, true);
  assert.equal((await checked(await send(cmd, owner(), { "x-lumi-target-protocol": "0" }), 400)).code,
    "protocol_unsupported");
  assert.equal((await checked(await send(cmd, owner(), { origin: "https://elsewhere.invalid" }), 403)).error,
    "Cross-origin request rejected");
  assert.equal((await checked(await send({ ...cmd, projectId: "team-project" }), 400)).error,
    "Invalid request");
  assert.equal((await checked(await send({ ...cmd, workspaceId: "team" }), 400)).error,
    "Invalid request");
  assert.equal((await checked(await send({ ...cmd, entities: [] }), 400)).code,
    "legacy_snapshot_rejected");
  assert.equal((await checked(await send({ ...cmd, noteId: "arbitrary" }), 400)).error,
    "Invalid request");
  assert.equal((await checked(await send({ ...cmd, restoreGeneration: randomUUID() }), 409)).code,
    "resync_required");
  assert.equal(note(fx, cmd.noteId), undefined);
});
test("bounded child result accepts only exact content-free protocol", () => {
  assert.deepEqual(parseNoteCreateReply({ ok: true, replayed: true }), { ok: true, replayed: true });
  assert.deepEqual(parseNoteCreateReply({ ok: false, reason: "resync_required" }),
    { ok: false, reason: "resync_required" });
  for (const invalid of [{ ok: true, noteId: "private" }, { ok: false, reason: "unauthorized" },
    { ok: true, replayed: false }, { ok: false, reason: "write_failed", body: "leak" }]) {
    assert.equal(parseNoteCreateReply(invalid), null);
  }
});
