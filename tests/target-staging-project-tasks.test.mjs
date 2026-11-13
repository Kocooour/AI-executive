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
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2d1-project-tasks-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "sentinel"), "legacy unchanged");
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
  ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "isolated-r2d1-project-tasks-secret-must-be-long";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("./support/owner-session-test-cookie.mjs");
const { GET } = await import("../app/api/target-staging/projects/[projectId]/tasks/route.ts");
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
const base = "http://localhost:3001/api/target-staging/projects/";

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
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?, 'shared',?,?)")
      .run(ws + "-area", ws, ws, owner);
  }
  for (const [area, user, role] of [
    ["family-area", "alice", "admin"], ["family-area", "bob", "editor"],
    ["family-area", "carol", "viewer"], ["other-area", "erin", "admin"],
  ]) db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)").run(area, user, role);
  const project = db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,?)");
  project.run("alice-private-project", stage.unassignedAreaId, "Alice private project");
  project.run("bob-private-project", "bob-private", "Bob private secret");
  project.run("family-project", "family-area", "Family project");
  project.run("family-second", "family-area", "Family second");
  project.run("other-project", "other-area", "Other secret");
  const task = db.prepare("INSERT INTO tasks(id,project_id,area_id,title,assignee_user_id) VALUES (?,?,NULL,?,?)");
  task.run("s-1", "family-project", "Shared one", "alice");
  task.run("s-2", "family-project", "Shared two", "bob");
  task.run("s-3", "family-project", "Unassigned", null);
  task.run("p-1", "alice-private-project", "Alice child", null);
  task.run("p-2", "bob-private-project", "Bob child secret", null);
  task.run("o-1", "other-project", "Other child secret", "erin");
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
function req(fx, projectId, query = "", cookie = ownerCookie()) {
  return new Request(base + encodeURIComponent(projectId) + "/tasks" + query, {
    headers: { cookie, "x-forwarded-for": "10.9.0.1" },
  });
}
function get(fx, projectId, query = "", cookie = ownerCookie()) {
  return GET(req(fx, projectId, query, cookie), { params: Promise.resolve({ projectId }) });
}
async function ok(promise) {
  const response = await promise;
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}

test("owner, editor and viewer read all shared project children via inherited Area", async () => {
  const fx = fixture();
  const [alice, bob, carol, dave] = ["alice", "bob", "carol", "dave"].map(user => login(fx, user));
  for (const [cookie, mine] of [[alice, ["s-1"]], [bob, ["s-2"]], [carol, []]]) {
    const page = await ok(get(fx, "family-project", "", cookie));
    assert.deepEqual(page.project, {
      id: "family-project", title: "Family project", areaId: "family-area", areaKind: "shared",
    });
    assert.deepEqual(page.tasks.map(t => t.id), ["s-1", "s-2", "s-3"]);
    assert.deepEqual(page.tasks.filter(t => t.assignedToMe).map(t => t.id), mine);
    assert.ok(page.tasks.every(t => t.projectId === "family-project" &&
      t.areaId === "family-area" && t.effectiveAreaId === "family-area"));
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    assert.equal(JSON.stringify(page).includes("Bob private secret"), false);
  }
  const privateOwner = await ok(get(fx, "alice-private-project", "", ownerCookie()));
  assert.deepEqual(privateOwner.tasks.map(t => t.id), ["p-1"]);
  assert.ok(!("assignedToMe" in privateOwner.tasks[0]));
  for (const [projectId, cookie] of [
    ["family-project", dave], ["other-project", alice],
    ["bob-private-project", alice], ["alice-private-project", bob],
    ["missing", alice],
  ]) {
    const result = await get(fx, projectId, "", cookie);
    assert.equal(result.status, 404);
    assert.deepEqual(await result.json(), { error: "Not found" });
  }
});

test("signed pagination binds the exact project and stales after task or project changes", async () => {
  const fx = fixture();
  const cookie = login(fx, "bob");
  const page = await ok(get(fx, "family-project", "?limit=1", cookie));
  assert.deepEqual(page.tasks.map(t => t.id), ["s-1"]);
  assert.equal(page.hasMore, true);
  assert.match(page.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const next = await ok(get(fx, "family-project", "?limit=1&cursor=" + page.nextCursor, cookie));
  assert.deepEqual(next.tasks.map(t => t.id), ["s-2"]);
  assert.equal((await get(fx, "family-second", "?cursor=" + page.nextCursor, cookie)).status, 400);
  assert.equal((await get(fx, "family-project", "?cursor=" + page.nextCursor,
    login(fx, "alice"))).status, 400);
  const db = new DatabaseSync(fx.stage.databasePath);
  db.prepare("UPDATE tasks SET title='Updated' WHERE id='s-1'").run();
  assert.equal((await get(fx, "family-project", "?cursor=" + page.nextCursor, cookie)).status, 409);
  const fresh = await ok(get(fx, "family-project", "?limit=1", cookie));
  db.prepare("UPDATE projects SET title='New project title' WHERE id='family-project'").run();
  db.close();
  assert.equal((await get(fx, "family-project", "?cursor=" + fresh.nextCursor, cookie)).status, 409);
});

test("revoked membership fails closed and live release rejects stale snapshot", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const page = await ok(get(fx, "family-project", "?limit=1", bob));
  const read = await readProcess.readStagingAuthorizedProjectTasksInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice", sessionTokenHash: durable.hashTargetStagingSessionToken(
      bob.split("=")[1]),
  }, "family-project", 10, 0);
  assert.equal(read.ok, true);
  const db = new DatabaseSync(fx.stage.databasePath);
  // Revoke after the child snapshot. No protected task row may be released.
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-2'").run();
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  db.close();
  const identity = { kind: "session", tokenHash: durable.hashTargetStagingSessionToken(bob.split("=")[1]) };
  assert.equal(verifyStagingReadBeforeRelease(req(fx, "family-project", "", bob), identity,
    fx.store, "alice", read.page.linearization), "stale");
  assert.equal((await get(fx, "family-project", "?cursor=" + page.nextCursor, bob)).status, 404);
  assert.equal((await get(fx, "family-project", "", bob)).status, 404);
});

test("project child moved after the snapshot fails live membership check even without an ACL change", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const read = await readProcess.readStagingAuthorizedProjectTasksInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice", sessionTokenHash: tokenHash,
  }, "family-project", 10, 0);
  assert.equal(read.ok, true);
  const db = new DatabaseSync(fx.stage.databasePath);
  // Move one inherited child to a different project of the same Area; role
  // and policy_revision stay the same, so an Area-only check would miss it.
  db.prepare("UPDATE tasks SET project_id='family-second' WHERE id='s-3'").run();
  db.close();
  assert.equal(verifyStagingReadBeforeRelease(
    req(fx, "family-project", "", bob), { kind: "session", tokenHash },
    fx.store, "alice", read.page.linearization, {
      projectId: "family-project", areaId: "family-area",
      taskIds: read.page.tasks.map(task => task.id),
    },
  ), "stale");
  const current = await ok(get(fx, "family-project", "", bob));
  assert.deepEqual(current.tasks.map(task => task.id), ["s-1", "s-2"]);
});

test("project moved to an unreadable Area after snapshot cannot release inherited tasks", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const read = await readProcess.readStagingAuthorizedProjectTasksInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice", sessionTokenHash: tokenHash,
  }, "family-project", 10, 0);
  assert.equal(read?.ok, true);
  assert.equal(read.page.project.areaId, "family-area");
  assert.deepEqual(read.page.tasks.map(task => task.id), ["s-1", "s-2", "s-3"]);

  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  // R2 currently blocks project moves until the confirmed move command exists.
  // Simulate its eventual committed result ONLY in this isolated fixture:
  // temporarily lift the move guard, preserve its exact SQL and restore it
  // atomically. Unassign children first to preserve the destination Area ACL.
  const moveGuard = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='project_area_assignment_guard'")
    .get()?.sql;
  assert.equal(typeof moveGuard, "string");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE project_id='family-project'").run();
    db.exec("DROP TRIGGER project_area_assignment_guard");
    db.prepare("UPDATE projects SET area_id='other-area' WHERE id='family-project'").run();
    db.exec(moveGuard + ";");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }

  const guard = {
    projectId: "family-project", areaId: read.page.project.areaId,
    taskIds: read.page.tasks.map(task => task.id),
  };
  assert.equal(verifyStagingReadBeforeRelease(
    req(fx, "family-project", "", bob), { kind: "session", tokenHash },
    fx.store, "alice", read.page.linearization, guard,
  ), "stale");
  const denied = await get(fx, "family-project", "", bob);
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.deepEqual(await denied.json(), { error: "Not found" });
  // The new Area's legitimate member sees the project's current inherited tasks.
  const erin = await ok(get(fx, "family-project", "", login(fx, "erin")));
  assert.equal(erin.project.areaId, "other-area");
  assert.deepEqual(erin.tasks.map(task => task.id), ["s-1", "s-2", "s-3"]);
});

test("bad child DTOs, invalid params and disabled gate never expose project data", async () => {
  const fx = fixture();
  const good = await readProcess.readStagingAuthorizedProjectTasksInChild({
    stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration,
    ownerUserId: "alice",
  }, "family-project", 50, 0);
  assert.equal(good.ok, true);
  assert.equal(readProcess.parseStagingProjectTasks({
    ok: true, ...good.page,
    project: { ...good.page.project, secretMemberList: ["bob"] },
  }, "family-project"), null);
  assert.equal(readProcess.parseStagingProjectTasks({
    ok: true, ...good.page, tasks: good.page.tasks.map(t => ({ ...t, assigneeUserId: "alice" })),
  }, "family-project"), null);
  assert.equal(readProcess.parseStagingProjectTasks({
    ok: true, ...good.page, linearization: { actorUserId: "alice", areas: [] },
  }, "family-project"), null);
  for (const q of ["?actorUserId=bob", "?scope=shared", "?areaId=family-area",
    "?limit=0", "?limit=101", "?limit=1&limit=2", "?cursor=a.b&cursor=c.d", "?cursor=invalid"]) {
    assert.equal((await get(fx, "family-project", q)).status, 400, q);
  }
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  assert.equal((await get(fx, "family-project")).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
  assert.equal(readFileSync(path.join(legacy, "sentinel"), "utf8"), "legacy unchanged");
});
