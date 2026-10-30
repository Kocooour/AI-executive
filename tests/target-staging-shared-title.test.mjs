import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2-ID.3: shared-Area task title writes (editor/admin) over the staging HTTP facade.
// Synthetic temp store only. Roles: alice admin (owner cookie + sessions), bob editor,
// carol viewer, dave non-member, erin admin of an unrelated Area.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2id3-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
const REAL_NODE = process.execPath;
const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED", "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION", "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const old = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
  ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-r2id3-session-secret-2026-10-29";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { GET: PREVIEW, PATCH } = await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const { POST: STATUS } = await import("../app/api/target-staging/tasks/[taskId]/title/status/route.ts");
const { GET: DETAIL } = await import("../app/api/target-staging/tasks/[taskId]/route.ts");
const { GET: AUDIT } = await import("../app/api/target-staging/tasks/[taskId]/audit/route.ts");
const { POST: MEMBERS } = await import("../app/api/target-staging/areas/[areaId]/members/route.ts");

const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
const db = new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
for (const user of ["bob", "carol", "dave", "erin"]) {
  db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)").run(`${user}-personal`, user);
  db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
    VALUES (?, ?, 'private', ?, ?, 'unassigned')`).run(`${user}-private`, `${user} private`, `${user}-personal`, user);
}
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('other','shared','erin')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('other-area','Other','shared','other','erin')").run();
const member = db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)");
member.run("team-area", "alice", "admin");
member.run("team-area", "bob", "editor");
member.run("team-area", "carol", "viewer");
member.run("other-area", "erin", "admin");
db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('team-project','team-area','Project')").run();

let taskCounter = 0;
/** Fresh shared task (own row per test: titles and revisions never interfere). */
function sharedTask(prefix = "s", extra = {}) {
  const id = `${prefix}-${++taskCounter}`;
  if (extra.project) db.prepare("INSERT INTO tasks(id,project_id,title) VALUES (?, 'team-project', ?)").run(id, `${id} original`);
  else db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?, 'team-area', ?)").run(id, `${id} original`);
  return id;
}
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('alice-private',?,'Alice private')").run(stage.unassignedAreaId);
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('bob-private-task','bob-private','Bob private')").run();
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('other-task','other-area','Other')").run();

after(() => {
  process.execPath = REAL_NODE;
  db.close();
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers
const base = "http://localhost:3001/api/target-staging/";
const context = taskId => ({ params: Promise.resolve({ taskId }) });
const ownerCookie = `${sessionCookieName}=${createSessionToken()}`;
const login = user => {
  const issued = durable.issueDurableTargetStagingSession(store, user, 900);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return { ...issued, user, cookie: `${durable.TARGET_STAGING_SESSION_COOKIE}=${issued.sessionToken}` };
};
let client = 0;
const ip = () => `10.3.${Math.floor(++client / 250)}.${client % 250 + 1}`;
const headersOf = cookie => ({
  "content-type": "application/json", origin: "http://localhost:3001",
  "x-forwarded-for": ip(), ...(cookie ? { cookie } : {}),
});
const preview = (taskId, cookie, query = "") =>
  PREVIEW(new Request(`${base}tasks/${taskId}/title${query}`, { headers: headersOf(cookie) }), context(taskId));
const patch = (taskId, cookie, payload) =>
  PATCH(new Request(`${base}tasks/${taskId}/title`, {
    method: "PATCH", headers: headersOf(cookie), body: JSON.stringify(payload),
  }), context(taskId));
const status = (taskId, cookie, payload) =>
  STATUS(new Request(`${base}tasks/${taskId}/title/status`, {
    method: "POST", headers: headersOf(cookie), body: JSON.stringify(payload),
  }), context(taskId));
const detail = (taskId, cookie) =>
  DETAIL(new Request(`${base}tasks/${taskId}`, { headers: headersOf(cookie) }), context(taskId));
const audit = (taskId, cookie) =>
  AUDIT(new Request(`${base}tasks/${taskId}/audit`, { headers: headersOf(cookie) }), context(taskId));
const members = (areaId, cookie, payload) =>
  MEMBERS(new Request(`${base}areas/${areaId}/members`, {
    method: "POST", headers: headersOf(cookie), body: JSON.stringify(payload),
  }), { params: Promise.resolve({ areaId }) });
const command = (title, expectedRevision, commandId = randomUUID()) => ({ commandId, title, expectedRevision });
const revisionOf = async (taskId, cookie) => {
  const response = await detail(taskId, cookie);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.snapshotRevision, /^[a-f0-9]{64}$/);
  return body.snapshotRevision;
};
const policyRevision = () => db.prepare("SELECT policy_revision AS r FROM areas WHERE id='team-area'").get().r;
const setRole = (user, role, cookie = ownerCookie) => members("team-area", cookie, {
  commandId: randomUUID(), expectedPolicyRevision: policyRevision(), action: "set_role", targetUserId: user, role,
});
const removeMember = (user) => members("team-area", ownerCookie, {
  commandId: randomUUID(), expectedPolicyRevision: policyRevision(), action: "remove", targetUserId: user,
});
/** Raw SQL in a SEPARATE process (the gated process.execPath must not be used for it). */
function mutateElsewhere(sql) {
  const run = spawnSync(REAL_NODE, ["-e",
    `const { DatabaseSync } = require("node:sqlite");
     const d = new DatabaseSync(process.argv[1]);
     d.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000"); d.exec(process.argv[2]); d.close();`,
    stage.databasePath, sql], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}
const snapshot = taskId => ({
  task: { ...db.prepare("SELECT title,revision FROM tasks WHERE id=?").get(taskId) },
  receipts: db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'r2:task-title-receipt-v2:%'").get().n,
  allMetadata: db.prepare("SELECT COUNT(*) AS n FROM metadata").get().n,
  audit: db.prepare("SELECT COUNT(*) AS n FROM task_title_audit").get().n,
});
const notFound = async response => {
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return JSON.stringify(await response.json());
};

/** Status + every response header except transport/date noise + body, as one comparable string. */
const NOISE_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);
const fingerprint = async response => JSON.stringify({
  status: response.status,
  headers: Object.fromEntries([...response.headers.entries()]
    .filter(([name]) => !NOISE_HEADERS.has(name.toLowerCase())).sort(([a], [b]) => a < b ? -1 : 1)),
  body: JSON.stringify(await response.json()),
});

// Gate that holds the title CHILD before it starts, so a change can commit between
// "route accepted + dispatched the command" and "child opens the write transaction".
let gateCounter = 0;
async function withChildGatedBeforeStart(run, between) {
  const gate = path.join(root, `gate-${++gateCounter}`);
  mkdirSync(gate);
  const script = path.join(gate, "node-wrapper.sh");
  writeFileSync(script, `#!/bin/sh
PATH=/usr/bin:/bin
: > "${gate}/started"
while [ ! -e "${gate}/go" ]; do sleep 0.02; done
exec "${REAL_NODE}" "$@"
`);
  chmodSync(script, 0o755);
  process.execPath = script;
  try {
    const pending = run();
    for (let waited = 0; !existsSync(path.join(gate, "started")); waited += 20) {
      assert.ok(waited < 30_000, "gated child never started");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await between();
    writeFileSync(path.join(gate, "go"), "");
    return await pending;
  } finally { process.execPath = REAL_NODE; }
}

// ------------------------------------------------------------------ tests
test("editor B and admin A (session and owner cookie) write a shared task title; audit names the real actor", async () => {
  const taskId = sharedTask();
  const [alice, bob] = [login("alice"), login("bob")];

  // Preview (GET) and detail agree on one CAS token for an editor.
  const previewBody = await (await preview(taskId, bob.cookie)).json();
  const fromDetail = await revisionOf(taskId, bob.cookie);
  assert.equal(previewBody.snapshotRevision, fromDetail);

  const before = db.prepare("SELECT revision FROM tasks WHERE id=?").get(taskId).revision;
  const saved = await patch(taskId, bob.cookie, command("Edited by bob", fromDetail));
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true });
  assert.deepEqual({ ...db.prepare("SELECT title,revision FROM tasks WHERE id=?").get(taskId) },
    { title: "Edited by bob", revision: before + 1 });

  // Admin A with a session, then with the owner cookie (maps to alice).
  const second = await patch(taskId, alice.cookie, command("Edited by alice", await revisionOf(taskId, alice.cookie)));
  assert.equal(second.status, 200);
  const third = await patch(taskId, ownerCookie, command("Edited by owner cookie", await revisionOf(taskId, ownerCookie)));
  assert.equal(third.status, 200);
  assert.deepEqual({ ...db.prepare("SELECT title,revision FROM tasks WHERE id=?").get(taskId) },
    { title: "Edited by owner cookie", revision: before + 3 });

  const rows = db.prepare(`SELECT actor_user_id, area_id, revision_before, revision_after, restore_generation
    FROM task_title_audit WHERE task_id=? ORDER BY id`).all(taskId).map(row => ({ ...row }));
  assert.deepEqual(rows.map(row => row.actor_user_id), ["bob", "alice", "alice"]);
  assert.ok(rows.every(row => row.area_id === "team-area" && row.restore_generation === stage.restoreGeneration));
  assert.deepEqual(rows.map(row => row.revision_after - row.revision_before), [1, 1, 1]);

  // Project-inherited shared task behaves the same.
  const inherited = sharedTask("p", { project: true });
  assert.equal((await patch(inherited, bob.cookie, command("Inherited edit", await revisionOf(inherited, bob.cookie)))).status, 200);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(inherited).title, "Inherited edit");
});

test("viewer C, non-member D, foreign Area and foreign private tasks: indistinguishable 404, nothing written", async () => {
  const taskId = sharedTask();
  const [carol, dave, bob] = [login("carol"), login("dave"), login("bob")];
  const stale = "a".repeat(64);
  const good = await revisionOf(taskId, bob.cookie);
  const before = snapshot(taskId);
  const bodies = new Set();
  for (const who of [carol, dave]) {
    for (const id of [taskId, "alice-private", "bob-private-task", "other-task", "no-such-task"]) {
      bodies.add(await fingerprint(await preview(id, who.cookie)));
      bodies.add(await fingerprint(await patch(id, who.cookie, command("Forbidden", id === taskId ? good : stale))));
      bodies.add(await fingerprint(await status(id, who.cookie, command("Forbidden", id === taskId ? good : stale))));
    }
  }
  // An editor of team-area is just as blind to the other Area and to foreign private tasks.
  for (const id of ["other-task", "alice-private", "bob-private-task-x"]) {
    bodies.add(await fingerprint(await patch(id, bob.cookie, command("Forbidden", stale))));
  }
  // One single fingerprint: status, full header set (minus transport/date noise) and body.
  assert.equal(bodies.size, 1, [...bodies].join("\n"));
  const only = JSON.parse([...bodies][0]);
  assert.equal(only.status, 404);
  assert.equal(only.headers["cache-control"], "no-store");
  assert.match(only.headers["content-type"], /^application\/json/);
  assert.equal(only.body, JSON.stringify({ error: "Not found" }));
  assert.deepEqual(snapshot(taskId), before);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id='other-task'").get().title, "Other");

  // Viewer detail: shared DTO WITHOUT snapshotRevision. Non-member detail: 404.
  const viewerDetail = await (await detail(taskId, carol.cookie)).json();
  assert.deepEqual(Object.keys(viewerDetail), ["task"]);
  assert.equal(viewerDetail.task.id, taskId);
  assert.equal((await detail(taskId, dave.cookie)).status, 404);
  assert.deepEqual(Object.keys(await (await detail(taskId, bob.cookie)).json()).sort(), ["snapshotRevision", "task"]);

  // Private-task behaviour is unchanged: the owner previews/writes, others cannot.
  const alice = login("alice");
  const privateRev = (await (await detail("alice-private", alice.cookie)).json()).snapshotRevision;
  assert.equal((await patch("alice-private", alice.cookie, command("Private ok", privateRev))).status, 200);
  assert.equal((await detail("alice-private", bob.cookie)).status, 404);
});

test("race: editor demoted (membership command) between detail and PATCH -> 404, nothing written; promotion back -> 409", async () => {
  const taskId = sharedTask();
  const bob = login("bob");
  const token = await revisionOf(taskId, bob.cookie);
  assert.equal((await setRole("bob", "viewer")).status, 200);
  const before = snapshot(taskId);
  const refused = await patch(taskId, bob.cookie, command("After demotion", token));
  assert.equal(await notFound(refused), JSON.stringify({ error: "Not found" }));
  assert.equal((await preview(taskId, bob.cookie)).status, 404);
  assert.equal((await status(taskId, bob.cookie, command("After demotion", token))).status, 404);
  assert.deepEqual(snapshot(taskId), before);
  assert.deepEqual(Object.keys(await (await detail(taskId, bob.cookie)).json()), ["task"], "now a viewer");

  // Promoted again: still an editor, but the policy epoch moved twice -> stale token, 409.
  assert.equal((await setRole("bob", "editor")).status, 200);
  const stale = await patch(taskId, bob.cookie, command("Old token", token));
  assert.equal(stale.status, 409);
  assert.deepEqual(snapshot(taskId), before);
  assert.equal((await patch(taskId, bob.cookie, command("Fresh token", await revisionOf(taskId, bob.cookie)))).status, 200);
});

test("race: editor removed (membership command) between detail and PATCH -> 404, nothing written", async () => {
  const taskId = sharedTask();
  const other = sharedTask();
  const bob = login("bob");
  const token = await revisionOf(taskId, bob.cookie);
  assert.equal((await removeMember("bob")).status, 200);
  try {
    const before = snapshot(taskId);
    assert.equal((await patch(taskId, bob.cookie, command("After removal", token))).status, 404);
    assert.equal((await detail(other, bob.cookie)).status, 404);
    assert.deepEqual(snapshot(taskId), before);
  } finally {
    db.prepare("INSERT OR IGNORE INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  }
});

test("race inside the dispatch window: demotion or removal committed before the write transaction opens -> 404", async () => {
  for (const change of ["demote", "remove"]) {
    const taskId = sharedTask();
    const bob = login("bob");
    const token = await revisionOf(taskId, bob.cookie);
    const before = snapshot(taskId);
    try {
      const response = await withChildGatedBeforeStart(
        () => patch(taskId, bob.cookie, command("Raced", token)),
        async () => mutateElsewhere(change === "demote"
          ? "UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'"
          : "DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'"));
      assert.equal(response.status, 404, change);
      assert.deepEqual(snapshot(taskId), before, change);
    } finally {
      db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
      db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
    }
  }
});

test("a revoked durable session cannot complete a pending shared PATCH (401, nothing written)", async () => {
  const taskId = sharedTask();
  const bob = login("bob");
  const token = await revisionOf(taskId, bob.cookie);
  const before = snapshot(taskId);
  const response = await withChildGatedBeforeStart(
    () => patch(taskId, bob.cookie, command("Revoked", token)),
    async () => { assert.equal(durable.revokeDurableTargetStagingSession(store, bob.sessionId).ok, true); });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required", code: "session_revoked" });
  assert.deepEqual(snapshot(taskId), before);
  // And afterwards every title route refuses the dead session.
  assert.equal((await preview(taskId, bob.cookie)).status, 401);
  assert.equal((await status(taskId, bob.cookie, command("Revoked", token))).status, 401);
});


const waitUntilExpired = async issued => {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, issued.expiresAtMs - Date.now()) + 400));
};

test("a durable session which EXPIRES inside the pending shared PATCH gets 401 session_expired, nothing written", async () => {
  const taskId = sharedTask();
  const issued = durable.issueDurableTargetStagingSession(store, "bob", 3);
  assert.equal(issued.ok, true);
  const cookie = `${durable.TARGET_STAGING_SESSION_COOKIE}=${issued.sessionToken}`;
  const token = await revisionOf(taskId, cookie);
  const before = snapshot(taskId);
  const response = await withChildGatedBeforeStart(
    () => patch(taskId, cookie, command("Expired", token)), () => waitUntilExpired(issued));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required", code: "session_expired" });
  assert.deepEqual(snapshot(taskId), before);
});

test("receipts and status are per identity: B cannot learn or replay A's command; same commandId from two editors is independent", async () => {
  const taskId = sharedTask();
  const [alice, bob, carol] = [login("alice"), login("bob"), login("carol")];
  const commandId = randomUUID();
  const aliceToken = await revisionOf(taskId, alice.cookie);
  const aliceCommand = command("Alice wrote this", aliceToken, commandId);
  assert.equal((await patch(taskId, alice.cookie, aliceCommand)).status, 200);

  // A sees her own command as committed; B (same task, same body, same commandId) does not.
  assert.deepEqual(await (await status(taskId, alice.cookie, aliceCommand)).json(), { status: "committed" });
  assert.deepEqual(await (await status(taskId, bob.cookie, aliceCommand)).json(), { status: "not_recorded" });
  assert.equal((await status(taskId, carol.cookie, aliceCommand)).status, 404);

  // B replaying A's exact request is NOT a replay: it is B's own, stale command.
  const state = snapshot(taskId);
  const replayAttempt = await patch(taskId, bob.cookie, aliceCommand);
  assert.equal(replayAttempt.status, 409);
  assert.deepEqual(snapshot(taskId), state);

  // The same commandId with a fresh token and another title is a different, independent command.
  const bobCommand = command("Bob wrote this", await revisionOf(taskId, bob.cookie), commandId);
  const independent = await patch(taskId, bob.cookie, bobCommand);
  assert.equal(independent.status, 200);
  assert.deepEqual(await independent.json(), { ok: true });
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(taskId).title, "Bob wrote this");
  const replay = await patch(taskId, bob.cookie, bobCommand);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, replayed: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_title_audit WHERE task_id=?").get(taskId).n, 2);
  assert.deepEqual(await (await status(taskId, alice.cookie, aliceCommand)).json(), { status: "committed" });

  // A former editor learns nothing about its old command once demoted.
  assert.equal((await setRole("bob", "viewer")).status, 200);
  try {
    assert.equal((await status(taskId, bob.cookie, bobCommand)).status, 404);
    assert.equal((await patch(taskId, bob.cookie, bobCommand)).status, 404);
  } finally {
    assert.equal((await setRole("bob", "editor")).status, 200);
  }
});

test("the owner-only audit read route stays private-only: shared writes are not readable through it", async () => {
  const taskId = sharedTask();
  const alice = login("alice");
  assert.equal((await patch(taskId, alice.cookie, command("Audited", await revisionOf(taskId, alice.cookie)))).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_title_audit WHERE task_id=?").get(taskId).n, 1);
  const bodies = [];
  for (const cookie of [ownerCookie, alice.cookie, login("bob").cookie]) {
    const response = await audit(taskId, cookie);
    assert.equal(response.status, 404);
    bodies.push(JSON.stringify(await response.json()));
  }
  assert.deepEqual([...new Set(bodies)], [JSON.stringify({ error: "Not found" })]);
});

test("an admin who moves her own private task into a shared Area keeps her receipt visible and writes with a fresh token only", async () => {
  const alice = login("alice");
  const id = "alice-moving";
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,'Moving')").run(id, stage.unassignedAreaId);
  const first = command("Before move", (await (await detail(id, alice.cookie)).json()).snapshotRevision);
  assert.equal((await patch(id, alice.cookie, first)).status, 200);
  const privateToken = (await (await detail(id, alice.cookie)).json()).snapshotRevision;
  db.prepare("UPDATE tasks SET area_id='team-area' WHERE id=?").run(id);
  assert.deepEqual(await (await status(id, alice.cookie, first)).json(), { status: "committed" });
  const before = snapshot(id);
  assert.equal((await patch(id, alice.cookie, command("Stale private token", privateToken))).status, 409);
  assert.deepEqual(snapshot(id), before);
  const fresh = await revisionOf(id, alice.cookie);
  assert.notEqual(fresh, privateToken);
  assert.equal((await patch(id, alice.cookie, command("After move", fresh))).status, 200);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(id).title, "After move");
});
