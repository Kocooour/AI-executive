import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED", "AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
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
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const { GET } = await import("../app/api/target-staging/project-index/route.ts");
const { GET: GET_HOME } = await import("../app/api/target-staging/home/my-plan/route.ts");
const { GET: GET_SCOPED_HOME } = await import("../app/api/target-staging/home/summary/route.ts");
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

test("unaddressable project IDs are excluded before limit, offset and Area revisions", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys = ON");
  const insert = db.prepare("INSERT INTO projects(id, area_id, title) VALUES (?, ?, ?)");
  const badIds = [
    "", ".", "..",
    "a" + String.fromCharCode(0) + "nul",
    "b" + String.fromCharCode(1) + "control",
    "b" + String.fromCharCode(31) + "control",
    "c" + String.fromCharCode(127) + "del",
    "t".repeat(513),
  ];
  for (const id of badIds) insert.run(id, "family-area", "Not addressable");
  insert.run("aaa-first", "family-area", "Valid first");
  insert.run("zz-last", "family-area", "Valid last");

  // An Area containing only inaccessible project IDs must not contribute to
  // the cursor revision or its policy linearization.
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bad-only-ws','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('bad-only-area','Only invalid IDs','shared','bad-only-ws','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('bad-only-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('bad-only-area','bob','editor')").run();
  insert.run("x" + String.fromCharCode(0) + "invalid-only", "bad-only-area", "Hidden");

  const visible = [];
  let cursor = null;
  for (let i = 0; i < 4; i++) {
    const query = "?scope=shared&limit=1" + (cursor ? "&cursor=" + cursor : "");
    const page = await ok(get(fx, query, bob));
    assert.equal(page.projects.length, 1);
    visible.push(page.projects[0].id);
    if (i === 0) {
      // An Area that contributes no readable project must be irrelevant
      // even if its membership changes after the first page.
      db.prepare("DELETE FROM area_members WHERE area_id='bad-only-area' AND user_id='bob'").run();
    }
    cursor = page.nextCursor;
    assert.equal(page.hasMore, i < 3);
  }
  assert.equal(cursor, null);
  assert.deepEqual(visible, ["aaa-first", "family-project", "family-second", "zz-last"]);
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

test("my-plan projects include personal and only explicitly assigned shared projects", async () => {
  const fx = fixture();
  const [alice, bob, carol, dave, erin] = ["alice", "bob", "carol", "dave", "erin"]
    .map(name => login(fx, name));
  const a = await ok(get(fx, "?scope=my-plan", alice));
  assert.deepEqual(a.projects.map(p => [p.id, p.areaKind]), [
    ["alice-private-project", "private"], ["family-project", "shared"],
  ]);
  const b = await ok(get(fx, "?scope=my-plan", bob));
  assert.deepEqual(b.projects.map(p => [p.id, p.areaKind]), [
    ["bob-private-project", "private"], ["family-project", "shared"],
  ]);
  assert.deepEqual((await ok(get(fx, "?scope=my-plan", carol))).projects, [],
    "shared viewer never inherits my-plan from other people's assignments");
  assert.deepEqual((await ok(get(fx, "?scope=my-plan", dave))).projects, []);
  assert.deepEqual((await ok(get(fx, "?scope=my-plan", erin))).projects, [],
    "unassigned readable shared project belongs in shared, not in my-plan");
  assert.deepEqual((await ok(get(fx, "?scope=my-plan", ownerCookie()))).projects, a.projects);
  assert.equal(b.hasMore, false);
  assert.equal(b.nextCursor, null);
  for (const term of ["Unassigned", "Erin secret", "s-1", "assignee_user_id",
    "member", "policyRevision", "areaEpochs", "guardProjects"]) {
    assert.equal(JSON.stringify(b).includes(term), false, term);
  }
});

test("my-plan project cursors bind scope and actor, and detect new assignments", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const alice = login(fx, "alice");
  const first = await ok(get(fx, "?scope=my-plan&limit=1", bob));
  assert.deepEqual(first.projects.map(p => p.id), ["bob-private-project"]);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const second = await ok(get(fx, "?scope=my-plan&limit=1&cursor="+first.nextCursor, bob));
  assert.deepEqual(second.projects.map(p => p.id), ["family-project"]);
  assert.equal(second.nextCursor, null);
  assert.equal((await get(fx, "?scope=shared&cursor="+first.nextCursor, bob)).status, 400);
  assert.equal((await get(fx, "?scope=personal&cursor="+first.nextCursor, bob)).status, 400);
  assert.equal((await get(fx, "?scope=my-plan&cursor="+first.nextCursor, alice)).status, 400);

  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  // Neither a foreign project nor Bob's own private task-only mutation
  // changes which projects are in his plan. The live guard and cursor agree.
  db.prepare("UPDATE projects SET title='Other title' WHERE id='other-project'").run();
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('bob-new-task','bob-private','Local task')").run();
  assert.equal((await get(fx, "?scope=my-plan&limit=1&cursor="+first.nextCursor, bob)).status, 200);
  // The Area's assignment revision is part of the cursor, even when the
  // newly assigned project is well beyond the original first page.
  db.prepare("INSERT INTO tasks(id,project_id,title,assignee_user_id) VALUES ('s-new','family-second','Assigned to Bob','bob')").run();
  assert.equal((await get(fx, "?scope=my-plan&limit=1&cursor="+first.nextCursor, bob)).status, 409);
  const expanded = await ok(get(fx, "?scope=my-plan", bob));
  assert.deepEqual(expanded.projects.map(p => p.id),
    ["bob-private-project", "family-project", "family-second"]);
  db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='s-2'").run();
  db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='s-new'").run();
  const reduced = await ok(get(fx, "?scope=my-plan", bob));
  assert.deepEqual(reduced.projects.map(p => p.id), ["bob-private-project"]);
  const fullShared = await ok(get(fx, "?scope=shared", bob));
  assert.deepEqual(fullShared.projects.map(p=>p.id),["family-project","family-second"]);
  db.close();
});

test("my-plan live release rejects assignment loss even when project stays shared", async () => {
  const fx = fixture();
  const bob = login(fx, "bob");
  const tokenHash = durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const child = () => readProcess.readStagingAuthorizedProjectIndexInChild({
    ...fx.store, ownerUserId: "alice", sessionTokenHash: tokenHash,
  }, "my-plan", 1, 1);
  const snapshot = await child();
  assert.ok(snapshot);
  assert.deepEqual(snapshot.projects.map(p => p.id), ["family-project"]);
  assert.ok(snapshot.areaEpochs && snapshot.areaEpochs.length === 2);
  const release = () => verifyStagingReadBeforeRelease(req(fx, "?scope=my-plan", bob),
    { kind:"session", tokenHash }, fx.store, "alice", snapshot.linearization,
    undefined, { projects: snapshot.guardProjects,
      myPlan: { areas: snapshot.areaEpochs } });
  assert.equal(release(), "ok");
  const db = new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='s-2'").run();
  assert.equal(release(), "stale",
    "a shared project's removal from my-plan must fail live snapshot validation");
  // Reassigned to Bob still advances the Area epoch (ABA), so old data is stale.
  db.prepare("UPDATE tasks SET assignee_user_id='bob' WHERE id='s-2'").run();
  assert.equal(release(), "stale");
  db.close();
});

test("my-plan child DTO refuses forged viewer, mismatched project kind or Area epoch", async () => {
  const fx = fixture(), bob = login(fx, "bob");
  const good = await readProcess.readStagingAuthorizedProjectIndexInChild({
    ...fx.store, ownerUserId: "alice",
    sessionTokenHash: durable.hashTargetStagingSessionToken(bob.split("=")[1]),
  }, "my-plan", 2, 0);
  assert.ok(good && good.areaEpochs);
  const parse = page => readProcess.parseStagingAuthorizedProjectIndex({
    ok: true, ...page,
  }, "my-plan");
  assert.ok(parse(good));
  assert.equal(parse({ ...good, areaEpochs: good.areaEpochs.slice(0,1) }), null);
  assert.equal(parse({ ...good, areaEpochs: good.areaEpochs.map((x,i) =>
    i===0?{...x,contentRevision:-1}:x) }), null);
  assert.equal(parse({ ...good, projects: good.projects.map(p =>
    p.areaKind === "private" ? {...p,areaKind:"shared"} : p) }), null);
  assert.equal(parse({ ...good, linearization: {
    ...good.linearization,
    areas: good.linearization.areas.map(a => a.areaKind === "shared"
      ? {...a,access:"viewer"} : a),
  } }), null);
  assert.equal(readProcess.parseStagingAuthorizedProjectIndex({
    ok:true,...good,
  }, "shared"), null);
});

async function getHome(cookie) {
  const response = await GET_HOME(new Request(
    "http://localhost:3001/api/target-staging/home/my-plan",
    { headers: cookie ? { cookie, "x-forwarded-for":"10.9.0.4" } :
      { "x-forwarded-for":"10.9.0.4" } },
  ));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { status: response.status, body: await response.json() };
}
const zeros = () => ({ privateProjects: 0, assignedSharedProjects: 0,
  privateTasks: 0, assignedSharedTasks: 0 });
const flags = () => Object.fromEntries(Object.keys(zeros()).map(k=>[k,false]));

test("Home My Plan inventory counts isolate current owner, editor and viewer", async () => {
  const fx = fixture();
  const [alice,bob,carol,dave,erin] =
    ["alice","bob","carol","dave","erin"].map(id=>login(fx,id));
  const owner = await getHome(ownerCookie());
  assert.equal(owner.status,200,JSON.stringify(owner.body));
  assert.deepEqual(owner.body,{ counts: {...zeros(),privateProjects:1,
    assignedSharedProjects:1,assignedSharedTasks:1},truncated:flags() });
  const b = await getHome(bob);
  assert.deepEqual(b.body, { counts: {...zeros(),privateProjects:1,
    assignedSharedProjects:1,assignedSharedTasks:1},truncated:flags() });
  for(const token of [carol,dave,erin]) {
    assert.deepEqual(await getHome(token),{status:200,body:{
      counts: zeros(),truncated:flags(),
    }});
  }
  assert.deepEqual(await getHome(alice),owner);
  for(const term of ["Family project","alice","bob","family-area","member",
    "areaEpochs","linearization","policyRevision","actorUserId","taskId"]) {
    assert.equal(JSON.stringify(owner.body).includes(term),false,term);
  }
  assert.deepEqual(Object.keys(owner.body).sort(),["counts","truncated"]);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('local-bob','bob-private','Personal Bob task')").run();
  db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES ('standalone-assigned','family-area','Assigned shared','bob')").run();
  const now=await getHome(bob);
  assert.deepEqual(now.body.counts,{...zeros(),privateProjects:1,
    assignedSharedProjects:1,privateTasks:1,assignedSharedTasks:2});
  db.close();
});

test("Home summary is default-off, refuses forged params and revoked sessions",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED="false";
  assert.equal((await getHome(bob)).status,404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED="true";
  assert.equal((await getHome(null)).status,401);
  const request=new Request("http://localhost:3001/api/target-staging/home/my-plan?actor=alice",
    {headers:{cookie:bob}});
  const bad=await GET_HOME(request);
  assert.equal(bad.status,400);
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live=durable.verifyDurableTargetStagingSessionLive(fx.store,tokenHash);
  assert.equal(live.ok,true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,live.sessionId).ok,true);
  assert.equal((await getHome(bob)).status,401);
});

test("Home summary live release invalidates assignment, new Area and revocation",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const config={...fx.store,ownerUserId:"alice",sessionTokenHash:tokenHash};
  const read=()=>readProcess.readStagingMyPlanHomeSummaryInChild(config);
  const snapshot=await read();
  assert.ok(snapshot && snapshot.areaEpochs.length>0);
  const identity={kind:"session",tokenHash};
  const req=new Request("http://localhost/api/target-staging/home/my-plan",
    {headers:{cookie:bob}});
  const release=(s)=>verifyStagingReadBeforeRelease(req,identity,fx.store,"alice",
    s.linearization,undefined,undefined,undefined,undefined,undefined,
    {areas:s.areaEpochs});
  assert.equal(release(snapshot),"ok");
  const db=new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='s-2'").run();
  assert.equal(release(snapshot),"stale","removed assignment must stale old counter");
  const second=await read();
  assert.ok(second);
  assert.equal(release(second),"ok");
  // Newly authorized Area was absent in second's snapshot, including when
  // it has not yet contributed a task to My Plan.
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('new-team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('new-team-area','New team','shared','new-team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-team-area','bob','editor')").run();
  assert.equal(release(second),"stale","newly accessible Area must stale old summary");
  const third=await read();
  assert.ok(third);
  assert.equal(release(third),"ok");
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.equal(release(third),"stale","revoked ACL must suppress summary");
  db.close();
});

test("Home summary strictly parses child envelope and count bounds",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const good=await readProcess.readStagingMyPlanHomeSummaryInChild({
    ...fx.store,ownerUserId:"alice",
    sessionTokenHash:durable.hashTargetStagingSessionToken(bob.split("=")[1]),
  });
  assert.ok(good);
  const parse=(data)=>readProcess.parseStagingMyPlanHomeSummary({ok:true,...data});
  assert.ok(parse(good));
  assert.equal(parse({...good,secret:"private"}),null);
  assert.equal(parse({...good,counts:{...good.counts,privateTasks:-1}}),null);
  assert.equal(parse({...good,counts:{...good.counts,privateTasks:1001}}),null);
  assert.equal(parse({...good,truncated:{...good.truncated,privateTasks:true}}),null);
  assert.equal(parse({...good,areaEpochs:[...good.areaEpochs,good.areaEpochs[0]]}),null);
  assert.equal(parse({...good,areaEpochs:good.areaEpochs.map((a,i)=>
    i===0?{...a,contentRevision:-1}:a)}),null);
  assert.equal(parse({...good,linearization:{...good.linearization,areas:[]}}),null);
});

test("Home capped counts report lower bounds instead of unbounded totals",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const db=new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  const stmt=db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,'bob-private','Task')");
  db.exec("BEGIN IMMEDIATE");
  try {
    for(let i=0;i<1002;i++)stmt.run("cap-task-"+i);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK");throw e; }
  db.close();
  const result=await getHome(bob);
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.counts.privateTasks,1000);
  assert.equal(result.body.truncated.privateTasks,true);
  assert.equal(result.body.truncated.assignedSharedTasks,false);
});


async function scopedHome(cookie, query = "?scope=my-plan") {
  const response = await GET_SCOPED_HOME(new Request(
    "http://localhost:3001/api/target-staging/home/summary" + query,
    { headers: cookie ? { cookie, "x-forwarded-for": "10.9.0.5" } :
      { "x-forwarded-for": "10.9.0.5" } },
  ));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { status: response.status, body: await response.json() };
}
const scopedValues = (projects, tasks) => ({
  counts: { projects, tasks }, truncated: { projects: false, tasks: false },
});

test("scoped Home inventories respect private, shared viewer and my-plan assignment", async () => {
  const fx = fixture();
  const [alice,bob,carol,dave,erin] =
    ["alice","bob","carol","dave","erin"].map(id=>login(fx,id));
  for (const [cookie,personal,shared,plan] of [
    [alice,[1,0],[2,3],[2,1]],
    [bob,[1,0],[2,3],[2,1]],
    [carol,[0,0],[2,3],[0,0]],
    [dave,[0,0],[0,0],[0,0]],
    [erin,[0,0],[1,0],[0,0]],
  ]) {
    for (const [scope,totals] of [
      ["personal",personal],["shared",shared],["my-plan",plan],
    ]) {
      const result=await scopedHome(cookie,"?scope="+scope);
      assert.deepEqual(result,{status:200,body:{
        scope,...scopedValues(...totals),
      }},scope);
      for (const needle of ["alice-private-project","bob-private-project",
        "family-area","family-project","s-1","member","policyRevision",
        "areaEpochs","linearization","actorUserId"]) {
        assert.equal(JSON.stringify(result.body).includes(needle),false,needle);
      }
    }
  }
  assert.deepEqual((await scopedHome(ownerCookie(), "?scope=my-plan")).body,
    {scope:"my-plan",...scopedValues(2,1)});
  assert.deepEqual((await scopedHome(bob,"")).body,
    {scope:"my-plan",...scopedValues(2,1)});
  // A standalone private task belongs to Personal and My Plan, but not Shared.
  const db=new DatabaseSync(fx.stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('bob-local','bob-private','Private')").run();
  assert.deepEqual((await scopedHome(bob,"?scope=personal")).body.counts,{projects:1,tasks:1});
  assert.deepEqual((await scopedHome(bob,"?scope=my-plan")).body.counts,{projects:2,tasks:2});
  assert.deepEqual((await scopedHome(bob,"?scope=shared")).body.counts,{projects:2,tasks:3});
  db.close();
});

test("scoped Home is flag-gated, refuses forged selectors and revoked sessions",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED="false";
  assert.equal((await scopedHome(bob)).status,404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED="true";
  assert.equal((await scopedHome(null)).status,401);
  for (const query of ["?scope=other","?scope=personal&scope=shared",
    "?actorUserId=alice","?scope=shared&areaId=family-area",
    "?scope=shared&limit=100"]) {
    assert.equal((await scopedHome(bob,query)).status,400,query);
  }
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const live=durable.verifyDurableTargetStagingSessionLive(fx.store,tokenHash);
  assert.equal(live.ok,true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,live.sessionId).ok,true);
  assert.equal((await scopedHome(bob,"?scope=shared")).status,401);
});

test("scoped Home live guard covers newly granted Areas, ACL role and task epoch",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split("=")[1]);
  const config={...fx.store,ownerUserId:"alice",sessionTokenHash:tokenHash};
  const snapshot=await readProcess.readStagingScopedHomeSummaryInChild(config,"shared");
  assert.ok(snapshot);
  assert.deepEqual(snapshot.counts,{projects:2,tasks:3});
  const request=new Request("http://localhost/api/target-staging/home/summary?scope=shared",
    {headers:{cookie:bob}});
  const live=(value)=>verifyStagingReadBeforeRelease(
    request,{kind:"session",tokenHash},fx.store,"alice",value.linearization,
    undefined,undefined,undefined,undefined,undefined,
    {scope:"shared",areas:value.areaEpochs});
  assert.equal(live(snapshot),"ok");
  const db=new DatabaseSync(fx.stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  // Assignments do not affect total Shared work, but content epochs must
  // still fence a page assembled on a prior staging snapshot.
  db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='s-2'").run();
  assert.equal(live(snapshot),"stale");
  const second=await readProcess.readStagingScopedHomeSummaryInChild(config,"shared");
  assert.ok(second);assert.equal(live(second),"ok");
  // Newly permitted Areas must invalidate the old aggregate even when empty.
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('new-shared','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('new-shared-area','New','shared','new-shared','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-shared-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('new-shared-area','bob','viewer')").run();
  assert.equal(live(second),"stale");
  const third=await readProcess.readStagingScopedHomeSummaryInChild(config,"shared");
  assert.ok(third);assert.equal(live(third),"ok");
  db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.equal(live(third),"stale");
  db.close();
});

test("scoped Home child DTO rejects forged scope, viewer in My Plan, extra fields",async()=>{
  const fx=fixture(),carol=login(fx,"carol");
  const config={...fx.store,ownerUserId:"alice",
    sessionTokenHash:durable.hashTargetStagingSessionToken(carol.split("=")[1])};
  const good=await readProcess.readStagingScopedHomeSummaryInChild(config,"shared");
  assert.ok(good && good.areaEpochs.some(a=>a.access==="viewer"));
  const parse=(value,scope="shared")=>
    readProcess.parseStagingScopedHomeSummary({ok:true,...value},scope);
  assert.ok(parse(good));
  assert.equal(parse(good,"my-plan"),null);
  assert.equal(parse({...good,hidden:"private"}),null);
  assert.equal(parse({...good,counts:{...good.counts,tasks:-1}}),null);
  assert.equal(parse({...good,counts:{...good.counts,tasks:1001}}),null);
  assert.equal(parse({...good,truncated:{...good.truncated,projects:true}}),null);
  assert.equal(parse({...good,areaEpochs:[...good.areaEpochs,good.areaEpochs[0]]}),null);
  assert.equal(parse({...good,areaEpochs:good.areaEpochs.map((a,i)=>
    i===0?{...a,access:"private-owner"}:a)}),null);
  assert.equal(parse({...good,linearization:{...good.linearization,areas:[]}}),null);
});

test("scoped Home caps large totals and marks truncated, existing Home remains usable",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const db=new DatabaseSync(fx.stage.databasePath);db.exec("PRAGMA foreign_keys=ON");
  const insert=db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,'bob-private','Synthetic')");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i=0;i<1002;i++)insert.run("scoped-cap-"+i);
    db.exec("COMMIT");
  }catch(e){db.exec("ROLLBACK");throw e;}
  db.close();
  const personal=await scopedHome(bob,"?scope=personal");
  assert.equal(personal.status,200,JSON.stringify(personal.body));
  assert.deepEqual(personal.body,{scope:"personal",
    counts:{projects:1,tasks:1000},
    truncated:{projects:false,tasks:true}});
  const old=await getHome(bob);
  assert.equal(old.status,200);
  assert.equal(old.body.counts.privateTasks,1000);
  assert.equal(old.body.truncated.privateTasks,true);
});
