import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2-ID.2b: shared / my-plan reads and the read linearization point.
// Synthetic data in temp dirs only; membership changes are raw SQL in a separate process.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2id2b-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
const REAL_NODE = process.execPath;
const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY", "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const old = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
  ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-r2id2b-session-secret-2026-10-29";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const identityLib = await import("../lib/target-staging-http-identity.ts");
const readProcess = await import("../lib/target-staging-read-process.ts");
const cursorLib = await import("../lib/target-staging-http-cursor.ts");
const { GET: LIST } = await import("../app/api/target-staging/tasks/route.ts");
const { GET: DETAIL } = await import("../app/api/target-staging/tasks/[taskId]/route.ts");

after(() => {
  process.execPath = REAL_NODE;
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const base = "http://localhost:3001/api/target-staging/";
let counter = 0;

/**
 * Identities: alice (A, admin of family-area, store owner), bob (B, editor), carol (C, viewer),
 * dave (member of nothing), erin (admin of the unrelated other-area).
 */
function makeFixture() {
  const name = `fx${++counter}`;
  const stage = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, name), ownerUserId: "alice",
  });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const user of ["bob", "carol", "dave", "erin"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)")
      .run(`${user}-personal`, user);
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
      VALUES (?, ?, 'private', ?, ?, 'unassigned')`).run(`${user}-private`, `${user} private`, `${user}-personal`, user);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('other','shared','erin')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('other-area','Other','shared','other','erin')").run();
  const member = db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)");
  member.run("family-area", "alice", "admin");
  member.run("family-area", "bob", "editor");
  member.run("family-area", "carol", "viewer");
  member.run("other-area", "erin", "admin");
  const task = db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?,?,?,?)");
  task.run("f-1", "family-area", "Family one", "alice");
  task.run("f-2", "family-area", "Family two", "bob");
  task.run("f-3", "family-area", "Family three", null);
  task.run("f-4", "family-area", "Family four", "alice");
  task.run("f-5", "family-area", "Family five", "bob");
  task.run("o-1", "other-area", "Other one", "erin");
  task.run("o-2", "other-area", "Other two", null);
  task.run("p-alice-1", stage.unassignedAreaId, "Alice private one", null);
  task.run("p-alice-2", stage.unassignedAreaId, "Alice private two", null);
  task.run("p-bob-1", "bob-private", "Bob private one", null);
  task.run("p-carol-1", "carol-private", "Carol private one", null);
  task.run("p-dave-1", "dave-private", "Dave private one", null);
  db.close();
  const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
  const fixture = { name, stage, store, databasePath: stage.databasePath, client: `10.2.0.${counter}` };
  activate(fixture);
  return fixture;
}

function activate(fixture) {
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = fixture.stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fixture.stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
}

/** Raw SQL in a SEPARATE process, as an operator or the parallel membership command would. */
function mutate(fixture, sql) {
  const run = spawnSync(REAL_NODE, ["-e",
    `const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(process.argv[1]);
     db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
     db.exec(process.argv[2]); db.close();`,
    fixture.databasePath, sql], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}
/** Remove a member; their assigned tasks must be unassigned first (existing guard triggers). */
const removeMemberSql = (user, area = "family-area") => `BEGIN;
  UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='${user}' AND area_id='${area}';
  DELETE FROM area_members WHERE area_id='${area}' AND user_id='${user}'; COMMIT;`;
const changeRoleSql = (user, role, area = "family-area") => `BEGIN;
  UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='${user}' AND area_id='${area}';
  UPDATE area_members SET role='${role}' WHERE area_id='${area}' AND user_id='${user}'; COMMIT;`;

const sessionCookie = token => `${durable.TARGET_STAGING_SESSION_COOKIE}=${token}`;
function login(fixture, user) {
  const issued = durable.issueDurableTargetStagingSession(fixture.store, user, 900);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return { ...issued, cookie: sessionCookie(issued.sessionToken), user };
}
const ownerCookie = () => `${sessionCookieName}=${createSessionToken()}`;
const get = (fixture, handler, pathname, cookie, context) =>
  handler(new Request(base + pathname, {
    headers: { cookie, "x-forwarded-for": fixture.client },
  }), context);
const list = (fixture, query, cookie) => get(fixture, LIST, "tasks" + query, cookie);
const detail = (fixture, taskId, cookie) =>
  get(fixture, DETAIL, "tasks/" + taskId, cookie, { params: Promise.resolve({ taskId }) });
const ids = body => body.tasks.map(task => task.id);

test("scope contents follow LUMI-FR-013 for admin A, editor B and viewer C", async () => {
  const fx = makeFixture();
  const [a, b, c] = ["alice", "bob", "carol"].map(user => login(fx, user));
  const family = ["f-1", "f-2", "f-3", "f-4", "f-5"];

  // Sdilene: ALL tasks of the shared Area incl. unassigned and other members' tasks.
  for (const who of [a, b, c]) {
    const response = await list(fx, "?scope=shared", who.cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(ids(body), family, who.user);
    assert.equal(body.hasMore, false);
    for (const task of body.tasks) {
      assert.deepEqual(Object.keys(task).sort(),
        ["areaId", "areaKind", "assignedToMe", "effectiveAreaId", "id", "projectId", "title"]);
      assert.equal(task.areaId, "family-area");
      assert.equal(task.areaKind, "shared");
      assert.equal(typeof task.assignedToMe, "boolean");
    }
    const mine = body.tasks.filter(task => task.assignedToMe).map(task => task.id);
    assert.deepEqual(mine, who.user === "alice" ? ["f-1", "f-4"] : who.user === "bob" ? ["f-2", "f-5"] : []);
    // Never other users' ids, member lists or counts; never another Area's content.
    const text = JSON.stringify(body);
    for (const leaked of ["alice", "bob", "carol", "dave", "erin", "assignee", "member", "Other one", "private"]) {
      assert.equal(text.toLowerCase().includes(leaked.toLowerCase()), false, `${who.user} leaked ${leaked}`);
    }
  }

  // Muj plan: all my private tasks + shared tasks assigned to me; a viewer cannot be assigned.
  const planA = await (await list(fx, "?scope=my-plan", a.cookie)).json();
  assert.deepEqual(ids(planA), ["f-1", "f-4", "p-alice-1", "p-alice-2"]);
  assert.deepEqual(planA.tasks.filter(t => t.areaKind === "private").map(t => "assignedToMe" in t),
    [false, false], "private rows carry no assignedToMe");
  assert.ok(planA.tasks.filter(t => t.areaKind === "shared").every(t => t.assignedToMe === true));
  assert.deepEqual(ids(await (await list(fx, "?scope=my-plan", b.cookie)).json()), ["f-2", "f-5", "p-bob-1"]);
  assert.deepEqual(ids(await (await list(fx, "?scope=my-plan", c.cookie)).json()), ["p-carol-1"]);

  // The default and explicit personal scope keep the historical shape and content.
  const implicit = await (await list(fx, "", a.cookie)).json();
  const explicit = await (await list(fx, "?scope=personal", a.cookie)).json();
  assert.deepEqual(implicit, explicit);
  assert.deepEqual(ids(implicit), ["p-alice-1", "p-alice-2"]);
  assert.deepEqual(Object.keys(implicit.tasks[0]).sort(),
    ["areaKind", "assigneeUserId", "effectiveAreaId", "id", "projectId", "title"]);

  // The owner cookie maps to the configured owner (alice) and gets the same views.
  assert.deepEqual(await (await list(fx, "?scope=shared", ownerCookie())).json(),
    await (await list(fx, "?scope=shared", a.cookie)).json());
  assert.deepEqual(ids(await (await list(fx, "?scope=my-plan", ownerCookie())).json()),
    ["f-1", "f-4", "p-alice-1", "p-alice-2"]);
});

test("a non-member gets nothing from shared / my-plan and an indistinguishable 404 on detail", async () => {
  const fx = makeFixture();
  const dave = login(fx, "dave");
  const shared = await (await list(fx, "?scope=shared", dave.cookie)).json();
  assert.deepEqual(shared, { tasks: [], hasMore: false, nextCursor: null });
  assert.deepEqual(ids(await (await list(fx, "?scope=my-plan", dave.cookie)).json()), ["p-dave-1"]);

  const bodies = [];
  for (const taskId of ["f-1", "f-3", "o-1", "p-alice-1", "p-bob-1", "no-such-task"]) {
    const response = await detail(fx, taskId, dave.cookie);
    assert.equal(response.status, 404, taskId);
    assert.equal(response.headers.get("cache-control"), "no-store");
    bodies.push(JSON.stringify(await response.json()));
  }
  assert.equal(new Set(bodies).size, 1);
  assert.equal(bodies[0], JSON.stringify({ error: "Not found" }));
});

test("detail: any current member reads a shared task with the minimal shape; private-foreign stays 404", async () => {
  const fx = makeFixture();
  const [a, b, c] = ["alice", "bob", "carol"].map(user => login(fx, user));
  const expected = (assignedToMe, id = "f-3", title = "Family three") => ({ task: {
    id, title, projectId: null, effectiveAreaId: "family-area", areaId: "family-area",
    areaKind: "shared", assignedToMe,
  } });
  for (const who of [a, b, c]) {
    const response = await detail(fx, "f-3", who.cookie);
    assert.equal(response.status, 200, who.user);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), expected(false), "no snapshotRevision / CAS for shared tasks");
  }
  assert.deepEqual(await (await detail(fx, "f-1", a.cookie)).json(), expected(true, "f-1", "Family one"));
  assert.deepEqual(await (await detail(fx, "f-1", b.cookie)).json(), expected(false, "f-1", "Family one"));
  // Another Area, someone else's private task and unknown ids are all the same 404.
  for (const [who, taskId] of [[a, "o-1"], [b, "p-alice-1"], [c, "p-bob-1"], [a, "absent"]]) {
    const response = await detail(fx, taskId, who.cookie);
    assert.equal(response.status, 404, taskId);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  // A private task keeps its legacy shape including the title CAS revision.
  const own = await (await detail(fx, "p-alice-1", a.cookie)).json();
  assert.match(own.snapshotRevision, /^[a-f0-9]{64}$/);
  assert.equal(own.task.areaKind, "private");
});

test("cursors are bound to the scope and to the session", async () => {
  const fx = makeFixture();
  const a = login(fx, "alice");
  const b = login(fx, "bob");
  const cursorOf = async (cookie, query) => (await (await list(fx, query, cookie)).json()).nextCursor;
  const personal = await cursorOf(a.cookie, "?limit=1");
  const shared = await cursorOf(a.cookie, "?scope=shared&limit=2");
  const plan = await cursorOf(a.cookie, "?scope=my-plan&limit=2");
  assert.ok(personal && shared && plan);
  const status = async (query, cursor, cookie = a.cookie) =>
    (await list(fx, `${query}${query.includes("?") ? "&" : "?"}cursor=${cursor}`, cookie)).status;
  assert.equal(await status("?scope=shared&limit=2", shared), 200);
  assert.equal(await status("?scope=my-plan&limit=2", plan), 200);
  assert.equal(await status("?limit=1", personal), 200);
  // Cross-scope reuse of every kind is a 400, not a stale answer or data.
  assert.equal(await status("?scope=shared&limit=2", personal), 400);
  assert.equal(await status("?scope=shared&limit=2", plan), 400);
  assert.equal(await status("?scope=my-plan&limit=2", shared), 400);
  assert.equal(await status("?limit=1", shared), 400);
  assert.equal(await status("?scope=personal&limit=1", plan), 400);
  // ... and across identities.
  assert.equal(await status("?scope=shared&limit=2", shared, b.cookie), 400);
  assert.equal(await status("?scope=shared&limit=2", shared, ownerCookie()), 400);
  // Claim-level proof: the same revision/offset signed for another scope never verifies.
  const context = {
    actorUserId: "staging-session", restoreGeneration: fx.stage.restoreGeneration,
    stagingDirectory: fx.stage.directory, authenticationBinding: "x".repeat(43),
    sessionSecret: process.env.AI_EXECUTIVE_SESSION_SECRET,
  };
  const token = cursorLib.signStagingHttpCursor({ ...context, scope: "shared" }, "a".repeat(64), 2);
  assert.equal(cursorLib.verifyStagingHttpCursor({ ...context, scope: "shared" }, token).ok, true);
  for (const scope of [undefined, "personal", "my-plan"]) {
    assert.equal(cursorLib.verifyStagingHttpCursor({ ...context, scope }, token).ok, false, String(scope));
  }

  // Walking pages reaches every row exactly once.
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const body = await (await list(fx, `?scope=shared&limit=2${cursor ? "&cursor=" + cursor : ""}`, a.cookie)).json();
    seen.push(...ids(body));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["f-1", "f-2", "f-3", "f-4", "f-5"]);
});

test("revision isolation: changes in Areas the actor cannot see never stale a cursor", async () => {
  const fx = makeFixture();
  const a = login(fx, "alice");
  const first = await (await list(fx, "?scope=shared&limit=2", a.cookie)).json();
  const next = `?scope=shared&limit=2&cursor=${first.nextCursor}`;
  // Titles, assignment, membership (policy_revision) and tasks of an unrelated Area and of
  // other users' private Areas; plus a brand-new member of that unrelated Area.
  mutate(fx, `UPDATE tasks SET title='Changed elsewhere' WHERE id IN ('o-1','p-bob-1');
    INSERT INTO tasks(id,area_id,title) VALUES ('o-3','other-area','New elsewhere');
    INSERT INTO area_members(area_id,user_id,role) VALUES ('other-area','dave','viewer');
    UPDATE area_members SET role='editor' WHERE area_id='other-area' AND user_id='dave';`);
  assert.equal((await list(fx, next, a.cookie)).status, 200);
  const plan = await (await list(fx, "?scope=my-plan&limit=2", a.cookie)).json();
  mutate(fx, "UPDATE tasks SET title='Changed again' WHERE id IN ('o-2','p-carol-1')");
  assert.equal((await list(fx, `?scope=my-plan&limit=2&cursor=${plan.nextCursor}`, a.cookie)).status, 200);

  // A visible change, or a policy change in a contributing Area, does stale it.
  mutate(fx, "UPDATE tasks SET title='Visible change' WHERE id='f-5'");
  const stale = await list(fx, next, a.cookie);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "Cursor stale" });
  const fresh = await (await list(fx, "?scope=shared&limit=2", a.cookie)).json();
  mutate(fx, "INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','dave','viewer')");
  const afterPolicy = await list(fx, `?scope=shared&limit=2&cursor=${fresh.nextCursor}`, a.cookie);
  assert.equal(afterPolicy.status, 409);
  assert.deepEqual(await afterPolicy.json(), { error: "Cursor stale" });
});

// --- deterministic read-linearization barrier ---------------------------------------------
// The route awaits a short-lived child. Replacing process.execPath with a wrapper makes
// "child read finished" an observable, controllable event: the wrapper runs the real child to
// completion, signals <gate>/done, then holds the buffered output until <gate>/go exists.
let gateCounter = 0;
async function withGatedChild(run, between) {
  const gate = path.join(root, `gate-${++gateCounter}`);
  mkdirSync(gate);
  const script = path.join(gate, "node-wrapper.sh");
  writeFileSync(script, `#!/bin/sh
PATH=/usr/bin:/bin
out=$("${REAL_NODE}" "$@")
code=$?
: > "${gate}/done"
while [ ! -e "${gate}/go" ]; do sleep 0.02; done
printf '%s' "$out"
exit $code
`);
  chmodSync(script, 0o755);
  process.execPath = script;
  try {
    const pending = run();
    for (let waited = 0; !existsSync(path.join(gate, "done")); waited += 20) {
      assert.ok(waited < 30_000, "gated child never finished");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await between();               // the child's snapshot read is DONE; nothing released yet
    writeFileSync(path.join(gate, "go"), "");
    return await pending;
  } finally {
    process.execPath = REAL_NODE;
  }
}

test("barrier: membership removed after the child read -> list 409 read_stale_reload (shared and my-plan)", async () => {
  for (const scope of ["shared", "my-plan"]) {
    const fx = makeFixture();
    const b = login(fx, "bob");
    const response = await withGatedChild(
      () => list(fx, `?scope=${scope}`, b.cookie),
      async () => mutate(fx, removeMemberSql("bob")));
    assert.equal(response.status, 409, scope);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: "read_stale_reload" });
    assert.equal(text.includes("Family"), false, "no row content in a stale answer");
    // The change applies to the NEXT request: bob now sees no shared tasks, only his private ones.
    const next = await (await list(fx, `?scope=${scope}`, b.cookie)).json();
    assert.deepEqual(ids(next), scope === "shared" ? [] : ["p-bob-1"]);
  }
});

test("barrier: role change after the child read -> list 409 read_stale_reload, detail 404", async () => {
  const fx = makeFixture();
  const b = login(fx, "bob");
  const response = await withGatedChild(
    () => list(fx, "?scope=my-plan", b.cookie),
    async () => mutate(fx, changeRoleSql("bob", "viewer")));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "read_stale_reload" });
  // Viewer after the change: my-plan no longer lists shared tasks (not assignable), shared still readable.
  assert.deepEqual(ids(await (await list(fx, "?scope=my-plan", b.cookie)).json()), ["p-bob-1"]);
  assert.deepEqual(ids(await (await list(fx, "?scope=shared", b.cookie)).json()),
    ["f-1", "f-2", "f-3", "f-4", "f-5"]);

  const c = login(fx, "carol");
  const upgraded = await withGatedChild(
    () => detail(fx, "f-3", c.cookie),
    async () => mutate(fx, changeRoleSql("carol", "editor")));
  assert.equal(upgraded.status, 404);
  assert.equal(upgraded.headers.get("cache-control"), "no-store");
  assert.deepEqual(await upgraded.json(), { error: "Not found" });
  assert.equal((await detail(fx, "f-3", c.cookie)).status, 200, "the next request sees the new role");
});

test("barrier: membership removed after the child read -> shared detail 404 (session and owner cookie)", async () => {
  const fx = makeFixture();
  const c = login(fx, "carol");
  const response = await withGatedChild(
    () => detail(fx, "f-3", c.cookie),
    async () => mutate(fx, removeMemberSql("carol")));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "Not found" });
  assert.equal((await detail(fx, "f-3", c.cookie)).status, 404);

  // The owner-cookie identity (alice) gets the same Area check.
  const fx2 = makeFixture();
  // A shared Area must keep an admin member to pass preflight: promote bob before alice leaves.
  mutate(fx2, "UPDATE area_members SET role='admin' WHERE area_id='family-area' AND user_id='bob'");
  const owner = ownerCookie();
  const stale = await withGatedChild(
    () => list(fx2, "?scope=shared", owner),
    async () => mutate(fx2, removeMemberSql("alice")));
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "read_stale_reload" });
  // Owner-cookie DETAIL: a real membership removal committed while the child output is held.
  const fx3 = makeFixture();
  mutate(fx3, "UPDATE area_members SET role='admin' WHERE area_id='family-area' AND user_id='bob'");
  assert.equal((await detail(fx3, "f-3", owner)).status, 200);
  const staleDetail = await withGatedChild(
    () => detail(fx3, "f-3", owner),
    async () => mutate(fx3, removeMemberSql("alice")));
  assert.equal(staleDetail.status, 404, "alice is no longer a member");
  assert.deepEqual(await staleDetail.json(), { error: "Not found" });
});

test("barrier: a change committed after the check applies to the next request only", async () => {
  const fx = makeFixture();
  const b = login(fx, "bob");
  // The release check passes, the body is released ...
  const released = await withGatedChild(
    () => list(fx, "?scope=shared", b.cookie), async () => {});
  assert.equal(released.status, 200);
  assert.deepEqual(ids(await released.json()), ["f-1", "f-2", "f-3", "f-4", "f-5"]);
  // ... a change committed after that is not retro-actively applied, but the next request sees it.
  mutate(fx, removeMemberSql("bob"));
  assert.deepEqual(ids(await (await list(fx, "?scope=shared", b.cookie)).json()), []);
  assert.equal((await detail(fx, "f-3", b.cookie)).status, 404);

  // An unrelated Area change between read and release does NOT produce read_stale_reload.
  const fx2 = makeFixture();
  mutate(fx2, "UPDATE area_members SET role='admin' WHERE area_id='family-area' AND user_id='bob'");
  const a = login(fx2, "alice");
  const ok = await withGatedChild(
    () => list(fx2, "?scope=shared", a.cookie),
    async () => mutate(fx2, "INSERT INTO area_members(area_id,user_id,role) VALUES ('other-area','dave','editor')"));
  assert.equal(ok.status, 200);
  // The personal scope is unchanged by shared membership churn: no linearization data, no 409.
  const personal = await withGatedChild(
    () => list(fx2, "", a.cookie),
    async () => mutate(fx2, removeMemberSql("alice")));
  assert.equal(personal.status, 200);
  assert.deepEqual(ids(await personal.json()), ["p-alice-1", "p-alice-2"]);
});

test("barrier: concurrent session revocation and membership removal -> 401, no data", async () => {
  for (const [label, run] of [
    ["shared", fx => b => list(fx, "?scope=shared", b.cookie)],
    ["my-plan", fx => b => list(fx, "?scope=my-plan", b.cookie)],
    ["detail", fx => b => detail(fx, "f-3", b.cookie)],
  ]) {
    const fx = makeFixture();
    const b = login(fx, "bob");
    const response = await withGatedChild(() => run(fx)(b), async () => {
      mutate(fx, removeMemberSql("bob"));
      assert.equal(durable.revokeDurableTargetStagingSession(fx.store, b.sessionId).ok, true);
    });
    assert.equal(response.status, 401, label);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Authentication required" });
  }
  // Sign-out-everywhere (epoch bump) is observed by the same combined transaction.
  const fx = makeFixture();
  const c = login(fx, "carol");
  const response = await withGatedChild(
    () => list(fx, "?scope=shared", c.cookie),
    async () => {
      mutate(fx, removeMemberSql("carol"));
      assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "carol").ok, true);
    });
  assert.equal(response.status, 401);
});

test("the release primitive: session first, then every contributing Area, in one live check", async () => {
  const fx = makeFixture();
  const b = login(fx, "bob");
  const request = new Request(base + "tasks?scope=shared", { headers: { cookie: b.cookie } });
  const identity = identityLib.resolveStagingHttpIdentity(request);
  const config = { ...fx.store, ownerUserId: "alice", ...identityLib.stagingChildSessionConfig(identity) };
  const page = await readProcess.readStagingScopedPageInChild(config, "my-plan", 50, 0);
  assert.deepEqual(page.tasks.map(task => task.id), ["f-2", "f-5", "p-bob-1"]);
  assert.equal(page.linearization.actorUserId, "bob");
  assert.deepEqual(page.linearization.areas.map(area => [area.areaId, area.access]).sort(),
    [["bob-private", "private-owner"], ["family-area", "editor"]]);
  const check = () => identityLib.verifyStagingReadBeforeRelease(request, identity, fx.store, "alice", page.linearization);
  assert.equal(check(), "ok");
  // Wrong restore generation -> unavailable (fail closed), never "ok".
  assert.equal(identityLib.verifyStagingReadBeforeRelease(request, identity,
    { ...fx.store, expectedRestoreGeneration: "00000000-0000-4000-8000-000000000000" },
    "alice", page.linearization), "unavailable");
  // A snapshot read for a different actor is never accepted for this session.
  assert.equal(identityLib.verifyStagingReadBeforeRelease(request, identity, fx.store, "alice",
    { ...page.linearization, actorUserId: "carol" }), "unavailable");
  // A tampered policy_revision or role in the observed record is stale.
  const bumped = structuredClone(page.linearization);
  bumped.areas[0].policyRevision += 1;
  assert.equal(identityLib.verifyStagingReadBeforeRelease(request, identity, fx.store, "alice", bumped), "stale");
  const wrongRole = structuredClone(page.linearization);
  wrongRole.areas.find(area => area.areaId === "family-area").access = "admin";
  assert.equal(identityLib.verifyStagingReadBeforeRelease(request, identity, fx.store, "alice", wrongRole), "stale");

  mutate(fx, removeMemberSql("bob"));
  assert.equal(check(), "stale");
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, b.sessionId).ok, true);
  assert.equal(check(), "unauthorized", "a dead session wins over a stale membership");
  // A child started for a revoked session reads nothing.
  assert.equal(await readProcess.readStagingScopedPageInChild(config, "shared", 50, 0), null);
});

test("child DTO boundary rejects extra fields, foreign ids and inconsistent Area records", () => {
  const row = {
    id: "f-1", title: "t", projectId: null, effectiveAreaId: "a", areaId: "a",
    areaKind: "shared", assignedToMe: false,
  };
  const page = (tasks, areas = [{ areaId: "a", areaKind: "shared", policyRevision: 1, access: "viewer" }], extra = {}) => ({
    ok: true, tasks, hasMore: false, revision: "a".repeat(64),
    linearization: { actorUserId: "carol", areas }, ...extra,
  });
  assert.ok(readProcess.parseStagingScopedPage(page([row]), "shared"));
  assert.equal(readProcess.parseStagingScopedPage(page([{ ...row, assigneeUserId: "bob" }]), "shared"), null);
  assert.equal(readProcess.parseStagingScopedPage(page([row], [], {}), "shared"), null, "areas must cover the rows");
  assert.equal(readProcess.parseStagingScopedPage(page([row], [{ areaId: "a", areaKind: "shared", policyRevision: 1, access: "owner" }]), "shared"), null);
  assert.equal(readProcess.parseStagingScopedPage(page([row], undefined, { members: ["bob"] }), "shared"), null);
  assert.equal(readProcess.parseStagingScopedPage(page([{ ...row, assignedToMe: false }]), "my-plan"), null,
    "my-plan carries a shared task only when assigned to the actor");
  assert.equal(readProcess.parseStagingScopedPage(page([{ ...row, areaKind: "private", assignedToMe: undefined }]), "shared"), null);
  assert.equal(readProcess.parseStagingTaskDetail({ ok: true, scope: "shared", task: { ...row, id: "other" },
    linearization: { actorUserId: "carol", areas: [{ areaId: "a", areaKind: "shared", policyRevision: 1, access: "viewer" }] } }, "f-1"), null);
});

test("child DTO boundary: Area kind and access must be consistent (private-owner only with private Areas)", () => {
  const row = { id: "f-1", title: "t", projectId: null, effectiveAreaId: "a", areaId: "a",
    areaKind: "shared", assignedToMe: false };
  const page = areas => ({ ok: true, tasks: [row], hasMore: false, revision: "a".repeat(64),
    linearization: { actorUserId: "carol", areas } });
  const area = (areaKind, access, areaId = "a") => ({ areaId, areaKind, policyRevision: 1, access });
  assert.ok(readProcess.parseStagingScopedPage(page([area("shared", "editor")]), "shared"));
  assert.ok(readProcess.parseStagingScopedPage(page([area("shared", "viewer"), area("private", "private-owner", "p")]), "shared"));
  for (const bad of [
    [area("shared", "private-owner")],            // private-owner on a shared Area
    [area("private", "admin")],                   // role on a private Area
    [area("private", "private-owner")],           // row's Area recorded with a different kind
    [area("shared", "viewer"), area("shared", "editor")],   // duplicate Area
    [{ areaId: "a", policyRevision: 1, access: "viewer" }],  // kind missing
  ]) {
    assert.equal(readProcess.parseStagingScopedPage(page(bad), "shared"), null, JSON.stringify(bad));
  }
});

test("a disabled feature gate or rebound store is 503, never a stale 409 / 404", async () => {
  for (const [label, run, expectedStale] of [
    ["list", (fx, who) => list(fx, "?scope=shared", who.cookie), 409],
    ["detail", (fx, who) => detail(fx, "f-3", who.cookie), 404],
  ]) {
    const fx = makeFixture();
    const b = login(fx, "bob");
    try {
      const response = await withGatedChild(() => run(fx, b), async () => {
        mutate(fx, removeMemberSql("bob"));
        process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
      });
      assert.equal(response.status, 503, label);
      assert.deepEqual(await response.json(), { error: "Staging unavailable" });
    } finally {
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
    }
    // Same race with the gate intact is the stale answer.
    const fx2 = makeFixture();
    const b2 = login(fx2, "bob");
    const stale = await withGatedChild(() => run(fx2, b2), async () => mutate(fx2, removeMemberSql("bob")));
    assert.equal(stale.status, expectedStale, label);
  }
});

test("hard staging limit: 1000 contributing Areas per scoped read pass, 1001 fail closed with 503 and no data", async () => {
  const fx = makeFixture();
  const db = new DatabaseSync(fx.databasePath);
  db.exec("PRAGMA foreign_keys=ON; BEGIN");
  for (let n = 0; n < 999; n++) {
    db.exec(`INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bw${n}','shared','erin');
      INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('bulk${n}','Bulk ${n}','shared','bw${n}','erin');
      INSERT INTO area_members(area_id,user_id,role) VALUES ('bulk${n}','erin','admin');
      INSERT INTO area_members(area_id,user_id,role) VALUES ('bulk${n}','carol','viewer');
      INSERT INTO tasks(id,area_id,title) VALUES ('z-${n}','bulk${n}','Bulk task ${n}');`);
  }
  db.exec("COMMIT");
  db.close();
  const carol = login(fx, "carol");
  const ok = await list(fx, "?scope=shared&limit=1", carol.cookie);
  assert.equal(ok.status, 200, "family-area + 999 bulk Areas = 1000");
  assert.equal((await ok.json()).tasks.length, 1);
  mutate(fx, `INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bw-over','shared','erin');
    INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('bulk-over','Over','shared','bw-over','erin');
    INSERT INTO area_members(area_id,user_id,role) VALUES ('bulk-over','erin','admin');
    INSERT INTO area_members(area_id,user_id,role) VALUES ('bulk-over','carol','viewer');
    INSERT INTO tasks(id,area_id,title) VALUES ('z-over','bulk-over','Over task');`);
  const over = await list(fx, "?scope=shared&limit=1", carol.cookie);
  assert.equal(over.status, 503);
  const text = await over.text();
  assert.deepEqual(JSON.parse(text), { error: "Staging unavailable" });
  assert.equal(text.includes("Family"), false);
});

// Areas which contribute only to hasMore (look-ahead row) or to the cursor revision must be
// re-verified too: the linearization record holds every Area of the actor's scope.
const twoAreaSetup = fx => mutate(fx, `
  INSERT INTO area_members(area_id,user_id,role) VALUES ('other-area','carol','viewer');
  INSERT INTO area_members(area_id,user_id,role) VALUES ('other-area','bob','editor');
  INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES ('a-1','other-area','Other a1','bob');
  INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES ('a-2','other-area','Other a2','bob');`);

test("barrier: an Area supplying only the look-ahead row or only the revision is re-verified (shared and my-plan)", async () => {
  const cases = [
    // [label, user, scope, limit, expected page ids, hasMore] ; Area family-area is revoked
    ["shared look-ahead only", "carol", "shared", 2, ["a-1", "a-2"]],
    ["shared revision only", "carol", "shared", 1, ["a-1"]],
    ["my-plan look-ahead only", "bob", "my-plan", 2, ["a-1", "a-2"]],
    ["my-plan revision only", "bob", "my-plan", 1, ["a-1"]],
  ];
  for (const [label, user, scope, limit, pageIds] of cases) {
    const fx = makeFixture();
    twoAreaSetup(fx);
    const who = login(fx, user);
    // Sanity: the unrevoked page really excludes family-area rows.
    const before = await (await list(fx, `?scope=${scope}&limit=${limit}`, who.cookie)).json();
    assert.deepEqual(ids(before), pageIds, label);
    assert.equal(before.hasMore, true, label);
    assert.ok(before.tasks.every(task => task.areaId === "other-area"), label);
    const response = await withGatedChild(
      () => list(fx, `?scope=${scope}&limit=${limit}`, who.cookie),
      async () => mutate(fx, removeMemberSql(user)));
    assert.equal(response.status, 409, label);
    assert.deepEqual(await response.json(), { error: "read_stale_reload" }, label);
  }
  // A policy change in any Area of the actor's scope (other-area supplies rows beyond the page) stales the read.
  const fx = makeFixture();
  twoAreaSetup(fx);
  const carol = login(fx, "carol");
  const ok = await withGatedChild(
    () => list(fx, "?scope=shared&limit=1", carol.cookie),
    async () => mutate(fx, "INSERT INTO area_members(area_id,user_id,role) VALUES ('other-area','dave','viewer')"));
  assert.equal(ok.status, 409, "other-area contributes to carol's scope, so its policy change is stale");
});

test("revision: reassignment between two non-actor users changes the shared revision (no silently skipped change)", async () => {
  const fx = makeFixture();
  const carol = login(fx, "carol");
  const first = await (await list(fx, "?scope=shared&limit=2", carol.cookie)).json();
  assert.ok(first.tasks.every(task => task.assignedToMe === false));
  mutate(fx, "UPDATE tasks SET assignee_user_id='alice' WHERE id='f-5'");
  const stale = await list(fx, `?scope=shared&limit=2&cursor=${first.nextCursor}`, carol.cookie);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "Cursor stale" });
});

test("my-plan cursor walk (limit 1..4): no duplicates, no gaps; shared and my-plan agree on a task", async () => {
  const fx = makeFixture();
  const b = login(fx, "bob");
  twoAreaSetup(fx);
  const expected = ids(await (await list(fx, "?scope=my-plan&limit=100", b.cookie)).json());
  assert.deepEqual(expected, ["a-1", "a-2", "f-2", "f-5", "p-bob-1"]);
  for (const limit of [1, 2, 3, 4]) {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const response = await list(fx, `?scope=my-plan&limit=${limit}${cursor ? "&cursor=" + cursor : ""}`, b.cookie);
      assert.equal(response.status, 200, `limit ${limit}`);
      const body = await response.json();
      seen.push(...ids(body));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen, expected, `limit ${limit}`);
  }
  const plan = (await (await list(fx, "?scope=my-plan&limit=100", b.cookie)).json()).tasks;
  const shared = (await (await list(fx, "?scope=shared&limit=100", b.cookie)).json()).tasks;
  const common = plan.filter(task => task.areaKind === "shared");
  assert.ok(common.length >= 2);
  for (const task of common) {
    assert.deepEqual(shared.find(other => other.id === task.id), task);
  }
});


test("issue #155: area content markers invalidate shared and my-plan cursors on title ABA", async () => {
  const fx = makeFixture();
  const alice = login(fx, "alice");
  const carol = login(fx, "carol");
  // Give the viewer two private tasks so a my-plan cursor exists.
  mutate(fx, "INSERT INTO tasks(id,area_id,title) VALUES ('p-carol-2','carol-private','Carol second')");
  const shared = await (await list(fx, "?scope=shared&limit=2", alice.cookie)).json();
  const plan = await (await list(fx, "?scope=my-plan&limit=1", alice.cookie)).json();
  const viewerPlan = await (await list(fx, "?scope=my-plan&limit=1", carol.cookie)).json();
  assert.ok(shared.nextCursor && plan.nextCursor && viewerPlan.nextCursor);
  const continuation = (scope, cursor, cookie) =>
    list(fx, `?scope=${scope}&limit=${scope === "shared" ? 2 : 1}&cursor=${cursor}`, cookie);

  // A different Area is outside the authenticated actor's revision domain.
  mutate(fx, "UPDATE tasks SET title='Changed elsewhere' WHERE id='o-1'");
  assert.equal((await continuation("shared", shared.nextCursor, alice.cookie)).status, 200);
  assert.equal((await continuation("my-plan", plan.nextCursor, alice.cookie)).status, 200);

  const db = new DatabaseSync(fx.databasePath);
  try {
    const areaEpoch = id => Number(db.prepare("SELECT content_revision AS n FROM areas WHERE id=?").get(id).n);
    const before = areaEpoch("family-area");
    // An idempotent update must not change a cursor; a real update must.
    mutate(fx, "UPDATE tasks SET title=title WHERE id='f-3'");
    assert.equal(areaEpoch("family-area"), before);
    // f-3 is not assigned to Alice, but she can read its shared Area.
    // The Area-level my-plan revision intentionally errs toward invalidation.
    mutate(fx, "UPDATE tasks SET title='Temporary' WHERE id='f-3'; UPDATE tasks SET title='Family three' WHERE id='f-3'");
    assert.ok(areaEpoch("family-area") > before, "content epoch survives title ABA");
    for (const [scope, cursor] of [["shared", shared.nextCursor], ["my-plan", plan.nextCursor]]) {
      const res = await continuation(scope, cursor, alice.cookie);
      assert.equal(res.status, 409, scope);
      assert.deepEqual(await res.json(), { error: "Cursor stale" }, scope);
    }
    // A viewer has no shared assignments: their private-only my-plan must not
    // change when an unrelated (albeit visible via shared) Area is edited.
    assert.equal((await continuation("my-plan", viewerPlan.nextCursor, carol.cookie)).status, 200);
    // Direct SQL cannot reset the epoch or recycle an Area identity.
    assert.throws(() => db.prepare("UPDATE areas SET content_revision=0 WHERE id='family-area'").run(),
      /Area content revision must increment by one/);
  } finally {
    db.close();
  }
});

test("issue #155: inherited project tasks advance Area revisions, without affecting foreign cursors", async () => {
  const fx = makeFixture();
  const alice = login(fx, "alice");
  const bob = login(fx, "bob");
  const ownerPersonal = await (await list(fx, "?limit=1", alice.cookie)).json();
  const bobPersonal = await (await list(fx, "?limit=1", bob.cookie)).json();
  // Bob has only one private row in this fixture, so insert a second.
  mutate(fx, "INSERT INTO tasks(id,area_id,title) VALUES ('p-bob-2','bob-private','Another private')");
  const bobCursor = (await (await list(fx, "?limit=1", bob.cookie)).json()).nextCursor;
  assert.ok(ownerPersonal.nextCursor && bobCursor);
  const db = new DatabaseSync(fx.databasePath);
  try {
    const epoch = id => Number(db.prepare("SELECT content_revision AS n FROM areas WHERE id=?").get(id).n);
    const before = epoch("family-area");
    mutate(fx, `INSERT INTO projects(id,area_id,title) VALUES ('px-155','family-area','Inherited');
      INSERT INTO tasks(id,project_id,title) VALUES ('px-155-task','px-155','Original');`);
    assert.ok(epoch("family-area") > before, "project child insert advances Area revision");
    const afterInsert = epoch("family-area");
    mutate(fx, "UPDATE tasks SET title='Renamed' WHERE id='px-155-task'");
    assert.ok(epoch("family-area") > afterInsert, "inherited title update advances Area revision");
    // Changes in the shared Area do not invalidate either owner's personal view.
    assert.equal((await list(fx, `?limit=1&cursor=${ownerPersonal.nextCursor}`, alice.cookie)).status, 200);
    assert.equal((await list(fx, `?limit=1&cursor=${bobCursor}`, bob.cookie)).status, 200);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('spare-155','Spare','private',?, 'alice')")
      .run(fx.stage.personalWorkspaceId);
    assert.throws(() => db.prepare("DELETE FROM areas WHERE id='spare-155'").run(),
      /Area deletion requires tombstone protocol/, "Area IDs cannot be recycled to reset epochs");
  } finally {
    db.close();
  }
});


test("issue #155 review: actor-indexed cursor scans and exactly-once Area epochs", async () => {
  const fx = makeFixture();
  const db = new DatabaseSync(fx.databasePath);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    // Many Areas invisible to alice must not be visited on every page.
    const addForeign = db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id)
      VALUES (?,'Foreign','private','erin-personal','erin')`);
    for (let i = 0; i < 500; i++) addForeign.run(`foreign-area-${i}`);

    const { scopedTaskListRevision, personalTaskListRevision } =
      // Node tests use this module's same TypeScript loader as the HTTP route.
      await import("../lib/target-task-read-model.ts");
    const captured = [];
    // Instrument only the SQL preparation boundary, without changing the
    // production query or guessing a separate query for the plan test.
    const tracedDb = {
      prepare(sql) {
        if (sql.includes("ORDER BY areaId COLLATE BINARY ASC")) captured.push(sql);
        return db.prepare(sql);
      },
    };
    const values = [
      personalTaskListRevision(tracedDb, "alice"),
      scopedTaskListRevision(tracedDb, "alice", "shared", fx.stage.restoreGeneration),
      scopedTaskListRevision(tracedDb, "alice", "my-plan", fx.stage.restoreGeneration),
    ];
    assert.equal(values.length, 3);
    assert.ok(values.every(value => /^[0-9a-f]{64}$/.test(value)));
    assert.equal(captured.length, 3);
    for (let i = 0; i < captured.length; i++) {
      const bind = i === 2 ? ["alice", "alice"] : ["alice"];
      const details = db.prepare("EXPLAIN QUERY PLAN " + captured[i])
        .all(...bind).map(row => row.detail);
      assert.ok(details.every(row => !/\\bSCAN (?:a|member)\\b/i.test(row)),
        `cursor must not scan foreign Areas/memberships: ${details.join("; ")}`);
      if (i !== 1) assert.ok(details.some(row => /SEARCH a USING (?:COVERING )?INDEX areas_by_owner_kind/i.test(row)),
        `private Area actor index absent: ${details.join("; ")}`);
      if (i !== 0) assert.ok(details.some(row => /SEARCH member USING (?:COVERING )?INDEX area_members_by_user_area/i.test(row)),
        `shared membership actor index absent: ${details.join("; ")}`);
    }

    const epoch = id => Number(db.prepare(
      "SELECT content_revision AS n FROM areas WHERE id=?").get(id).n);
    const familyStart = epoch("family-area");
    db.prepare("UPDATE tasks SET title='Changed once' WHERE id='f-3'").run();
    assert.equal(epoch("family-area"), familyStart + 1,
      "a normal title UPDATE must bump content exactly once");
    db.prepare("UPDATE tasks SET title=title WHERE id='f-3'").run();
    assert.equal(epoch("family-area"), familyStart + 1,
      "a no-op title UPDATE must not bump content");
    db.prepare("UPDATE tasks SET title='Family three' WHERE id='f-3'").run();
    assert.equal(epoch("family-area"), familyStart + 2, "title ABA must stay detectable");
    db.prepare("UPDATE tasks SET revision=revision+1 WHERE id='f-3'").run();
    assert.equal(epoch("family-area"), familyStart + 3,
      "direct SQL revision-only edits must still invalidate cursors");

    // A task's effective Area changes via a direct Area reassignment. Both
    // old and new sets must be invalidated, and exactly once each.
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id)
      VALUES ('alice-second-private','Another private','private',?,'alice')`)
      .run(fx.stage.personalWorkspaceId);
    const oldArea = fx.stage.unassignedAreaId;
    const beforeOld = epoch(oldArea);
    const beforeNew = epoch("alice-second-private");
    db.prepare("UPDATE tasks SET area_id='alice-second-private' WHERE id='p-alice-1'").run();
    assert.equal(epoch(oldArea), beforeOld + 1, "source Area changed once");
    assert.equal(epoch("alice-second-private"), beforeNew + 1, "target Area changed once");
  } finally {
    db.close();
  }
});
