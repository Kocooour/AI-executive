/** Focused post-build Next router smoke; no browser and no production data. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-next-staging-smoke-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "synthetic legacy only");
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

let db;
let server;

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  listener.close();
  await once(listener, "close");
  return port;
}

async function ready(url, serverProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`next start exited: ${serverProcess.exitCode}`);
    try {
      const response = await fetch(`${url}/api/target-staging/tasks`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 401) return;
    } catch { /* server has not bound its port yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("next start did not become ready in 30 seconds");
}

try {
  const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
  const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
  });
  db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob private','private','bob-personal','bob','unassigned')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','bob','editor')").run();
  // R2-ID.3: a viewer (read-only) for the shared title write smoke.
  db.prepare("INSERT INTO identities(id) VALUES ('carol')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('carol-personal','personal','carol')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('carol-private','Carol private','private','carol-personal','carol','unassigned')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','carol','viewer')").run();
  const insert = db.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,NULL,?,?,NULL)");
  const ids = ["alice/slash", "alice space", "alice:punct@-._"];
  for (const id of ids) insert.run(id, stage.unassignedAreaId, `Visible ${id}`);
  insert.run("bob-secret", "bob-private", "Bob secret");
  insert.run("shared-secret", "family-area", "Family secret");
  const insertProject = db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  insertProject.run("alice/project", stage.unassignedAreaId, "Alice project");
  insertProject.run("alice second", stage.unassignedAreaId, "Alice second");
  insertProject.run("bob-project", "bob-private", "Bob project secret");
  insertProject.run("shared-project", "family-area", "Shared project secret");
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('sync-note','family-area','Sync title','Sync body')").run();
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('bob-note','bob-private','Hidden title','Hidden body')").run();

  const secret = randomBytes(32).toString("base64url");
  const hash = `scrypt:${Buffer.alloc(16, 1).toString("base64url")}:${Buffer.alloc(64, 2).toString("base64url")}`;
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  process.env.AI_EXECUTIVE_PASSWORD_HASH = hash;
  process.env.AI_EXECUTIVE_SESSION_SECRET = secret;
  const cookie = `${sessionCookieName}=${createSessionToken()}`;
  const port = await unusedPort();
  const origin = `http://localhost:${port}`;
  server = spawn(process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--hostname", "localhost", "--port", String(port)],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: process.env.PATH || "", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      AI_EXECUTIVE_DATA_DIR: legacy,
      AI_EXECUTIVE_AUTH_ENABLED: "true", AI_EXECUTIVE_PASSWORD_HASH: hash,
      AI_EXECUTIVE_SESSION_SECRET: secret,
      AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED: "true",
      AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED: "true",
      AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED: "true",
      AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED: "true",
      AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: stage.directory,
      AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION: stage.restoreGeneration,
      AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID: "alice",
    } });
  // Consume pipes so a verbose server cannot block on a full stdout buffer.
  let output = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => {
    output = (output + chunk.toString("utf8")).slice(-4_000);
  });
  try {
    await ready(origin, server);
  } catch (error) {
    throw new Error(`${error.message}\n${output}`);
  }

  for (const id of ids) {
    const response = await fetch(`${origin}/api/target-staging/tasks/${encodeURIComponent(id)}`, {
      headers: { cookie }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `Next router failed encoded ID ${id}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.task.id, id);
    assert.equal(body.task.title, `Visible ${id}`);
  }
  for (const id of ["missing", "bob-secret"]) {
    const response = await fetch(`${origin}/api/target-staging/tasks/${encodeURIComponent(id)}`, {
      headers: { cookie }, signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 404, id);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  // R2-ID.2b: alice is a member of the shared Area, so its task is readable with the minimal shared shape.
  const sharedDetail = await fetch(`${origin}/api/target-staging/tasks/shared-secret`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(sharedDetail.status, 200);
  assert.equal(sharedDetail.headers.get("cache-control"), "no-store");
  const sharedBody = await sharedDetail.json();
  // R2-ID.3: alice is a shared admin, so the title CAS token accompanies the shared DTO.
  assert.deepEqual(Object.keys(sharedBody).sort(), ["snapshotRevision", "task"]);
  assert.match(sharedBody.snapshotRevision, /^[a-f0-9]{64}$/);
  assert.equal(sharedBody.task.id, "shared-secret");
  assert.equal(sharedBody.task.areaId, "family-area");
  assert.equal(sharedBody.task.areaKind, "shared");
  assert.equal(typeof sharedBody.task.assignedToMe, "boolean");
  assert.equal(JSON.stringify(sharedBody).includes("assigneeUserId"), false);
  assert.equal(JSON.stringify(sharedBody).includes("bob"), false);
  const sharedList = await fetch(`${origin}/api/target-staging/tasks?scope=shared`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(sharedList.status, 200);
  assert.equal(sharedList.headers.get("cache-control"), "no-store");
  assert.ok((await sharedList.json()).tasks.some(task => task.id === "shared-secret"));
  assert.equal((await fetch(`${origin}/api/target-staging/tasks?scope=bogus`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  })).status, 400);
  // R2c.2a: the bootstrap / change feed route is routed, authenticated and no-store.
  const feedFirst = await fetch(`${origin}/api/target-staging/changes`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(feedFirst.status, 200);
  assert.equal(feedFirst.headers.get("cache-control"), "no-store");
  const feedBody = await feedFirst.json();
  assert.equal(feedBody.phase, "bootstrap");
  assert.equal(feedBody.more, false);
  assert.ok(feedBody.items.some(item => item.id === "shared-secret"));
  assert.equal(JSON.stringify(feedBody).includes("Bob secret"), false);
  const feedNext = await fetch(`${origin}/api/target-staging/changes?cursor=${feedBody.cursor}`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(feedNext.status, 200);
  assert.deepEqual((await feedNext.json()).items, []);
  assert.equal((await fetch(`${origin}/api/target-staging/changes`)).status, 401);
  assert.equal((await fetch(`${origin}/api/target-staging/changes?cursor=garbage`, {
    headers: { cookie } })).status, 400);
  const noteSyncUrl = `${origin}/api/target-staging/note-sync?areaId=family-area`;
  const noteSyncFirst = await fetch(noteSyncUrl, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
  assert.equal(noteSyncFirst.status, 200, "Next note-sync route failed");
  assert.equal(noteSyncFirst.headers.get("cache-control"), "no-store");
  const noteSyncPage = await noteSyncFirst.json();
  assert.deepEqual(Object.keys(noteSyncPage).sort(), ["changes", "cursor", "entries", "more", "phase"]);
  assert.equal(noteSyncPage.phase, "bootstrap");
  assert.deepEqual(noteSyncPage.entries, [{
    id: "sync-note", revision: 0, projectId: null, parentRevision: null,
  }]);
  assert.deepEqual(noteSyncPage.changes, []);
  const noteSyncNext = await fetch(`${noteSyncUrl}&cursor=${encodeURIComponent(noteSyncPage.cursor)}`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(noteSyncNext.status, 200);
  assert.deepEqual((await noteSyncNext.json()).changes, []);
  const hiddenNoteSync = await fetch(`${origin}/api/target-staging/note-sync?areaId=bob-private`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(hiddenNoteSync.status, 404);
  assert.deepEqual(await hiddenNoteSync.json(), { error: "Not found" });
  const invalidNoteSync = await fetch(`${noteSyncUrl}&cursor=invalid`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(invalidNoteSync.status, 409);
  assert.deepEqual(await invalidNoteSync.json(), { code: "resync_required" });
  const unauthenticated = await fetch(`${origin}/api/target-staging/tasks/${encodeURIComponent(ids[0])}`);
  assert.equal(unauthenticated.status, 401);
  for (const id of ids) {
    const response = await fetch(
      `${origin}/api/target-staging/tasks/${encodeURIComponent(id)}/audit`,
      { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(response.status, 200, `Next audit routing failed for ${id}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { events: [] });
  }
  for (const id of ["missing", "bob-secret", "shared-secret"]) {
    const response = await fetch(
      `${origin}/api/target-staging/tasks/${encodeURIComponent(id)}/audit`,
      { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(response.status, 404, `Next audit leaked access for ${id}`);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  assert.equal((await fetch(`${origin}/api/target-staging/tasks/${encodeURIComponent(ids[0])}/audit`)).status, 401);
  assert.equal((await fetch(`${origin}/api/target-staging/tasks/${encodeURIComponent(ids[0])}/audit?scope=shared`,
    { headers: { cookie } })).status, 400);
  const projectFirst = await fetch(`${origin}/api/target-staging/projects?limit=1`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(projectFirst.status, 200);
  assert.equal(projectFirst.headers.get("cache-control"), "no-store");
  const projectPage = await projectFirst.json();
  assert.deepEqual(projectPage.projects, [{
    id: "alice second", title: "Alice second",
    areaId: stage.unassignedAreaId, areaKind: "private",
  }]);
  assert.equal(projectPage.hasMore, true);
  const projectSecond = await fetch(
    `${origin}/api/target-staging/projects?limit=1&cursor=${encodeURIComponent(projectPage.nextCursor)}`,
    { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(projectSecond.status, 200);
  assert.deepEqual((await projectSecond.json()).projects.map(project => project.id), ["alice/project"]);
  assert.equal((await fetch(`${origin}/api/target-staging/projects`)).status, 401);
  assert.equal((await fetch(`${origin}/api/target-staging/projects?scope=shared`,
    { headers: { cookie } })).status, 400);
  for (const [id, title] of [["alice/project", "Alice project"], ["alice second", "Alice second"]]) {
    const response = await fetch(
      `${origin}/api/target-staging/projects/${encodeURIComponent(id)}`,
      { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(response.status, 200, `Next project detail routing failed for ${id}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      project: { id, title, areaId: stage.unassignedAreaId, areaKind: "private" },
    });
  }
  for (const id of ["missing-project", "bob-project", "shared-project"]) {
    const response = await fetch(
      `${origin}/api/target-staging/projects/${encodeURIComponent(id)}`,
      { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
    );
    assert.equal(response.status, 404, id);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  assert.equal((await fetch(`${origin}/api/target-staging/projects/alice%2Fproject`)).status, 401);
  assert.equal((await fetch(`${origin}/api/target-staging/projects/alice%2Fproject?scope=shared`,
    { headers: { cookie } })).status, 400);
  insertProject.run(" padded ", stage.unassignedAreaId, "Padded project");
  const paddedResponse = await fetch(
    `${origin}/api/target-staging/projects/${encodeURIComponent(" padded ")}`,
    { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(paddedResponse.status, 200, "Next project detail routing failed for padded ID");
  assert.deepEqual(await paddedResponse.json(), {
    project: { id: " padded ", title: "Padded project",
      areaId: stage.unassignedAreaId, areaKind: "private" },
  });
  // Exercise the real post-build route and child process, not just a direct handler import.
  // An uncertain PATCH response is reconciled using exactly the original command.
  const titleTaskId = ids[0]; // Encoded slash also checks nested Next route matching.
  const titleUrl = `${origin}/api/target-staging/tasks/${encodeURIComponent(titleTaskId)}/title`;
  const statusUrl = `${titleUrl}/status`;
  // R2c.3: every write names the protocol version, its Area and the restore generation.
  const writeHeaders = { cookie, origin, "content-type": "application/json", "x-lumi-target-protocol": "1" };
  const preview = await fetch(titleUrl, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(preview.status, 200, "Next title preflight failed");
  const { snapshotRevision } = await preview.json();
  assert.match(snapshotRevision, /^[a-f0-9]{64}$/);
  const titleCommand = {
    commandId: randomUUID(), title: "HTTP reconciled title",
    expectedRevision: snapshotRevision,
    writeAreaId: stage.unassignedAreaId, restoreGeneration: stage.restoreGeneration,
  };
  const checkStatus = (id, payload) => fetch(
    `${origin}/api/target-staging/tasks/${encodeURIComponent(id)}/title/status`,
    { method: "POST", headers: writeHeaders, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000) },
  );
  const notRecorded = await checkStatus(titleTaskId, titleCommand);
  assert.equal(notRecorded.status, 200, "Next status route failed before PATCH");
  assert.deepEqual(await notRecorded.json(), { status: "not_recorded" });

  const written = await fetch(titleUrl, {
    method: "PATCH", headers: writeHeaders,
    body: JSON.stringify(titleCommand), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(written.status, 200, "Next title PATCH failed");
  assert.deepEqual(await written.json(), { ok: true });
  const committed = await checkStatus(titleTaskId, titleCommand);
  assert.equal(committed.status, 200, "Next status route failed after PATCH");
  assert.deepEqual(await committed.json(), { status: "committed" });

  const conflict = await checkStatus(titleTaskId, {
    ...titleCommand, title: "Different title",
  });
  assert.equal(conflict.status, 409, "Changed payload must conflict");
  assert.deepEqual(await conflict.json(), { error: "Revision conflict" });
  // (shared-secret is no longer hidden from alice: she is a shared admin, see the shared write below.)
  for (const id of ["bob-secret", "missing"]) {
    const hidden = await checkStatus(id, titleCommand);
    assert.equal(hidden.status, 404, `Status leaked task ${id}`);
    assert.deepEqual(await hidden.json(), { error: "Not found" });
  }
  // R2c.3 barrier through the real build: no/other protocol header and snapshot-shaped bodies write nothing.
  const titleBefore = db.prepare("SELECT title,revision FROM tasks WHERE id=?").get(titleTaskId);
  const { "x-lumi-target-protocol": _omitted, ...noProtocol } = writeHeaders;
  const unversioned = await fetch(titleUrl, { method: "PATCH", headers: noProtocol,
    body: JSON.stringify({ ...titleCommand, commandId: randomUUID(), title: "No version" }), signal: AbortSignal.timeout(10_000) });
  assert.equal(unversioned.status, 400);
  assert.deepEqual(await unversioned.json(), { error: "Invalid request", code: "protocol_unsupported" });
  const legacyShape = await fetch(titleUrl, { method: "PATCH", headers: writeHeaders,
    body: JSON.stringify({ entities: [], relations: [], baseRevision: "x" }), signal: AbortSignal.timeout(10_000) });
  assert.equal(legacyShape.status, 400);
  assert.deepEqual(await legacyShape.json(), { error: "Invalid request", code: "legacy_snapshot_rejected" });
  assert.deepEqual(db.prepare("SELECT title,revision FROM tasks WHERE id=?").get(titleTaskId), titleBefore);
  const unauthenticatedStatus = await fetch(statusUrl, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(titleCommand), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(unauthenticatedStatus.status, 401);
  const finalTask = await fetch(
    `${origin}/api/target-staging/tasks/${encodeURIComponent(titleTaskId)}`,
    { headers: { cookie }, signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(finalTask.status, 200);
  assert.equal((await finalTask.json()).task.title, titleCommand.title);

  // R2-ID.3: shared-Area title write through the real build. Owner cookie (alice, admin),
  // a durable editor session (bob) and a durable viewer session (carol, read-only -> 404).
  const durable = await import("../lib/target-staging-durable-session.ts");
  const storeRef = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
  const sessionCookieFor = user => {
    const issued = durable.issueDurableTargetStagingSession(storeRef, user, 600);
    assert.equal(issued.ok, true, `session for ${user}`);
    return `${durable.TARGET_STAGING_SESSION_COOKIE}=${issued.sessionToken}`;
  };
  const bobCookie = sessionCookieFor("bob");
  const carolCookie = sessionCookieFor("carol");
  const sharedUrl = `${origin}/api/target-staging/tasks/shared-secret`;
  const sharedAs = async (who, method, suffix, payload) => fetch(sharedUrl + suffix, {
    method, headers: { cookie: who, origin, "content-type": "application/json", "x-lumi-target-protocol": "1" },
    ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(10_000),
  });
  const sharedArea = { writeAreaId: "family-area", restoreGeneration: stage.restoreGeneration };
  const bobDetail = await (await sharedAs(bobCookie, "GET", "")).json();
  assert.match(bobDetail.snapshotRevision, /^[a-f0-9]{64}$/, "editor gets the title CAS token");
  const carolDetail = await sharedAs(carolCookie, "GET", "");
  assert.equal(carolDetail.status, 200);
  assert.deepEqual(Object.keys(await carolDetail.json()), ["task"], "viewer gets no title CAS token");
  const viewerCommand = { commandId: randomUUID(), title: "Viewer must not write", expectedRevision: bobDetail.snapshotRevision, ...sharedArea };
  for (const [method, suffix, payload] of [["GET", "/title"], ["PATCH", "/title", viewerCommand], ["POST", "/title/status", viewerCommand]]) {
    const refused = await sharedAs(carolCookie, method, suffix, payload);
    assert.equal(refused.status, 404, `viewer ${method} ${suffix}`);
    assert.deepEqual(await refused.json(), { error: "Not found" });
  }
  const sharedCommand = { commandId: randomUUID(), title: "Shared title by bob", expectedRevision: bobDetail.snapshotRevision, ...sharedArea };
  const sharedWritten = await sharedAs(bobCookie, "PATCH", "/title", sharedCommand);
  assert.equal(sharedWritten.status, 200, "Next shared title PATCH failed");
  assert.deepEqual(await sharedWritten.json(), { ok: true });
  assert.deepEqual(await (await sharedAs(bobCookie, "POST", "/title/status", sharedCommand)).json(), { status: "committed" });
  assert.deepEqual(await (await sharedAs(cookie, "POST", "/title/status", sharedCommand)).json(), { status: "not_recorded" },
    "another identity cannot see bob's receipt");
  assert.equal((await sharedAs(bobCookie, "PATCH", "/title", { ...sharedCommand, commandId: randomUUID() })).status, 409,
    "a stale token is a conflict");
  const ownerShared = await (await sharedAs(cookie, "GET", "")).json();
  assert.equal(ownerShared.task.title, "Shared title by bob");
  const ownerCommand = { commandId: randomUUID(), title: "Shared title by alice", expectedRevision: ownerShared.snapshotRevision, ...sharedArea };
  assert.equal((await sharedAs(cookie, "PATCH", "/title", ownerCommand)).status, 200);
  assert.deepEqual(
    db.prepare("SELECT actor_user_id AS a FROM task_title_audit WHERE task_id='shared-secret' ORDER BY id").all().map(row => row.a),
    ["bob", "alice"], "audit records the real writer");
  // The owner-only audit read stays private-only even after shared writes.
  assert.equal((await fetch(`${sharedUrl}/audit`, { headers: { cookie } })).status, 404);
  // R2c.1: tombstoning task delete + status through the real build. Viewer -> 404; editor deletes;
  // the exact retry replays (the task is gone, the tombstone Area decides); a non-deleter learns nothing.
  const deleteToken = (await (await sharedAs(bobCookie, "GET", "")).json()).snapshotRevision;
  const deleteCommand = { commandId: randomUUID(), expectedRevision: deleteToken, ...sharedArea };
  for (const suffix of ["/delete", "/delete/status"]) {
    const refused = await sharedAs(carolCookie, "POST", suffix, deleteCommand);
    assert.equal(refused.status, 404, `viewer POST ${suffix}`);
    assert.deepEqual(await refused.json(), { error: "Not found" });
  }
  assert.deepEqual(await (await sharedAs(bobCookie, "POST", "/delete/status", deleteCommand)).json(), { status: "not_recorded" });
  const deleted = await sharedAs(bobCookie, "POST", "/delete", deleteCommand);
  assert.equal(deleted.status, 200, "Next shared task delete failed");
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.deepEqual(await (await sharedAs(bobCookie, "POST", "/delete", deleteCommand)).json(), { ok: true, replayed: true });
  assert.deepEqual(await (await sharedAs(bobCookie, "POST", "/delete/status", deleteCommand)).json(), { status: "committed" });
  assert.equal((await sharedAs(cookie, "POST", "/delete/status", deleteCommand)).status, 404, "another identity learns nothing");
  assert.equal((await sharedAs(bobCookie, "GET", "")).status, 404, "deleted task is gone");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_tombstones WHERE id='shared-secret'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity_id='shared-secret' AND op='tombstone'").get().n, 1);
  console.log("Next router staging task/project reads, private audit, title status, shared title write and task delete smoke passed");
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3_000))]);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
  }
  db?.close();
  rmSync(root, { recursive: true, force: true });
}
