import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED", "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION", "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const prior = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2d1-project-index-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
  ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "isolated-r2d1-project-index-secret-must-be-long";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { GET } = await import("../app/api/target-staging/project-index/route.ts");
const { GET: GET_PROJECT_TASKS } = await import("../app/api/target-staging/projects/[projectId]/tasks/route.ts");
const readProcess = await import("../lib/target-staging-read-process.ts");
const { verifyStagingReadBeforeRelease } = await import("../lib/target-staging-http-identity.ts");

after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});
let count = 0;
const base = "http://localhost:3001/api/target-staging/project-index";

function fixture() {
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "fx" + (++count)), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of ["bob", "carol", "dave", "erin"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(name);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(name + "-personal", name);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(name + "-private", name + " private", name + "-personal", name);
  }
  for (const [ws, owner] of [["family", "alice"], ["other", "erin"]]) {
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)").run(ws, owner);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(ws + "-area", ws, ws, owner);
  }
  for (const [area, user, role] of [
    ["family-area", "alice", "admin"], ["family-area", "bob", "editor"],
    ["family-area", "carol", "viewer"], ["other-area", "erin", "admin"],
  ]) db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)").run(area, user, role);
  const project = db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  project.run("alice-private-project", stage.unassignedAreaId, "Alice personal");
  project.run("bob-private-project", "bob-private", "Bob private");
  project.run("family-project", "family-area", "Family project");
  project.run("family-second", "family-area", "Family second");
  project.run("other-project", "other-area", "Erin secret");
  const task = db.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,?,NULL,?,?)");
  task.run("s-1", "family-project", "Shared one", "alice");
  task.run("s-2", "family-project", "Shared two", "bob");
  task.run("s-3", "family-project", "Unassigned", null);
  db.close();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
  return { stage, store: {
    stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
  } };
}
const ownerCookie = () => sessionCookieName + "=" + createSessionToken();
function login(fx, user) {
  const issued = durable.issueDurableTargetStagingSession(fx.store, user, 900);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE + "=" + issued.sessionToken;
}
function req(fx, query = "", cookie = ownerCookie()) {
  return new Request(base + query, { headers: { cookie, "x-forwarded-for": "10.9.0.3" } });
}
function get(fx, query = "", cookie = ownerCookie()) {
  return GET(req(fx, query, cookie));
}
async function ok(promise) {
  const response = await promise;
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}

test("authorized personal/shared project lists isolate identities and navigate to inherited tasks", async () => {
  const fx = fixture();
  const [alice, bob, carol, dave, erin] = ["alice", "bob", "carol", "dave", "erin"]
    .map(user => login(fx, user));
  for (const cookie of [alice, bob, carol]) {
    const shared = await ok(get(fx, "?scope=shared", cookie));
    assert.deepEqual(shared.projects.map(p => p.id), ["family-project", "family-second"]);
    assert.ok(shared.projects.every(p => p.areaKind === "shared" && p.areaId === "family-area"));
    assert.ok(!JSON.stringify(shared).includes("Erin secret"));
    assert.ok(!JSON.stringify(shared).includes("bob"));
    assert.equal(shared.nextCursor, null);
  }
  assert.deepEqual((await ok(get(fx, "?scope=shared", dave))).projects, []);
  assert.deepEqual((await ok(get(fx, "?scope=shared", erin))).projects.map(p => p.id),
    ["other-project"]);
  assert.deepEqual((await ok(get(fx, "?scope=personal", bob))).projects.map(p => p.id),
    ["bob-private-project"]);
  assert.deepEqual((await ok(get(fx, "?scope=personal", ownerCookie()))).projects.map(p => p.id),
    ["alice-private-project"]);
  const projectId = (await ok(get(fx, "?scope=shared", carol))).projects[0].id;
  const detail = await GET_PROJECT_TASKS(new Request(
    "http://localhost:3001/api/target-staging/projects/" + projectId + "/tasks",
    { headers: { cookie: carol, "x-forwarded-for": "10.9.0.3" } }),
  { params: Promise.resolve({ projectId }) });
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).tasks.map(t => t.id), ["s-1", "s-2", "s-3"]);
});

test("signed project cursors stay bound to session and scope, and stale on visible changes only", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const alice = login(fx, "alice");
  const page = await ok(get(fx, "?scope=shared&limit=1", bob));
  assert.deepEqual(page.projects.map(p => p.id), ["family-project"]);
  assert.equal(page.hasMore, true);
  assert.match(page.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const again = await ok(get(fx, "?scope=shared&limit=1&cursor=" + page.nextCursor, bob));
  assert.deepEqual(again.projects.map(p => p.id), ["family-second"]);
  assert.equal(again.hasMore, false);
  assert.equal((await get(fx, "?scope=personal&cursor=" + page.nextCursor, bob)).status, 400);
  assert.equal((await get(fx, "?scope=shared&cursor=" + page.nextCursor, alice)).status, 400);
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE projects SET title='Erin changed' WHERE id='other-project'").run();
  await ok(get(fx, "?scope=shared&limit=1&cursor=" + page.nextCursor, bob));
  db.prepare("UPDATE projects SET title='Family changed' WHERE id='family-project'").run();
  db.close();
  assert.equal((await get(fx, "?scope=shared&cursor=" + page.nextCursor, bob)).status, 409);
});

test("revocation after child snapshot invalidates list release", async () => {
  const fx = fixture();
  const carol = login(fx, "carol");
  const tokenHash = durable.hashTargetStagingSessionToken(carol.split("=")[1]);
  const read = await readProcess.readStagingAuthorizedProjectIndexInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice", sessionTokenHash: tokenHash,
  }, "shared", 1, 0);
  assert.ok(read);
  assert.equal(read.hasMore, true);
  assert.equal(read.guardProjects.length, 2);
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'").run();
  db.close();
  assert.equal(verifyStagingReadBeforeRelease(req(fx, "?scope=shared", carol),
    { kind: "session", tokenHash }, fx.store, "alice", read.linearization,
    undefined, { projects: read.guardProjects }), "stale");
  assert.deepEqual((await ok(get(fx, "?scope=shared", carol))).projects, []);
});

test("project moved after child snapshot invalidates even the lookahead row", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const read = await readProcess.readStagingAuthorizedProjectIndexInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice", sessionTokenHash: tokenHash,
  }, "shared", 1, 0);
  assert.ok(read && read.hasMore);
  assert.deepEqual(read.guardProjects.map(p => p.id), ["family-project", "family-second"]);
  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  const moveGuard = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='project_area_assignment_guard'")
    .get()?.sql;
  assert.equal(typeof moveGuard, "string");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TRIGGER project_area_assignment_guard");
    // Moving only the lookahead project must invalidate the original hasMore.
    db.prepare("UPDATE projects SET area_id='other-area' WHERE id='family-second'").run();
    db.exec(moveGuard + ";");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  assert.equal(verifyStagingReadBeforeRelease(req(fx, "?scope=shared", bob),
    { kind: "session", tokenHash }, fx.store, "alice", read.linearization,
    undefined, { projects: read.guardProjects }), "stale");
  const current = await ok(get(fx, "?scope=shared", bob));
  assert.deepEqual(current.projects.map(p => p.id), ["family-project"]);
});

test("project-only Area epochs bound pagination and detect distant edits without task churn", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  const insert = db.prepare("INSERT INTO projects(id, area_id, title) VALUES (?, 'family-area', ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < 400; i++) {
      insert.run("zz-bulk-" + String(i).padStart(4, "0"), "Extra " + i);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const epoch = () => db.prepare("SELECT project_content_revision FROM areas WHERE id='family-area'")
    .get().project_content_revision;
  const before = epoch();
  const page = await ok(get(fx, "?scope=shared&limit=1", bob));
  assert.deepEqual(page.projects.map(p => p.id), ["family-project"]);
  assert.equal(page.hasMore, true);

  // A task edit in the same Area must not invalidate a project-only cursor.
  db.prepare("UPDATE tasks SET title='Task changed' WHERE id='s-1'").run();
  assert.equal(epoch(), before);
  const following = await ok(get(fx, "?scope=shared&limit=1&cursor=" + page.nextCursor, bob));
  assert.deepEqual(following.projects.map(p => p.id), ["family-second"]);

  // An edit hundreds of rows beyond the page MUST invalidate its cursor.
  db.prepare("UPDATE projects SET title='Renamed last' WHERE id='zz-bulk-0399'").run();
  assert.equal(epoch(), before + 1);
  assert.equal((await get(fx, "?scope=shared&limit=1&cursor=" + page.nextCursor, bob)).status, 409);

  const fresh = await ok(get(fx, "?scope=shared&limit=1", bob));
  db.prepare("UPDATE projects SET title='Unrelated' WHERE id='other-project'").run();
  assert.equal((await get(fx, "?scope=shared&limit=1&cursor=" + fresh.nextCursor, bob)).status, 200);
  db.close();
});

test("malformed requests, child metadata injection and feature-off fail closed", async () => {
  const fx = fixture();
  const good = await readProcess.readStagingAuthorizedProjectIndexInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice",
  }, "shared", 1, 0);
  assert.ok(good);
  assert.equal(readProcess.parseStagingAuthorizedProjectIndex({
    ok: true, ...good, projects: good.projects.map(p => ({ ...p, members: ["bob"] })),
  }, "shared"), null);
  assert.equal(readProcess.parseStagingAuthorizedProjectIndex({
    ok: true, ...good, guardProjects: [{ id: "wrong", areaId: "family-area" }, ...good.guardProjects.slice(1)],
  }, "shared"), null);
  for (const q of ["?scope=all", "?scope=shared&scope=personal", "?actor=bob",
    "?areaId=family-area", "?limit=0", "?limit=101", "?limit=1&limit=2",
    "?cursor=a.b&cursor=c.d", "?cursor=invalid"]) {
    assert.equal((await get(fx, q)).status, 400, q);
  }
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.equal((await get(fx)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});
