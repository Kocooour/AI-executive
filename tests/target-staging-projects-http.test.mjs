import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const names = [
  "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_AUTH_ENABLED", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY", "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-project-http-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
process.env.AI_EXECUTIVE_DATA_DIR = legacy;

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { GET } = await import("../app/api/target-staging/projects/route.ts");
const { GET: GETProjectDetail } =
  await import("../app/api/target-staging/projects/[projectId]/route.ts");
const { signStagingHttpCursor } = await import("../lib/target-staging-http-cursor.ts");
const { signStagingProjectHttpCursor, verifyStagingProjectHttpCursor } =
  await import("../lib/target-staging-project-http-cursor.ts");
const { parseStagingPrivateProjectPage, parseStagingPrivateProjectDetail } =
  await import("../lib/target-staging-read-process.ts");
const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
const db = new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys = ON");
db.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob','private','bob-personal','bob','unassigned')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('shared','shared','alice')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('shared-area','Shared','shared','shared','alice')").run();
db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('shared-area','alice','admin')").run();
db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('shared-area','bob','editor')").run();
const insertProject = db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
insertProject.run("alice-1", stage.unassignedAreaId, "Alice one");
insertProject.run("alice-2", stage.unassignedAreaId, "Alice two");
insertProject.run("bob-1", "bob-private", "Bob secret");
insertProject.run("shared-1", "shared-area", "Shared secret");

let token;
function configure() {
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  process.env.AI_EXECUTIVE_PASSWORD_HASH =
    `scrypt:${Buffer.alloc(16, 1).toString("base64url")}:${Buffer.alloc(64, 2).toString("base64url")}`;
  process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-project-cookie-secret-long-enough-12345";
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
  token = createSessionToken();
}
function request(query = "", withCookie = true, cookieToken = token) {
  return new Request(`http://localhost/api/target-staging/projects${query}`, {
    headers: withCookie ? { cookie: `${sessionCookieName}=${cookieToken}` } : {},
  });
}
async function body(query = "") {
  const response = await GET(request(query));
  return { response, data: await response.json() };
}
async function detail(projectId, query = "", withCookie = true) {
  const response = await GETProjectDetail(
    new Request(`http://localhost/api/target-staging/projects/${encodeURIComponent(projectId)}${query}`, {
      headers: withCookie ? { cookie: `${sessionCookieName}=${token}` } : {},
    }),
    { params: Promise.resolve({ projectId }) },
  );
  return { response, data: await response.json() };
}
after(() => {
  db.close();
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
  rmSync(root, { recursive: true, force: true });
});

test("gate, cookie, config and strict request parameters fail closed", async () => {
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.equal((await GET(request())).status, 404);
  configure();
  assert.equal((await GET(request("", false))).status, 401);
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
  assert.equal((await GET(request())).status, 401);
  configure();
  for (const q of ["?scope=shared", "?actorUserId=bob", "?areaId=shared-area",
    "?limit=0", "?limit=101", "?limit=1.0", "?limit=1&limit=2",
    "?cursor=forged", "?cursor=a.b&cursor=c.d"]) {
    assert.equal((await GET(request(q))).status, 400, q);
  }
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = "relative";
  assert.equal((await GET(request())).status, 503);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION =
    "123e4567-e89b-42d3-a456-426614174000";
  assert.equal((await GET(request())).status, 503);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "missing";
  assert.equal((await GET(request())).status, 503);
});

test("only owner-private whitelisted projects are returned, with signed paging", async () => {
  configure();
  const { response, data } = await body("?limit=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(data.projects, [{
    id: "alice-1", title: "Alice one", areaId: stage.unassignedAreaId, areaKind: "private",
  }]);
  assert.equal(data.hasMore, true);
  assert.match(data.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(JSON.stringify(data).includes("secret"), false);
  assert.equal(JSON.stringify(data).includes("member"), false);
  assert.equal(JSON.stringify(data).includes("count"), false);
  assert.equal((await GET(request(`?cursor=${data.nextCursor}`, false))).status, 401);
  assert.equal((await GET(request(`?cursor=${data.nextCursor}`, true,
    createSessionToken(120)))).status, 400);
  const second = await body(`?limit=1&cursor=${data.nextCursor}`);
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.data.projects.map(project => project.id), ["alice-2"]);
  assert.equal(second.data.nextCursor, null);
  const all = await body("?limit=100");
  assert.deepEqual(all.data.projects.map(project => project.id), ["alice-1", "alice-2"]);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});

test("project cursor domain differs from task cursor and rejects tampering", async () => {
  configure();
  const first = (await body("?limit=1")).data;
  const cursor = first.nextCursor;
  const forged = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
  assert.equal((await GET(request(`?cursor=${forged}`))).status, 400);
  const context = {
    actorUserId: "alice", restoreGeneration: stage.restoreGeneration,
    stagingDirectory: stage.directory, authenticationBinding: "a".repeat(43),
    sessionSecret: process.env.AI_EXECUTIVE_SESSION_SECRET,
  };
  const projectToken = signStagingProjectHttpCursor(context, "b".repeat(64), 1, undefined, 1000);
  const taskToken = signStagingHttpCursor(context, "b".repeat(64), 1, undefined, 1000);
  assert.deepEqual(verifyStagingProjectHttpCursor(context, taskToken, 1001),
    { ok: false, reason: "invalid" });
  assert.deepEqual(verifyStagingProjectHttpCursor(context, projectToken, 1001),
    { ok: true, offset: 1, revision: "b".repeat(64), expiresAt: 1900 });
  assert.deepEqual(verifyStagingProjectHttpCursor(context, projectToken, 1900),
    { ok: false, reason: "expired" });
  assert.deepEqual(verifyStagingProjectHttpCursor({ ...context, actorUserId: "bob" },
    projectToken, 1001), { ok: false, reason: "invalid" });
});

test("foreign/shared changes do not stale a private cursor; own project and policy changes do", async () => {
  configure();
  const original = (await body("?limit=1")).data.nextCursor;
  const originalRevision = JSON.parse(Buffer.from(original.split(".")[0], "base64url")).rev;
  for (const id of ["bob-1", "shared-1"]) {
    db.prepare("UPDATE projects SET title=title || ' changed' WHERE id=?").run(id);
    const fresh = (await body("?limit=1")).data.nextCursor;
    assert.equal(JSON.parse(Buffer.from(fresh.split(".")[0], "base64url")).rev,
      originalRevision);
    assert.equal((await GET(request(`?cursor=${original}&limit=1`))).status, 200);
  }
  db.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES ('alice-task',NULL,?,'Unrelated task',NULL)")
    .run(stage.unassignedAreaId);
  assert.equal((await GET(request(`?cursor=${original}&limit=1`))).status, 200,
    "owner task changes must not stale project pagination");
  db.prepare("UPDATE projects SET title='Changed' WHERE id='alice-1'").run();
  assert.equal((await GET(request(`?cursor=${original}&limit=1`))).status, 409);
  db.prepare("UPDATE projects SET title='Alice one' WHERE id='alice-1'").run();
  assert.equal((await GET(request(`?cursor=${original}&limit=1`))).status, 409,
    "owner title A→B→A must still stale the original cursor");
  const afterAba = (await body("?limit=1")).data.nextCursor;
  assert.notEqual(JSON.parse(Buffer.from(afterAba.split(".")[0], "base64url")).rev,
    originalRevision);
  assert.equal((await GET(request(`?cursor=${afterAba}&limit=1`))).status, 200);
  db.prepare("UPDATE areas SET policy_revision=policy_revision+1 WHERE id=?")
    .run(stage.unassignedAreaId);
  assert.equal((await GET(request(`?cursor=${original}&limit=1`))).status, 409);
  assert.equal((await GET(request(`?cursor=${afterAba}&limit=1`))).status, 409);
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "bob";
  const bob = await body();
  assert.deepEqual(bob.data.projects.map(project => project.id), ["bob-1"]);
  assert.equal((await GET(request(`?cursor=${original}`))).status, 400);
});

test("child DTO rejects extra metadata and oversized owner project fails closed", async () => {
  assert.equal(parseStagingPrivateProjectPage({
    ok: true, projects: [{ id: "p", title: "P", areaId: "a", areaKind: "private", taskCount: 1 }],
    hasMore: false, revision: "a".repeat(64),
  }), null);
  configure();
  db.prepare("UPDATE projects SET title=? WHERE id='alice-1'").run("x".repeat(1_200_000));
  try {
    assert.equal((await GET(request("?limit=1"))).status, 503);
  } finally {
    db.prepare("UPDATE projects SET title='Alice one' WHERE id='alice-1'").run();
  }
  assert.equal((await GET(request("?limit=1"))).status, 200);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});

test("direct project detail has a strict owner-private DTO and indistinguishable 404s", async () => {
  configure();
  const own = await detail("alice-1");
  assert.equal(own.response.status, 200);
  assert.equal(own.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(own.data, {
    project: { id: "alice-1", title: "Alice one", areaId: stage.unassignedAreaId,
      areaKind: "private" },
  });
  for (const id of ["missing", "bob-1", "shared-1", "not/present"]) {
    const hidden = await detail(id);
    assert.equal(hidden.response.status, 404, id);
    assert.equal(hidden.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(hidden.data, { error: "Not found" }, id);
  }
  // Earlier pagination tests deliberately mutate foreign titles; reset this fixture locally.
  db.prepare("UPDATE projects SET title='Bob secret' WHERE id='bob-1'").run();
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "bob";
  const bob = await detail("bob-1");
  assert.equal(bob.response.status, 200);
  assert.deepEqual(bob.data.project, {
    id: "bob-1", title: "Bob secret", areaId: "bob-private", areaKind: "private",
  });
  assert.equal((await detail("alice-1")).response.status, 404);
});

test("project detail gate, real cookie, ID validation and server scope fail closed", async () => {
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.equal((await detail("alice-1")).response.status, 404);
  configure();
  assert.equal((await detail("alice-1", "", false)).response.status, 401);
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
  assert.equal((await detail("alice-1")).response.status, 401);
  configure();
  for (const id of ["", "x".repeat(513), "bad\ncontrol"]) {
    assert.equal((await detail(id)).response.status, 400, JSON.stringify(id));
  }
  for (const query of ["?scope=shared", "?actorUserId=bob", "?taskCount=1"]) {
    assert.equal((await detail("alice-1", query)).response.status, 400, query);
  }
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "missing";
  assert.equal((await detail("alice-1")).response.status, 503);
  configure();
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION =
    "123e4567-e89b-42d3-a456-426614174000";
  assert.equal((await detail("alice-1")).response.status, 503);
});

test("project detail child DTO binds requested ID and rejects extra fields", async () => {
  const valid = { ok: true, project: {
    id: "alice-1", title: "Alice one", areaId: stage.unassignedAreaId, areaKind: "private",
  } };
  assert.deepEqual(parseStagingPrivateProjectDetail(valid, "alice-1"), valid);
  assert.equal(parseStagingPrivateProjectDetail(valid, "bob-1"), null);
  assert.equal(parseStagingPrivateProjectDetail({ ...valid, project: {
    ...valid.project, taskCount: 3,
  } }, "alice-1"), null);
  assert.deepEqual(parseStagingPrivateProjectDetail({
    ok: false, reason: "unavailable",
  }, "alice-1"), { ok: false, reason: "unavailable" });
  assert.equal(parseStagingPrivateProjectDetail({
    ok: false, reason: "unavailable", leaked: "Bob",
  }, "alice-1"), null);
});

test("oversized project detail output fails closed without changing legacy data", async () => {
  configure();
  db.prepare("UPDATE projects SET title=? WHERE id='alice-1'").run("x".repeat(1_200_000));
  try {
    assert.equal((await detail("alice-1")).response.status, 503);
  } finally {
    db.prepare("UPDATE projects SET title='Alice one' WHERE id='alice-1'").run();
  }
  assert.equal((await detail("alice-1")).response.status, 200);
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});

test("project ID whitespace is opaque and round-trips from list to detail", async () => {
  configure();
  insertProject.run(" padded ", stage.unassignedAreaId, "Padded project");
  const listed = await body("?limit=100");
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.data.projects.find(project => project.id === " padded "), {
    id: " padded ", title: "Padded project",
    areaId: stage.unassignedAreaId, areaKind: "private",
  });
  const found = await detail(" padded ");
  assert.equal(found.response.status, 200);
  assert.deepEqual(found.data.project, {
    id: " padded ", title: "Padded project",
    areaId: stage.unassignedAreaId, areaKind: "private",
  });
  assert.equal((await detail("padded")).response.status, 404,
    "no trimming or aliasing of stored project IDs");
});
