import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const envNames = [
  "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_AUTH_ENABLED", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY", "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
];
const oldEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2b-http-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { GET } = await import("../app/api/target-staging/tasks/route.ts");
const { GET: GET_DETAIL } = await import("../app/api/target-staging/tasks/[taskId]/route.ts");
const { PATCH: PATCH_TITLE } = await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const { GET: GET_AUDIT } = await import("../app/api/target-staging/tasks/[taskId]/audit/route.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const { TARGET_STAGING_RECEIPT_PREFIX } = await import("../lib/target-store-bootstrap.ts");
const { parseStagingPrivateTaskAudit } = await import("../lib/target-staging-read-process.ts");
const { signStagingHttpCursor, verifyStagingHttpCursor } =
  await import("../lib/target-staging-http-cursor.ts");
const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
const db = new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys = ON");
db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob private','private','bob-personal','bob','unassigned')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','alice','admin')").run();
db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','bob','editor')").run();
const insert = db.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,NULL,?,?,NULL)");
insert.run("alice-private", stage.unassignedAreaId, "Alice private");
insert.run("alice-private-2", stage.unassignedAreaId, "Alice second private");
insert.run("bob-private", "bob-private", "Bob secret");
insert.run("family-shared", "family-area", "Family secret");

let currentOwnerToken = "";

function configure() {
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  process.env.AI_EXECUTIVE_PASSWORD_HASH = `scrypt:${Buffer.alloc(16, 1).toString("base64url")}:${Buffer.alloc(64, 2).toString("base64url")}`;
  process.env.AI_EXECUTIVE_SESSION_SECRET = "r2b-synthetic-only-secret-long-enough-12345";
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
  currentOwnerToken = createSessionToken();
}

function request(query = "", cookie = true, token = currentOwnerToken) {
  return new Request(`http://localhost/api/target-staging/tasks${query}`, {
    headers: cookie ? { cookie: `${sessionCookieName}=${token}` } : {},
  });
}

function detail(taskId, cookie = true, token = currentOwnerToken, query = "") {
  const req = new Request(`http://localhost/api/target-staging/tasks/${encodeURIComponent(taskId)}${query}`, {
    headers: cookie ? { cookie: `${sessionCookieName}=${token}` } : {},
  });
  return GET_DETAIL(req, { params: Promise.resolve({ taskId }) });
}

function patchTitle(taskId, title, expectedRevision, commandId) {
  const req = new Request(`http://localhost/api/target-staging/tasks/${encodeURIComponent(taskId)}/title`, {
    method: "PATCH",
    headers: { cookie: `${sessionCookieName}=${currentOwnerToken}`,
      origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ commandId, title, expectedRevision }),
  });
  return PATCH_TITLE(req, { params: Promise.resolve({ taskId }) });
}

function audit(taskId, cookie = true, token = currentOwnerToken, query = "") {
  const req = new Request(
    `http://localhost/api/target-staging/tasks/${encodeURIComponent(taskId)}/audit${query}`,
    { headers: cookie ? { cookie: `${sessionCookieName}=${token}` } : {} },
  );
  return GET_AUDIT(req, { params: Promise.resolve({ taskId }) });
}

after(() => {
  db.close();
  for (const name of envNames) {
    if (oldEnv[name] === undefined) delete process.env[name];
    else process.env[name] = oldEnv[name];
  }
  rmSync(root, { recursive: true, force: true });
});

test("feature flag, complete configuration, and real owner cookie are mandatory", async () => {
  configure();
  delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED;
  assert.equal((await GET(request())).status, 404);
  configure();
  delete process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  assert.equal((await GET(request())).status, 503);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = "relative/stage";
  assert.equal((await GET(request())).status, 503);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = "wrong";
  assert.equal((await GET(request())).status, 503);
  configure();
  assert.equal((await GET(request("", false))).status, 401);
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
  assert.equal((await GET(request())).status, 401, "insecure development auth bypass is not an owner proof");
  configure();
});

test("personal list returns only the configured owner's private tasks", async () => {
  configure();
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.tasks.map(task => task.id), ["alice-private", "alice-private-2"]);
  assert.equal(body.hasMore, false);
  assert.equal(JSON.stringify(body).includes("Bob secret"), false);
  assert.equal(JSON.stringify(body).includes("Family secret"), false);
  assert.equal(JSON.stringify(body).includes("sessionToken"), false);
});

test("valid limits expose a signed, usable cursor and bounded personal pages", async () => {
  configure();
  const first = await GET(request("?limit=1"));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(firstBody.tasks, [{
      id: "alice-private", title: "Alice private", projectId: null,
      effectiveAreaId: stage.unassignedAreaId, areaKind: "private", assigneeUserId: null,
    }]);
  assert.equal(firstBody.hasMore, true);
  assert.match(firstBody.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(JSON.stringify(firstBody).includes("sessionToken"), false);
  assert.equal((await GET(request(`?cursor=${encodeURIComponent(firstBody.nextCursor)}`, false))).status, 401);
  assert.equal((await GET(request(`?cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    true, createSessionToken(120)))).status, 400, "a different owner cookie cannot replay this cursor");

  const second = await GET(request(`?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`));
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.deepEqual(secondBody.tasks.map(task => task.id), ["alice-private-2"]);
  assert.equal(secondBody.hasMore, false);
  assert.equal(secondBody.nextCursor, null);

  const all = await GET(request("?limit=100"));
  assert.equal(all.status, 200);
  const body = await all.json();
  assert.deepEqual(body.tasks.map(task => task.id), ["alice-private", "alice-private-2"]);
  assert.equal(body.hasMore, false);
  assert.equal(body.nextCursor, null);
});

test("stateless cursor verifies across independent contexts and expires without process state", () => {
  const base = {
    actorUserId: "alice", stagingDirectory: "/isolated/staging",
    restoreGeneration: "123e4567-e89b-42d3-a456-426614174000",
    authenticationBinding: "a".repeat(43),
    sessionSecret: "synthetic-staging-cookie-secret-123456789",
  };
  const cursor = signStagingHttpCursor(base, "b".repeat(64), 100, undefined, 1000);
  assert.equal(typeof cursor, "string");
  const visibleClaims = JSON.parse(Buffer.from(cursor.split(".")[0], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(visibleClaims).sort(),
    ["binding", "exp", "iat", "offset", "rev", "scope", "v"]);
  assert.equal(JSON.stringify(visibleClaims).includes(base.restoreGeneration), false);
  assert.equal(JSON.stringify(visibleClaims).includes(base.authenticationBinding), false);
  assert.deepEqual(verifyStagingHttpCursor({ ...base }, cursor, 1100),
    { ok: true, offset: 100, revision: "b".repeat(64), expiresAt: 1900 });
  for (const altered of [
    { actorUserId: "bob" }, { stagingDirectory: "/isolated/another" },
    { restoreGeneration: "123e4567-e89b-42d3-a456-426614174001" },
    { authenticationBinding: "c".repeat(43) },
    { sessionSecret: "different-staging-cookie-secret-123456789" },
  ]) {
    const result = verifyStagingHttpCursor({ ...base, ...altered }, cursor, 1100);
    assert.deepEqual(result, { ok: false, reason: "invalid" });
  }
  assert.deepEqual(verifyStagingHttpCursor(base, cursor, 1900),
    { ok: false, reason: "expired" });
});

test("client actor, scope, Area, workspace and malformed cursors are rejected", async () => {
  configure();
  for (const query of ["?actorUserId=bob", "?scope=shared", "?areaId=family-area",
    "?workspaceId=family", "?cursor=forged", "?limit=0", "?limit=101",
    "?limit=1.5", "?limit=1&limit=2", "?cursor=a.b&cursor=c.d"]) {
    const response = await GET(request(query));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("changes to another owner's private and shared tasks do not reveal activity in personal cursors", async () => {
  configure();
  const original = await (await GET(request("?limit=1"))).json();
  assert.equal(typeof original.nextCursor, "string");
  const originalRevision = JSON.parse(Buffer.from(original.nextCursor.split(".")[0],
    "base64url").toString("utf8")).rev;

  for (const [taskId, previousTitle] of [
    ["bob-private", "Bob secret"], ["family-shared", "Family secret"],
  ]) {
    db.prepare("UPDATE tasks SET title=? WHERE id=?").run("Other user changed task", taskId);
    try {
      const fresh = await GET(request("?limit=1"));
      assert.equal(fresh.status, 200);
      const freshBody = await fresh.json();
      const freshRevision = JSON.parse(Buffer.from(freshBody.nextCursor.split(".")[0],
        "base64url").toString("utf8")).rev;
      assert.equal(freshRevision, originalRevision,
        `${taskId} must not affect the owner's cursor revision`);
      const continued = await GET(request(`?limit=1&cursor=${encodeURIComponent(original.nextCursor)}`));
      assert.equal(continued.status, 200, `${taskId} must not stale a personal cursor`);
      assert.deepEqual((await continued.json()).tasks.map(task => task.id), ["alice-private-2"]);
    } finally {
      db.prepare("UPDATE tasks SET title=? WHERE id=?").run(previousTitle, taskId);
    }
  }
});

test("signed cursors reject tampering, changed snapshots and changed staging config", async () => {
  configure();
  const first = await (await GET(request("?limit=1"))).json();
  const cursor = first.nextCursor;
  assert.equal(typeof cursor, "string");

  const forged = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
  const invalid = await GET(request(`?cursor=${encodeURIComponent(forged)}`));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "Invalid cursor" });

  db.prepare("UPDATE tasks SET title='Changed during pagination' WHERE id='alice-private'").run();
  try {
    const stale = await GET(request(`?limit=1&cursor=${encodeURIComponent(cursor)}`));
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "Cursor stale" });
  } finally {
    db.prepare("UPDATE tasks SET title='Alice private' WHERE id='alice-private'").run();
  }

  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION =
    "123e4567-e89b-42d3-a456-426614174000";
  const changedConfig = await GET(request(`?cursor=${encodeURIComponent(cursor)}`));
  assert.equal(changedConfig.status, 400);
  assert.deepEqual(await changedConfig.json(), { error: "Invalid cursor" });
  configure();

  const fresh = await (await GET(request("?limit=1"))).json();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.equal((await GET(request())).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
  const continued = await GET(request(`?limit=1&cursor=${encodeURIComponent(fresh.nextCursor)}`));
  assert.equal(continued.status, 200, "stateless cursor survives a disabled request");
  assert.deepEqual((await continued.json()).tasks.map(task => task.id), ["alice-private-2"]);
});

test("stale generation, wrong owner and absent store fail without leaking task content or mutating legacy", async () => {
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "missing";
  const wrongOwner = await GET(request());
  assert.equal(wrongOwner.status, 503);
  assert.deepEqual(await wrongOwner.json(), { error: "Staging unavailable" });
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal((await GET(request())).status, 503);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = path.join(root, "missing");
  assert.equal((await GET(request())).status, 503);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_title_audit").get().n, 0);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id='alice-private'").get().title, "Alice private");
});

test("oversized child response fails closed and a following read recovers", async () => {
  configure();
  db.prepare("UPDATE tasks SET title=? WHERE id='alice-private'").run("x".repeat(1_200_000));
  try {
    const oversized = await GET(request("?limit=1"));
    assert.equal(oversized.status, 503);
    assert.deepEqual(await oversized.json(), { error: "Staging unavailable" });
  } finally {
    db.prepare("UPDATE tasks SET title='Alice private' WHERE id='alice-private'").run();
  }
  const recovered = await GET(request("?limit=1"));
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).tasks.map(task => task.id), ["alice-private"]);
});

test("personal detail returns only the configured owner's private task", async () => {
  configure();
  const response = await detail("alice-private");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.match(body.snapshotRevision, /^[a-f0-9]{64}$/);
  assert.deepEqual(body.task, {
    id: "alice-private", title: "Alice private", projectId: null,
    effectiveAreaId: stage.unassignedAreaId, areaKind: "private", assigneeUserId: null,
  });
  for (const taskId of ["absent", "bob-private", "family-shared"]) {
    const denied = await detail(taskId);
    assert.equal(denied.status, 404, taskId);
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assert.deepEqual(await denied.json(), { error: "Not found" });
  }
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "bob";
  const bob = await detail("bob-private");
  assert.equal(bob.status, 200);
  assert.equal((await bob.json()).task.title, "Bob secret");
  assert.equal((await detail("alice-private")).status, 404);
  assert.equal((await detail("family-shared")).status, 404);
  configure();
});

test("detail revision supports owner-private PATCH and rejects stale revisions", async () => {
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";
  const id = "detail-cas-target";
  const other = "detail-cas-independent";
  insert.run(id, stage.unassignedAreaId, "Before CAS");
  insert.run(other, stage.unassignedAreaId, "Independent");
  try {
    const initial = await detail(id);
    const separate = await detail(other);
    assert.equal(initial.status, 200);
    assert.equal(separate.status, 200);
    const { snapshotRevision } = await initial.json();
    const otherRevision = (await separate.json()).snapshotRevision;
    assert.match(snapshotRevision, /^[a-f0-9]{64}$/);
    assert.equal((await patchTitle(id, "After CAS", snapshotRevision,
      "123e4567-e89b-42d3-a456-426614174101")).status, 200);
    assert.equal((await patchTitle(id, "Stale write", snapshotRevision,
      "123e4567-e89b-42d3-a456-426614174102")).status, 409);
    assert.equal((await patchTitle(other, "Independent updated", otherRevision,
      "123e4567-e89b-42d3-a456-426614174103")).status, 200);
    const current = await detail(id);
    assert.equal(current.status, 200);
    assert.equal((await current.json()).task.title, "After CAS");
    assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(other).title,
      "Independent updated");
    const moved = "detail-cas-revoked";
    insert.run(moved, stage.unassignedAreaId, "Private before move");
    const movedRevision = (await (await detail(moved)).json()).snapshotRevision;
    db.prepare("UPDATE tasks SET area_id=? WHERE id=?").run("family-area", moved);
    assert.equal((await detail(moved)).status, 404);
    assert.equal((await patchTitle(moved, "Must not write", movedRevision,
      "123e4567-e89b-42d3-a456-426614174104")).status, 404);
    assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(moved).title,
      "Private before move");
    for (const deniedId of ["bob-private", "family-shared", "absent"]) {
      const denied = await detail(deniedId);
      assert.equal(denied.status, 404, deniedId);
      assert.deepEqual(await denied.json(), { error: "Not found" });
    }
  } finally {
    delete process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED;
  }
});

test("detail rejects bad IDs, query overrides, missing auth and wrong staging config", async () => {
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.equal((await detail("alice-private")).status, 404);
  configure();
  for (const taskId of ["", " bad", "a".repeat(513)]) {
    assert.equal((await detail(taskId)).status, 400, taskId);
  }
  assert.equal((await detail("alice-private", true, currentOwnerToken, "?scope=shared")).status, 400);
  assert.equal((await detail("alice-private", false)).status, 401);
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
  assert.equal((await detail("alice-private")).status, 401);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION =
    "123e4567-e89b-42d3-a456-426614174000";
  assert.equal((await detail("alice-private")).status, 503);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = path.join(root, "missing");
  assert.equal((await detail("alice-private")).status, 503);
  configure();
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});

test("oversized detail is rejected and a subsequent detail recovers", async () => {
  configure();
  db.prepare("UPDATE tasks SET title=? WHERE id='alice-private'").run("x".repeat(1_200_000));
  try {
    const oversized = await detail("alice-private");
    assert.equal(oversized.status, 503);
    assert.deepEqual(await oversized.json(), { error: "Staging unavailable" });
  } finally {
    db.prepare("UPDATE tasks SET title='Alice private' WHERE id='alice-private'").run();
  }
  assert.equal((await detail("alice-private")).status, 200);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});

test("detail accepts bounded list-compatible IDs with interior spaces and punctuation", async () => {
  configure();
  const taskId = "alice spec / 1";
  insert.run(taskId, stage.unassignedAreaId, "Special ID");
  const listed = await GET(request());
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).tasks.some(task => task.id === taskId), true);
  const response = await detail(taskId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.title, "Special ID");
  assert.equal((await detail("alice-private\n")).status, 400);
  assert.equal((await detail("x".repeat(513))).status, 400);
});


test("private task audit exposes only bounded timestamps and revisions, never titles", async () => {
  configure();
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  });
  try {
    const initial = await audit("alice-private-2");
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { events: [] });

    const token = authority.issueWritable("alice");
    assert.ok(token);
    const previous = authority.previewTaskTitleEdit(token.sessionToken, { taskId: "alice-private-2" });
    assert.equal(previous.ok, true);
    assert.deepEqual(authority.updateTaskTitle(token.sessionToken, {
      commandId: "123e4567-e89b-42d3-a456-426614174000",
      taskId: "alice-private-2",
      title: "AUDIT_TITLE_SENTINEL_PRIVATE",
      expectedRevision: previous.snapshotRevision,
    }), { ok: true });
    const response = await audit("alice-private-2");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.events.length, 1);
    assert.deepEqual(Object.keys(body.events[0]).sort(),
      ["committedAtMs", "revisionAfter", "revisionBefore"]);
    assert.equal(body.events[0].revisionAfter, body.events[0].revisionBefore + 1);
    assert.ok(body.events[0].committedAtMs > 0);
    const json = JSON.stringify(body);
    for (const hidden of [
      "AUDIT_TITLE_SENTINEL_PRIVATE", "Alice second private", "Bob secret",
      "Family secret", "receipt_key", "actor_user_id", "area_id",
      "expected_revision", "restore_generation", "sessionToken",
    ]) assert.equal(json.includes(hidden), false, hidden);
    for (const id of ["absent", "bob-private", "family-shared"]) {
      const denied = await audit(id);
      assert.equal(denied.status, 404, id);
      assert.deepEqual(await denied.json(), { error: "Not found" });
    }
  } finally {
    authority.close();
  }
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});

test("audit denies missing auth, disabled staging, bad IDs and client scope overrides", async () => {
  configure();
  assert.equal((await audit("alice-private", false)).status, 401);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.equal((await audit("alice-private")).status, 404);
  configure();
  for (const id of ["", " bad", "a".repeat(513), "bad\n"]) {
    assert.equal((await audit(id)).status, 400, id);
  }
  for (const query of ["?actorUserId=bob", "?scope=shared", "?areaId=family-area", "?limit=999"]) {
    assert.equal((await audit("alice-private", true, currentOwnerToken, query)).status, 400, query);
  }
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
  assert.equal((await audit("alice-private")).status, 401);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "missing";
  assert.equal((await audit("alice-private")).status, 503);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION =
    "123e4567-e89b-42d3-a456-426614174000";
  assert.equal((await audit("alice-private")).status, 503);
  configure();
});

test("audit returns only last 50 own-area events, with newest first", async () => {
  configure();
  const id = "audit-synthetic";
  insert.run(id, stage.unassignedAreaId, "Synthetic task");
  const receipt = db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  const insertEvent = db.prepare(`
    INSERT INTO task_title_audit(
      receipt_key,actor_user_id,task_id,area_id,policy_revision,
      revision_before,revision_after,expected_revision,restore_generation,committed_at_ms
    ) VALUES (?,'alice',?,?,0,0,1,?,?,?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < 51; i++) {
      const hash = i.toString(16).padStart(64, "0");
      const key = TARGET_STAGING_RECEIPT_PREFIX + hash;
      receipt.run(key, hash);
      insertEvent.run(key, id, stage.unassignedAreaId, hash, stage.restoreGeneration, 1_000_000 + i);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const response = await audit(id);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.events.length, 50);
  assert.deepEqual(body.events[0], { revisionBefore: 0, revisionAfter: 1,
    committedAtMs: 1_000_050 });
  assert.deepEqual(body.events[49], { revisionBefore: 0, revisionAfter: 1,
    committedAtMs: 1_000_001 });
});


test("audit loses access when a previously private task is moved to a shared Area", async () => {
  configure();
  const id = "audit-acl-transition";
  insert.run(id, stage.unassignedAreaId, "ACL transition");
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  });
  try {
    const token = authority.issueWritable("alice");
    assert.ok(token);
    const previous = authority.previewTaskTitleEdit(token.sessionToken, { taskId: id });
    assert.equal(previous.ok, true);
    assert.deepEqual(authority.updateTaskTitle(token.sessionToken, {
      commandId: "123e4567-e89b-42d3-a456-426614174010",
      taskId: id, title: "ACL transition audited title",
      expectedRevision: previous.snapshotRevision,
    }), { ok: true });
  } finally {
    authority.close();
  }

  const before = await audit(id);
  assert.equal(before.status, 200);
  assert.equal((await before.json()).events.length, 1);

  db.prepare("UPDATE tasks SET area_id = ? WHERE id = ?").run("family-area", id);
  const revoked = await audit(id);
  assert.equal(revoked.status, 404);
  assert.deepEqual(await revoked.json(), { error: "Not found" });

  db.prepare("UPDATE tasks SET area_id = ? WHERE id = ?").run(stage.unassignedAreaId, id);
  const restored = await audit(id);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).events.length, 1);
});

test("audit filters historical actor and Area rows and rejects stale generation rows", async () => {
  configure();
  const id = "audit-isolation";
  insert.run(id, stage.unassignedAreaId, "Filtered audit task");
  const insertReceipt = db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  const insertEvent = db.prepare(
    "INSERT INTO task_title_audit(" +
      "receipt_key,actor_user_id,task_id,area_id,policy_revision," +
      "revision_before,revision_after,expected_revision,restore_generation,committed_at_ms" +
    ") VALUES (?,?,?,?,0,0,1,?,?,?)"
  );
  const rows = [
    { actor: "alice", area: stage.unassignedAreaId, ms: 2_000_001 },
    { actor: "bob", area: stage.unassignedAreaId, ms: 2_000_002 },
    { actor: "alice", area: "family-area", ms: 2_000_003 },
    { actor: "alice", area: stage.unassignedAreaId, ms: 2_000_004 },
  ];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [index, row] of rows.entries()) {
      const hash = (200 + index).toString(16).padStart(64, "0");
      const key = TARGET_STAGING_RECEIPT_PREFIX + hash;
      insertReceipt.run(key, hash);
      insertEvent.run(key, row.actor, id, row.area, hash, stage.restoreGeneration, row.ms);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const response = await audit(id);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).events, [
    { revisionBefore: 0, revisionAfter: 1, committedAtMs: 2_000_004 },
    { revisionBefore: 0, revisionAfter: 1, committedAtMs: 2_000_001 },
  ]);

  // A mismatched generation is rejected by canonical preflight before SQL is read.
  const staleHash = (204).toString(16).padStart(64, "0");
  const staleKey = TARGET_STAGING_RECEIPT_PREFIX + staleHash;
  insertReceipt.run(staleKey, staleHash);
  insertEvent.run(staleKey, "alice", id, stage.unassignedAreaId, staleHash,
    "123e4567-e89b-42d3-a456-426614174001", 2_000_005);
  try {
    const rejected = await audit(id);
    assert.equal(rejected.status, 503);
    assert.deepEqual(await rejected.json(), { error: "Staging unavailable" });
  } finally {
    db.prepare("DELETE FROM task_title_audit WHERE receipt_key = ?").run(staleKey);
    db.prepare("DELETE FROM metadata WHERE key = ?").run(staleKey);
  }
  const recovered = await audit(id);
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).events.map(e => e.committedAtMs),
    [2_000_004, 2_000_001]);
});

test("audit subprocess DTO parser rejects hidden fields, bad values and oversized collections", () => {
  const event = { revisionBefore: 0, revisionAfter: 1, committedAtMs: 1 };
  assert.deepEqual(parseStagingPrivateTaskAudit({ ok: true, events: [event] }),
    { ok: true, events: [event] });
  for (const input of [
    { ok: true, events: [{ ...event, title: "secret" }] },
    { ok: true, events: [event], title: "secret" },
    { ok: true, events: [{ ...event, revisionAfter: 3 }] },
    { ok: true, events: [{ ...event, committedAtMs: "1" }] },
    { ok: true, events: Array.from({ length: 51 }, () => event) },
    { ok: false, reason: "unavailable", taskId: "secret" },
  ]) assert.equal(parseStagingPrivateTaskAudit(input), null);
});

