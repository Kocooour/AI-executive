import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2-http-title-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
const old = Object.fromEntries([
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
].map(key => [key, process.env[key]]));
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" +
  Buffer.alloc(16, 1).toString("base64url") + ":" +
  Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-http-title-session-secret-20261028";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";
const { writeFields } = await import("./support/target-write-contract.mjs");
const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { GET, PATCH } = await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const { POST: STATUS } = await import("../app/api/target-staging/tasks/[taskId]/title/status/route.ts");

const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
const db = new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys=ON");
db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob','private','bob-personal','bob','unassigned')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
// R2-ID.3: alice is only a VIEWER here, so it stays read-only for her (shared writes: target-staging-shared-title.test.mjs).
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('ro','shared','bob')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('ro-area','Read only','shared','ro','bob')").run();
db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('ro-area','bob','admin')").run();
db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('ro-area','alice','viewer')").run();
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('viewer-task','ro-area','Viewer')").run();
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('private-task',?,'Original')").run(stage.unassignedAreaId);
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('foreign-task','bob-private','Foreign')").run();
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('shared-task','team-area','Shared')").run();
const cookie = sessionCookieName + "=" + createSessionToken();
const base = "http://localhost:3001/api/target-staging/tasks/";
const context = taskId => ({ params: Promise.resolve({ taskId }) });
const get = (taskId, suffix = "", auth = cookie) =>
  GET(new Request(base + taskId + "/title" + suffix, {
    headers: auth ? { cookie: auth } : {},
  }), context(taskId));
const patch = (taskId, payload, options = {}) =>
  PATCH(new Request(base + taskId + "/title" + (options.query || ""), {
    method: "PATCH",
    headers: {
      "content-type": "application/json", "x-lumi-target-protocol": "1",
      ...(options.origin === null ? {} : { origin: options.origin || "http://localhost:3001" }),
      ...(options.auth === null ? {} : { cookie: options.auth || cookie }),
    },
    body: JSON.stringify({ ...writeFields(db, taskId, stage.restoreGeneration), ...payload }),
  }), context(taskId));
const patchRaw = (taskId, bytes) =>
  PATCH(new Request(base + taskId + "/title", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-lumi-target-protocol": "1", origin: "http://localhost:3001", cookie },
    body: bytes,
  }), context(taskId));
const status = (taskId, payload, options = {}) =>
  STATUS(new Request(base + taskId + "/title/status" + (options.query || ""), {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-lumi-target-protocol": "1",
      ...(options.origin === null ? {} : { origin: options.origin || "http://localhost:3001" }),
      ...(options.auth === null ? {} : { cookie: options.auth || cookie }),
    },
    body: JSON.stringify({ ...writeFields(db, taskId, stage.restoreGeneration), ...payload }),
  }), context(taskId));
const statusRaw = (taskId, bytes) =>
  STATUS(new Request(base + taskId + "/title/status", {
    method: "POST",
    headers: { "content-type": "application/json", "x-lumi-target-protocol": "1", origin: "http://localhost:3001", cookie },
    body: bytes,
  }), context(taskId));
const command = (title, expectedRevision, commandId = randomUUID()) =>
  ({ commandId, title, expectedRevision });

after(() => {
  db.close();
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("owner-private HTTP preflight, write, receipt replay and audit exactly once", async () => {
  const preview = await get("private-task");
  assert.equal(preview.status, 200);
  const { snapshotRevision } = await preview.json();
  assert.match(snapshotRevision, /^[a-f0-9]{64}$/);
  const input = command("Edited", snapshotRevision);
  const saved = await patch("private-task", input);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true });
  const replay = await patch("private-task", input);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, replayed: true });
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id='private-task'").get().title, "Edited");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_title_audit WHERE task_id='private-task'").get().n, 1);
  assert.equal((await patch("private-task", { ...input, title: "Different" })).status, 409);
  assert.equal((await patch("private-task", command("Stale", snapshotRevision))).status, 409);
  assert.equal((await get("private-task", "?expectedRevision=" + snapshotRevision)).status, 409);
});

test("read-only shared, foreign and unknown task probes and writes are indistinguishable", async () => {
  for (const id of ["viewer-task", "foreign-task", "missing-task"]) {
    assert.equal((await get(id)).status, 404);
    assert.equal((await patch(id, command("No", "a".repeat(64)))).status, 404);
  }
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id='viewer-task'").get().title, "Viewer");
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id='foreign-task'").get().title, "Foreign");
});

test("valid long UTF-8 and escaped titles pass the HTTP and child byte limits", async () => {
  let rev = (await (await get("private-task")).json()).snapshotRevision;
  for (const title of ["č".repeat(3000), "\u0001".repeat(4096)]) {
    const saved = await patch("private-task", command(title, rev));
    assert.equal(saved.status, 200);
    assert.equal(db.prepare("SELECT title FROM tasks WHERE id='private-task'").get().title, title);
    rev = (await (await get("private-task")).json()).snapshotRevision;
  }
});

test("malformed UTF-8 JSON is rejected before mutation", async () => {
  const before = db.prepare("SELECT title FROM tasks WHERE id='private-task'").get().title;
  const payload = Buffer.from(JSON.stringify(command("A", "a".repeat(64))));
  payload[payload.indexOf(Buffer.from("A"))] = 0xc3;
  const response = await patchRaw("private-task", payload);
  assert.equal(response.status, 400);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id='private-task'").get().title, before);
});

test("disabled, auth, Origin and input gates refuse mutation", async () => {
  const current = (await get("private-task")).status;
  assert.equal(current, 200);
  const rev = (await (await get("private-task")).json()).snapshotRevision;
  const input = command("Never", rev);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "false";
  assert.equal((await get("private-task")).status, 404);
  assert.equal((await patch("private-task", input)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";
  assert.equal((await patch("private-task", input, { auth: null })).status, 401);
  assert.equal((await patch("private-task", input, { origin: null })).status, 403);
  assert.equal((await patch("private-task", input, { origin: "https://evil.example" })).status, 403);
  assert.equal((await patch("private-task", { ...input, actorUserId: "alice" })).status, 400);
  assert.equal((await patch("private-task", { ...input, areaId: stage.unassignedAreaId })).status, 400);
  assert.equal((await patch("private-task", { ...input, scope: "personal" })).status, 400);
  assert.equal((await patch("private-task", { ...input, title: "x".repeat(7000) })).status, 400);
  assert.equal((await patchRaw("private-task", Buffer.alloc(32 * 1024 + 1, 0x20))).status, 413);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id='private-task'").get().title,
    "\u0001".repeat(4096));
});

test("status reconciles exact command without task or audit writes", async () => {
  const rev = (await (await get("private-task")).json()).snapshotRevision;
  const input = command("Status title", rev);
  const before = db.prepare("SELECT COUNT(*) AS n FROM task_title_audit WHERE task_id='private-task'").get().n;
  assert.deepEqual(await (await status("private-task", input)).json(), { status: "not_recorded" });
  assert.equal((await patch("private-task", input)).status, 200);
  const task = db.prepare("SELECT title,revision FROM tasks WHERE id='private-task'").get();
  assert.deepEqual(await (await status("private-task", input)).json(), { status: "committed" });
  assert.equal((await status("private-task", { ...input, title: "Other" })).status, 409);
  assert.deepEqual(db.prepare("SELECT title,revision FROM tasks WHERE id='private-task'").get(), task);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_title_audit WHERE task_id='private-task'").get().n, before + 1);
});

test("status hides read-only shared, foreign and missing tasks, and enforces owner gates", async () => {
  const input = command("Probe", "a".repeat(64));
  for (const id of ["viewer-task", "foreign-task", "missing-task"]) {
    const response = await status(id, input);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "false";
  assert.equal((await status("private-task", input)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.equal((await status("private-task", input)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
  assert.equal((await status("private-task", input, { auth: null })).status, 401);
  assert.equal((await status("private-task", input, { origin: null })).status, 403);
  assert.equal((await status("private-task", input, { origin: "https://evil.example" })).status, 403);
  assert.equal((await status("private-task", input, { query: "?title=secret" })).status, 400);
  assert.equal((await status("private-task", { ...input, actorUserId: "alice" })).status, 400);
  assert.equal((await status("private-task", { ...input, areaId: stage.unassignedAreaId })).status, 400);
  assert.equal((await status("private-task", { ...input, scope: "personal" })).status, 400);
  assert.equal((await status("private-task", { ...input, expectedRevision: "wrong" })).status, 400);
  assert.equal((await status("private-task", { ...input, title: "x".repeat(7000) })).status, 400);
  assert.equal((await statusRaw("private-task", Buffer.alloc(32 * 1024 + 1, 0x20))).status, 413);
  const malformed = Buffer.from(JSON.stringify(input));
  malformed[malformed.indexOf(Buffer.from("Probe"))] = 0xc3;
  assert.equal((await statusRaw("private-task", malformed)).status, 400);
});

test("status immediately loses receipt visibility after private task moves to a read-only shared Area", async () => {
  const rev = (await (await get("private-task")).json()).snapshotRevision;
  const input = command("Before move", rev);
  assert.equal((await patch("private-task", input)).status, 200);
  assert.equal((await status("private-task", input)).status, 200);
  db.prepare("UPDATE tasks SET area_id='ro-area' WHERE id='private-task'").run();
  assert.equal((await status("private-task", input)).status, 404);
});

