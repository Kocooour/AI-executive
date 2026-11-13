/** R3 backend acceptance: real route handlers, write children and isolated SQLite.
 * No mocked HTTP replies, legacy writes or production feature activation. */
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
const original = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r3-be-note-lifecycle-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "untouched");
Object.assign(process.env, {
  NODE_ENV: "production", AI_EXECUTIVE_DATA_DIR: legacy,
  AI_EXECUTIVE_AUTH_ENABLED: "true",
  AI_EXECUTIVE_PASSWORD_HASH: "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
    ":" + Buffer.alloc(64, 2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET: "r3-backend-lifecycle-isolated-synthetic-secret-long-enough",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED: "true",
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED: "true",
});

const { bootstrapIsolatedTargetStore, TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX } =
  await import("../lib/target-store-bootstrap.ts");
const { TARGET_STAGING_JOURNAL_FILENAME } =
  await import("../lib/target-staging-anchor-journal.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("./support/owner-session-test-cookie.mjs");
const { POST: CREATE } = await import("../app/api/target-staging/notes/route.ts");
const { GET: DETAIL, DELETE: REMOVE } =
  await import("../app/api/target-staging/notes/[noteId]/route.ts");
const { GET: PREVIEW, PATCH: EDIT } =
  await import("../app/api/target-staging/notes/[noteId]/edit/route.ts");

after(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
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
const ownerCookie = () => sessionCookieName + "=" + createSessionToken();
function session(fx, user) {
  const issued = durable.issueDurableTargetStagingSession(fx.store, user, 900);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE + "=" + issued.sessionToken;
}
function createCommand(fx, areaId = fx.stage.unassignedAreaId) {
  return {
    noteId: randomUUID(), commandId: randomUUID(),
    areaId, restoreGeneration: fx.stage.restoreGeneration,
    title: "Original", body: "Private content",
  };
}
const baseUrl = "http://localhost:3001/api/target-staging/notes";
function route(method, noteId, cookie, body) {
  const url = baseUrl + (noteId ? "/" + encodeURIComponent(noteId) : "") +
    (method === "PREVIEW" || method === "PATCH" ? "/edit" : "");
  const verb = method === "PREVIEW" ? "GET" : method;
  const request = new Request(url, {
    method: verb,
    headers: {
      ...(cookie ? { cookie } : {}),
      "x-forwarded-for": "10.9.0.77",
      ...(verb !== "GET" ? {
        origin: "http://localhost:3001", "content-type": "application/json",
        "x-lumi-target-protocol": "1",
      } : {}),
    },
    ...(verb !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
  const context = { params: Promise.resolve({ noteId }) };
  switch (method) {
    case "POST": return CREATE(request);
    case "GET": return DETAIL(request, context);
    case "PREVIEW": return PREVIEW(request, context);
    case "PATCH": return EDIT(request, context);
    case "DELETE": return REMOVE(request, context);
    default: throw new Error("unsupported test route");
  }
}
async function response(promise, expected) {
  const r = await promise;
  const data = await r.json();
  assert.equal(r.status, expected, JSON.stringify(data));
  assert.equal(r.headers.get("cache-control"), "no-store");
  return data;
}
function queryOne(fx, sql, ...params) {
  const db = new DatabaseSync(fx.stage.databasePath, { readOnly: true });
  try { return db.prepare(sql).get(...params); }
  finally { db.close(); }
}

/** Content-free, durable write fingerprint. A rejected or replayed CREATE
 * must not change ANY note row, receipt, audit, journal or anchor. */
function persistenceState(fx, noteId) {
  const db = new DatabaseSync(fx.stage.databasePath, { readOnly: true });
  try {
    const count = (sql, ...args) => db.prepare(sql).get(...args).n;
    return {
      noteExists: db.prepare("SELECT 1 FROM notes WHERE id=?").get(noteId) !== undefined,
      notes: count("SELECT COUNT(*) AS n FROM notes"),
      lifecycleReceipts: count("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",
        TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX + "%"),
      lifecycleAudit: count("SELECT COUNT(*) AS n FROM note_lifecycle_audit"),
      editAudit: count("SELECT COUNT(*) AS n FROM note_edit_audit"),
      deleteAudit: count("SELECT COUNT(*) AS n FROM note_delete_audit"),
      tombstones: count("SELECT COUNT(*) AS n FROM note_tombstones"),
      changeSequence: count("SELECT COALESCE(MAX(seq),0) AS n FROM change_log"),
      anchor: db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value,
      journal: readFileSync(
        path.join(fx.stage.directory, TARGET_STAGING_JOURNAL_FILENAME), "utf8"),
    };
  } finally { db.close(); }
}

test("real R3 route chain: private create → authorized edit → delete/tombstone", async () => {
  const fx = fixture();
  const alice = ownerCookie(), bob = session(fx, "bob");
  const cmd = createCommand(fx);
  assert.deepEqual(await response(route("POST", null, alice, cmd), 201),
    { ok: true, noteId: cmd.noteId });
  const created = persistenceState(fx, cmd.noteId);
  assert.equal(created.noteExists, true);
  assert.equal(created.notes, 1);
  assert.equal(created.lifecycleReceipts, 1);
  assert.equal(created.lifecycleAudit, 1);
  assert.deepEqual(await response(route("POST", null, alice, cmd), 200),
    { ok: true, noteId: cmd.noteId, replayed: true });
  assert.deepEqual(persistenceState(fx, cmd.noteId), created,
    "CREATE replay must not insert duplicate notes, receipts, audit or journal events");
  assert.equal((await response(route("GET", cmd.noteId, alice), 200)).note.body,
    "Private content");
  assert.deepEqual(await response(route("GET", cmd.noteId, bob), 404),
    { error: "Not found" });
  assert.deepEqual(await response(route("PREVIEW", cmd.noteId, bob), 404),
    { error: "Not found" });

  const preview = await response(route("PREVIEW", cmd.noteId, alice), 200);
  assert.deepEqual(Object.keys(preview).sort(),
    ["expectedRevision", "restoreGeneration", "writeAreaId"]);
  assert.equal(preview.writeAreaId, fx.stage.unassignedAreaId);
  const edit = { ...preview, commandId: randomUUID(), title: "Revised", body: "Edited secret" };
  assert.deepEqual(await response(route("PATCH", cmd.noteId, alice, edit), 200),
    { ok: true });
  assert.deepEqual(await response(route("PATCH", cmd.noteId, alice, edit), 200),
    { ok: true, replayed: true });
  const updated = (await response(route("GET", cmd.noteId, alice), 200)).note;
  assert.equal(updated.title, "Revised");
  assert.equal(updated.body, "Edited secret");
  assert.deepEqual(await response(route("PATCH", cmd.noteId, bob, edit), 404),
    { error: "Not found" });

  const latest = await response(route("PREVIEW", cmd.noteId, alice), 200);
  const remove = { ...latest, commandId: randomUUID() };
  assert.deepEqual(await response(route("DELETE", cmd.noteId, alice, remove), 200),
    { ok: true });
  assert.deepEqual(await response(route("DELETE", cmd.noteId, alice, remove), 200),
    { ok: true, replayed: true });
  assert.deepEqual(await response(route("GET", cmd.noteId, alice), 404),
    { error: "Not found" });
  assert.equal(queryOne(fx, "SELECT COUNT(*) AS n FROM notes WHERE id=?", cmd.noteId).n, 0);
  assert.equal(queryOne(fx, "SELECT COUNT(*) AS n FROM note_tombstones WHERE id=?", cmd.noteId).n, 1);
  assert.equal(queryOne(fx, "SELECT COUNT(*) AS n FROM note_edit_audit WHERE note_id=?", cmd.noteId).n, 1);
  assert.equal(queryOne(fx, "SELECT COUNT(*) AS n FROM note_delete_audit WHERE note_id=?", cmd.noteId).n, 1);
  const deleted = persistenceState(fx, cmd.noteId);
  assert.equal(deleted.noteExists, false);
  assert.equal(deleted.notes, 0);
  assert.equal(deleted.lifecycleReceipts, 1);
  assert.equal(deleted.lifecycleAudit, 1);
  assert.equal(deleted.editAudit, 1);
  assert.equal(deleted.deleteAudit, 1);
  assert.equal(deleted.tombstones, 1);
  const resurrect = { ...cmd, commandId: randomUUID(), title: "Resurrection" };
  assert.deepEqual(await response(route("POST", null, alice, resurrect), 404),
    { error: "Not found" });
  assert.deepEqual(persistenceState(fx, cmd.noteId), deleted,
    "CREATE after DELETE must not resurrect a tombstoned ID or write receipts, audit or journal");
});

test("private creator loses access after session revocation, with no additional mutation", async () => {
  const fx = fixture();
  const bob = session(fx, "bob"), alice = ownerCookie();
  const cmd = createCommand(fx, "bob-private");
  assert.equal((await response(route("POST", null, bob, cmd), 201)).noteId, cmd.noteId);
  assert.equal((await response(route("GET", cmd.noteId, bob), 200)).note.body,
    "Private content");
  assert.deepEqual(await response(route("GET", cmd.noteId, alice), 404),
    { error: "Not found" });
  const preview = await response(route("PREVIEW", cmd.noteId, bob), 200);
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live = durable.verifyDurableTargetStagingSessionLive(fx.store, tokenHash);
  assert.equal(live.ok, true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, live.sessionId).ok, true);
  const before = queryOne(fx, "SELECT title,body,revision FROM notes WHERE id=?", cmd.noteId);
  const refusedCreate = createCommand(fx, "bob-private");
  const beforeRefusal = persistenceState(fx, refusedCreate.noteId);
  assert.equal(beforeRefusal.noteExists, false);
  for (const method of ["GET", "PREVIEW", "PATCH"]) {
    const result = await response(route(method, cmd.noteId, bob,
      method === "PATCH" ? { ...preview, commandId: randomUUID(), title: "No", body: "Never" } : undefined), 401);
    assert.equal(result.code, "session_revoked");
  }
  assert.equal((await response(route("POST", null, bob, refusedCreate), 401)).code,
    "session_revoked");
  assert.deepEqual(queryOne(fx, "SELECT title,body,revision FROM notes WHERE id=?", cmd.noteId), before);
  assert.deepEqual(persistenceState(fx, refusedCreate.noteId), beforeRefusal,
    "revoked session must not create any other note, receipt, audit, journal or anchor event");
  assert.equal(queryOne(fx, "SELECT 1 AS present FROM notes WHERE id=?",
    refusedCreate.noteId), undefined);
});
