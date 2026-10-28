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

