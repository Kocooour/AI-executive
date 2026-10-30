import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2c.1: idempotent, tombstoning task delete on the staging HTTP facade and library.
// Synthetic temp stores only. Roles in team-area: alice admin (owner cookie + sessions),
// bob editor, carol viewer, dave non-member, erin admin of an unrelated Area.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2c1-delete-"));
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
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-r2c1-delete-session-secret-2026-10-29";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const {
  bootstrapIsolatedTargetStore, TARGET_STAGING_DELETE_RECEIPT_PREFIX,
  TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_MAX_TOMBSTONES,
} = await import("../lib/target-store-bootstrap.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const { PATCH: TITLE } = await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const { POST: DELETE_TASK } = await import("../app/api/target-staging/tasks/[taskId]/delete/route.ts");
const { POST: DELETE_STATUS } = await import("../app/api/target-staging/tasks/[taskId]/delete/status/route.ts");
const { GET: DETAIL } = await import("../app/api/target-staging/tasks/[taskId]/route.ts");
const { GET: AUDIT } = await import("../app/api/target-staging/tasks/[taskId]/audit/route.ts");
const { GET: LIST } = await import("../app/api/target-staging/tasks/route.ts");
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
function sharedTask(prefix = "s", extra = {}) {
  const id = `${prefix}-${++taskCounter}`;
  if (extra.project) db.prepare("INSERT INTO tasks(id,project_id,title) VALUES (?, 'team-project', ?)").run(id, `${id} original`);
  else db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?, 'team-area', ?, ?)").run(id, `${id} original`, extra.assignee ?? null);
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
const ip = () => `10.4.${Math.floor(++client / 250)}.${client % 250 + 1}`;
const headersOf = (cookie, extra = {}) => ({
  "content-type": "application/json", origin: "http://localhost:3001",
  "x-forwarded-for": ip(), ...(cookie ? { cookie } : {}), ...extra,
});
const del = (taskId, cookie, payload, extra = {}) =>
  DELETE_TASK(new Request(`${base}tasks/${taskId}/delete${extra.query ?? ""}`, {
    method: "POST", headers: headersOf(cookie, extra.headers), body: extra.raw ?? JSON.stringify(payload),
  }), context(taskId));
const delStatus = (taskId, cookie, payload, extra = {}) =>
  DELETE_STATUS(new Request(`${base}tasks/${taskId}/delete/status${extra.query ?? ""}`, {
    method: "POST", headers: headersOf(cookie, extra.headers), body: extra.raw ?? JSON.stringify(payload),
  }), context(taskId));
const title = (taskId, cookie, payload) =>
  TITLE(new Request(`${base}tasks/${taskId}/title`, {
    method: "PATCH", headers: headersOf(cookie), body: JSON.stringify(payload),
  }), context(taskId));
const detail = (taskId, cookie) =>
  DETAIL(new Request(`${base}tasks/${taskId}`, { headers: headersOf(cookie) }), context(taskId));
const audit = (taskId, cookie) =>
  AUDIT(new Request(`${base}tasks/${taskId}/audit`, { headers: headersOf(cookie) }), context(taskId));
const list = (query, cookie) => LIST(new Request(`${base}tasks${query}`, { headers: headersOf(cookie) }));
const members = (areaId, cookie, payload) =>
  MEMBERS(new Request(`${base}areas/${areaId}/members`, {
    method: "POST", headers: headersOf(cookie), body: JSON.stringify(payload),
  }), { params: Promise.resolve({ areaId }) });
const command = (expectedRevision, commandId = randomUUID()) => ({ commandId, expectedRevision });
const revisionOf = async (taskId, cookie) => {
  const response = await detail(taskId, cookie);
  assert.equal(response.status, 200, `detail ${taskId}`);
  return (await response.json()).snapshotRevision;
};
const policyRevision = () => db.prepare("SELECT policy_revision AS r FROM areas WHERE id='team-area'").get().r;
const setRole = (user, role) => members("team-area", ownerCookie, {
  commandId: randomUUID(), expectedPolicyRevision: policyRevision(), action: "set_role", targetUserId: user, role,
});
const removeMember = user => members("team-area", ownerCookie, {
  commandId: randomUUID(), expectedPolicyRevision: policyRevision(), action: "remove", targetUserId: user,
});
const NOISE_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);
const fingerprint = async response => JSON.stringify({
  status: response.status,
  headers: Object.fromEntries([...response.headers.entries()]
    .filter(([name]) => !NOISE_HEADERS.has(name.toLowerCase())).sort(([a], [b]) => a < b ? -1 : 1)),
  body: JSON.stringify(await response.json()),
});
const count = sql => db.prepare(sql).get().n;
/** Everything a delete may touch, as one comparable value. */
const world = () => ({
  tasks: count("SELECT COUNT(*) AS n FROM tasks"),
  tombstones: count("SELECT COUNT(*) AS n FROM task_tombstones"),
  deleteAudit: count("SELECT COUNT(*) AS n FROM task_delete_audit"),
  titleAudit: count("SELECT COUNT(*) AS n FROM task_title_audit"),
  log: count("SELECT COALESCE(MAX(seq),0) AS n FROM change_log"),
  metadata: count("SELECT COUNT(*) AS n FROM metadata"),
  epochs: JSON.stringify(db.prepare("SELECT id, content_revision FROM areas ORDER BY id").all()),
});
const contentRevision = area => db.prepare("SELECT content_revision AS n FROM areas WHERE id=?").get(area).n;
function mutateElsewhere(sql) {
  const run = spawnSync(REAL_NODE, ["-e",
    `const { DatabaseSync } = require("node:sqlite");
     const d = new DatabaseSync(process.argv[1]);
     d.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000"); d.exec(process.argv[2]); d.close();`,
    stage.databasePath, sql], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}
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
test("an editor deletes a shared task: tombstone, log entry, receipt, audit and epoch commit together; every read forgets the task", async () => {
  const taskId = sharedTask();
  const [alice, bob] = [login("alice"), login("bob")];
  const token = await revisionOf(taskId, bob.cookie);
  const before = world();
  const epoch = contentRevision("team-area");
  const revision = db.prepare("SELECT revision FROM tasks WHERE id=?").get(taskId).revision;
  const commandId = randomUUID();

  const response = await del(taskId, bob.cookie, command(token, commandId));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });

  assert.equal(count(`SELECT COUNT(*) AS n FROM tasks WHERE id='${taskId}'`), 0);
  const tombstone = { ...db.prepare("SELECT * FROM task_tombstones WHERE id=?").get(taskId) };
  assert.equal(tombstone.area_id, "team-area");
  assert.equal(tombstone.revision, revision + 1);
  assert.equal(tombstone.change_seq, before.log + 1);
  assert.ok(tombstone.deleted_at_ms > 0);
  assert.deepEqual(Object.keys(tombstone).sort(), ["area_id", "change_seq", "deleted_at_ms", "id", "revision"]);
  assert.deepEqual({ ...db.prepare("SELECT * FROM change_log WHERE seq=?").get(tombstone.change_seq) }, {
    seq: tombstone.change_seq, entity_kind: "task", entity_id: taskId, area_id: "team-area",
    op: "tombstone", revision: revision + 1, member_user_id: null, member_role: null });
  assert.equal(count("SELECT COALESCE(MAX(seq),0) AS n FROM change_log"), before.log + 1, "exactly one log entry");
  assert.equal(contentRevision("team-area"), epoch + 1, "OLD Area epoch advanced once");

  const row = { ...db.prepare("SELECT * FROM task_delete_audit WHERE task_id=?").get(taskId) };
  const receiptKey = TARGET_STAGING_DELETE_RECEIPT_PREFIX + createHash("sha256")
    .update(JSON.stringify(["bob", taskId, commandId])).digest("hex");
  assert.deepEqual({ ...row, id: undefined, committed_at_ms: undefined, policy_revision: undefined }, {
    id: undefined, receipt_key: receiptKey, actor_user_id: "bob", task_id: taskId, area_id: "team-area",
    policy_revision: undefined, revision_before: revision, tombstone_revision: revision + 1,
    change_seq: tombstone.change_seq, expected_revision: token,
    restore_generation: stage.restoreGeneration, committed_at_ms: undefined });
  assert.equal(row.policy_revision, policyRevision());
  assert.ok(!JSON.stringify(row).includes("original"), "audit is content-free");
  assert.match(db.prepare("SELECT value FROM metadata WHERE key=?").get(receiptKey).value, /^[a-f0-9]{64}$/);
  assert.equal(count("SELECT COUNT(*) AS n FROM metadata"), before.metadata + 1, "exactly one receipt, in the delete namespace");
  assert.equal(count(`SELECT COUNT(*) AS n FROM metadata WHERE key='${receiptKey}'`), 1);
  assert.deepEqual(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).issues, []);

  // Gone from detail (404), audit (404), personal/shared/my-plan lists for every identity.
  for (const who of [alice, bob, login("carol")]) {
    assert.equal((await detail(taskId, who.cookie)).status, 404);
    assert.equal((await audit(taskId, who.cookie)).status, 404);
    for (const scope of ["shared", "my-plan"]) {
      const body = await (await list(`?scope=${scope}&limit=100`, who.cookie)).json();
      assert.ok(!body.tasks.some(task => task.id === taskId), `${scope} list`);
    }
  }
  const personal = await (await list("?limit=100", ownerCookie)).json();
  assert.ok(!personal.tasks.some(task => task.id === taskId));
});

test("project-inherited and private tasks: the tombstone records the effective Area; only the right actors delete", async () => {
  const [alice, bob] = [login("alice"), login("bob")];
  const inherited = sharedTask("pi", { project: true });
  assert.equal((await del(inherited, bob.cookie, command(await revisionOf(inherited, bob.cookie)))).status, 200);
  assert.equal(db.prepare("SELECT area_id FROM task_tombstones WHERE id=?").get(inherited).area_id, "team-area");

  // Own private task: owner deletes (session and owner cookie), others get an indistinguishable 404.
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('alice-del',?,'mine')").run(stage.unassignedAreaId);
  assert.equal((await title("alice-del", alice.cookie, { commandId: randomUUID(), title: "edited first",
    expectedRevision: await revisionOf("alice-del", alice.cookie) })).status, 200);
  assert.equal((await audit("alice-del", alice.cookie)).status, 200);
  const token = await revisionOf("alice-del", alice.cookie);
  const foreign = await fingerprint(await del("alice-del", bob.cookie, command(token)));
  assert.equal(foreign, await fingerprint(await del("never-existed", bob.cookie, command(token))));
  assert.equal(count("SELECT COUNT(*) AS n FROM tasks WHERE id='alice-del'"), 1);
  const commandId = randomUUID();
  assert.equal((await del("alice-del", ownerCookie, command(token, commandId))).status, 200);
  assert.equal(db.prepare("SELECT area_id FROM task_tombstones WHERE id='alice-del'").get().area_id, stage.unassignedAreaId);
  // The content-free title audit rows outlive the task (no FK) but the audit read is the same 404 as for a missing task.
  assert.equal(count("SELECT COUNT(*) AS n FROM task_title_audit WHERE task_id='alice-del'"), 1);
  const goneAudit = await fingerprint(await audit("alice-del", alice.cookie));
  assert.equal(goneAudit, await fingerprint(await audit("never-existed", alice.cookie)));
  assert.equal(JSON.parse(goneAudit).status, 404);
  // Retry after success from the same actor (owner cookie = alice): replay; the same commandId from bob is a 404.
  assert.deepEqual(await (await del("alice-del", alice.cookie, command(token, commandId))).json(), { ok: true, replayed: true });
  assert.equal((await del("alice-del", bob.cookie, command(token, commandId))).status, 404);
});

test("exact retry replays without a second tombstone, audit or log entry; a different payload under the same commandId conflicts", async () => {
  const taskId = sharedTask();
  const bob = login("bob");
  const token = await revisionOf(taskId, bob.cookie);
  const input = command(token);
  assert.equal((await del(taskId, bob.cookie, input)).status, 200);
  const settled = world();
  for (let attempt = 0; attempt < 3; attempt++) {
    const retry = await del(taskId, bob.cookie, input);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { ok: true, replayed: true });
  }
  assert.deepEqual(world(), settled);

  const conflict = await del(taskId, bob.cookie, { ...input, expectedRevision: "b".repeat(64) });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "Revision conflict", code: "idempotency_conflict" });
  assert.deepEqual(world(), settled);
  // A fresh commandId on the tombstoned ID is "not found" for the deleter too (nothing left to delete).
  assert.equal((await del(taskId, bob.cookie, command(token))).status, 404);
  assert.deepEqual(world(), settled);
  // Another editor/admin of the Area cannot replay bob's command nor learn of the tombstone.
  const alice = login("alice");
  assert.equal((await del(taskId, alice.cookie, input)).status, 404);
  assert.equal((await delStatus(taskId, alice.cookie, input)).status, 404);
  // A title receipt is a different namespace: it can never satisfy a delete retry.
  const other = sharedTask();
  const otherToken = await revisionOf(other, bob.cookie);
  const shared = randomUUID();
  assert.equal((await title(other, bob.cookie, { commandId: shared, title: "Renamed", expectedRevision: otherToken })).status, 200);
  assert.deepEqual(await (await delStatus(other, bob.cookie, command(await revisionOf(other, bob.cookie), shared))).json(), { status: "not_recorded" });
  assert.equal((await del(other, bob.cookie, command(await revisionOf(other, bob.cookie), shared))).status, 200);
});

test("status is not_recorded before, committed after (task gone), conflict for another payload, and 404 for anyone without a receipt", async () => {
  const taskId = sharedTask();
  const [alice, bob, carol, dave] = [login("alice"), login("bob"), login("carol"), login("dave")];
  const token = await revisionOf(taskId, bob.cookie);
  const input = command(token);
  const before = world();
  assert.deepEqual(await (await delStatus(taskId, bob.cookie, input)).json(), { status: "not_recorded" });
  assert.deepEqual(await (await delStatus(taskId, alice.cookie, input)).json(), { status: "not_recorded" });
  assert.deepEqual(world(), before, "status never writes");

  assert.equal((await del(taskId, bob.cookie, input)).status, 200);
  const settled = world();
  const committed = await delStatus(taskId, bob.cookie, input);
  assert.equal(committed.status, 200);
  assert.equal(committed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await committed.json(), { status: "committed" });
  const conflicting = await delStatus(taskId, bob.cookie, { ...input, expectedRevision: "c".repeat(64) });
  assert.equal(conflicting.status, 409);
  assert.deepEqual(await conflicting.json(), { error: "Revision conflict", code: "idempotency_conflict" });
  // Admin A has write right in the tombstone's Area but no receipt: same 404 as for a missing ID.
  const missing = await fingerprint(await delStatus("no-such-task", alice.cookie, input));
  assert.equal(await fingerprint(await delStatus(taskId, alice.cookie, input)), missing);
  for (const who of [carol, dave]) {
    assert.equal(await fingerprint(await delStatus(taskId, who.cookie, input)), missing);
  }
  assert.deepEqual(world(), settled);
});

test("viewer, non-member, foreign private owner and missing ID are indistinguishable for delete and status, before AND after the tombstone", async () => {
  const live = sharedTask();
  const tombstoned = sharedTask();
  const bob = login("bob");
  const liveToken = await revisionOf(live, bob.cookie);
  const goneToken = await revisionOf(tombstoned, bob.cookie);
  assert.equal((await del(tombstoned, bob.cookie, command(goneToken))).status, 200);
  const [carol, dave, erin] = [login("carol"), login("dave"), login("erin")];
  const before = world();
  const stale = "a".repeat(64);
  const prints = new Set();
  for (const who of [carol, dave, erin]) {
    for (const [id, token] of [[live, liveToken], [tombstoned, goneToken], ["alice-private", stale],
      ["bob-private-task", stale], ["no-such-task", stale]]) {
      prints.add(await fingerprint(await del(id, who.cookie, command(token))));
      prints.add(await fingerprint(await delStatus(id, who.cookie, command(token))));
    }
  }
  // Even an editor of team-area cannot reach the other Area, foreign private tasks or the missing ID.
  for (const id of ["other-task", "alice-private", "no-such-task"]) {
    prints.add(await fingerprint(await del(id, bob.cookie, command(stale))));
    prints.add(await fingerprint(await delStatus(id, bob.cookie, command(stale))));
  }
  assert.equal(prints.size, 1, [...prints].join("\n"));
  const only = JSON.parse([...prints][0]);
  assert.equal(only.status, 404);
  assert.equal(only.headers["cache-control"], "no-store");
  assert.equal(only.body, JSON.stringify({ error: "Not found" }));
  assert.deepEqual(world(), before);
});

test("a stale expectedRevision writes nothing and answers 409 stale_revision", async () => {
  const taskId = sharedTask();
  const [alice, bob] = [login("alice"), login("bob")];
  const token = await revisionOf(taskId, bob.cookie);
  assert.equal((await title(taskId, alice.cookie, { commandId: randomUUID(), title: "Moved on", expectedRevision: token })).status, 200);
  const before = world();
  const refused = await del(taskId, bob.cookie, command(token));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "Revision conflict", code: "stale_revision" });
  assert.deepEqual(world(), before);
  assert.equal(count(`SELECT COUNT(*) AS n FROM tasks WHERE id='${taskId}'`), 1);
  assert.deepEqual(await (await delStatus(taskId, bob.cookie, command(token))).json(), { status: "not_recorded" });
  // Reassigning (policy/assignee change) also moves the token.
  const fresh = await revisionOf(taskId, bob.cookie);
  db.prepare("UPDATE tasks SET assignee_user_id='bob' WHERE id=?").run(taskId);
  assert.equal((await del(taskId, bob.cookie, command(fresh))).status, 409);
  assert.equal(count(`SELECT COUNT(*) AS n FROM tasks WHERE id='${taskId}'`), 1);
});

test("a durable session revoked between dispatch and the write transaction writes nothing", async () => {
  const taskId = sharedTask();
  const bob = login("bob");
  const token = await revisionOf(taskId, bob.cookie);
  const before = world();
  const response = await withChildGatedBeforeStart(
    () => del(taskId, bob.cookie, command(token)),
    async () => { assert.equal(durable.revokeDurableTargetStagingSession(store, bob.sessionId).ok, true); });
  assert.equal(response.status, 401);
  assert.deepEqual(world(), before);
  assert.equal(count(`SELECT COUNT(*) AS n FROM tasks WHERE id='${taskId}'`), 1);
  assert.equal((await delStatus(taskId, bob.cookie, command(token))).status, 401);
});

test("demotion or removal after the delete hides the stored result; a restored role replays it", async () => {
  const taskId = sharedTask();
  const bob = login("bob");
  const input = command(await revisionOf(taskId, bob.cookie));
  assert.equal((await del(taskId, bob.cookie, input)).status, 200);
  try {
    assert.equal((await setRole("bob", "viewer")).status, 200);
    const settled = world();
    assert.equal((await del(taskId, bob.cookie, input)).status, 404);
    assert.equal((await delStatus(taskId, bob.cookie, input)).status, 404);
    assert.deepEqual(world(), settled);
  } finally {
    assert.equal((await setRole("bob", "editor")).status, 200);
  }
  assert.deepEqual(await (await del(taskId, bob.cookie, input)).json(), { ok: true, replayed: true });
  assert.deepEqual(await (await delStatus(taskId, bob.cookie, input)).json(), { status: "committed" });
  assert.equal((await removeMember("bob")).status, 200);
  try {
    assert.equal((await del(taskId, bob.cookie, input)).status, 404);
  } finally {
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  }
});

test("race inside the dispatch window: demotion committed before the write transaction opens -> 404, nothing deleted", async () => {
  const taskId = sharedTask();
  const bob = login("bob");
  const token = await revisionOf(taskId, bob.cookie);
  const before = world();
  try {
    const response = await withChildGatedBeforeStart(
      () => del(taskId, bob.cookie, command(token)),
      async () => mutateElsewhere("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'"));
    assert.equal(response.status, 404);
    assert.equal(count(`SELECT COUNT(*) AS n FROM tasks WHERE id='${taskId}'`), 1);
    // The two membership log entries of this race are the only difference.
    assert.deepEqual({ ...world(), log: 0, metadata: 0, epochs: "" }, { ...before, log: 0, metadata: 0, epochs: "" });
  } finally {
    db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  }
});

test("deleting an assigned task is allowed for editors; afterwards the assignee can be removed with nothing to unassign", async () => {
  const taskId = sharedTask("as", { assignee: "bob" });
  const alice = login("alice");
  assert.equal((await del(taskId, alice.cookie, command(await revisionOf(taskId, alice.cookie)))).status, 200);
  const removed = await removeMember("bob");
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).unassignedTasks, 0);
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  assert.deepEqual(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).issues, []);
});

test("a re-created ID is rejected by SQLite; revision and tombstone remain (no ABA)", async () => {
  const taskId = sharedTask();
  const bob = login("bob");
  assert.equal((await del(taskId, bob.cookie, command(await revisionOf(taskId, bob.cookie)))).status, 200);
  const tombstone = { ...db.prepare("SELECT * FROM task_tombstones WHERE id=?").get(taskId) };
  const before = world();
  for (const verb of ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"]) {
    assert.throws(() => db.prepare(`${verb} INTO tasks(id,area_id,title) VALUES (?, 'team-area', 'Resurrected')`).run(taskId),
      /task replacement is not allowed/, verb);
  }
  assert.deepEqual(world(), before);
  assert.deepEqual({ ...db.prepare("SELECT * FROM task_tombstones WHERE id=?").get(taskId) }, tombstone);
  assert.equal((await detail(taskId, bob.cookie)).status, 404);
});

test("page cursors over the Area are invalidated by a delete; a fresh listing no longer contains the task", async () => {
  const [a, b, c] = [sharedTask("cur"), sharedTask("cur"), sharedTask("cur")];
  const alice = login("alice");
  const first = await (await list("?scope=shared&limit=1", alice.cookie)).json();
  assert.ok(first.nextCursor, "more than one shared task");
  const bob = login("bob");
  assert.equal((await del(b, bob.cookie, command(await revisionOf(b, bob.cookie)))).status, 200);
  const stale = await list(`?scope=shared&limit=1&cursor=${first.nextCursor}`, alice.cookie);
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /Cursor stale|read_stale_reload/);
  const restarted = await (await list("?scope=shared&limit=50", alice.cookie)).json();
  const ids = restarted.tasks.map(task => task.id);
  assert.ok(ids.includes(a) && ids.includes(c) && !ids.includes(b));
});

test("HTTP gates: disabled flags, auth, origin, body, method shape and rate limits refuse before any mutation", async () => {
  const taskId = sharedTask();
  const bob = login("bob");
  const token = await revisionOf(taskId, bob.cookie);
  const input = command(token);
  const before = world();
  for (const call of [(c) => del(taskId, c, input), (c) => delStatus(taskId, c, input)]) {
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "false";
    assert.equal((await call(bob.cookie)).status, 404);
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
    assert.equal((await call(bob.cookie)).status, 404);
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
    const noAuth = await call(null);
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get("cache-control"), "no-store");
  }
  for (const send of [del, delStatus]) {
    assert.equal((await send(taskId, bob.cookie, input, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await send(taskId, bob.cookie, input, { headers: { origin: "" } })).status, 403);
    assert.equal((await send(taskId, bob.cookie, input, { query: "?x=1" })).status, 400);
    for (const extra of [{ title: "x" }, { actorUserId: "alice" }, { areaId: "team-area" }, { scope: "shared" }, { taskId }]) {
      assert.equal((await send(taskId, bob.cookie, { ...input, ...extra })).status, 400, JSON.stringify(extra));
    }
    assert.equal((await send(taskId, bob.cookie, { commandId: input.commandId })).status, 400);
    assert.equal((await send(taskId, bob.cookie, { ...input, expectedRevision: "wrong" })).status, 400);
    assert.equal((await send(taskId, bob.cookie, { ...input, commandId: "not-a-uuid" })).status, 400);
    assert.equal((await send(taskId, bob.cookie, [input])).status, 400);
    assert.equal((await send(taskId, bob.cookie, null, { raw: Buffer.alloc(32 * 1024 + 1, 0x20) })).status, 413);
    const malformed = Buffer.from(JSON.stringify(input));
    malformed[malformed.indexOf(Buffer.from(input.commandId.slice(0, 4)))] = 0xc3;
    assert.equal((await send(taskId, bob.cookie, null, { raw: malformed })).status, 400);
  }
  assert.equal((await del("x".repeat(600), bob.cookie, input)).status, 400, "oversized task ID");
  assert.deepEqual(world(), before);
  assert.equal(count(`SELECT COUNT(*) AS n FROM tasks WHERE id='${taskId}'`), 1);

  // The limiter runs after admission and before the body: one client is cut off.
  for (const [send, limit] of [[del, 30], [delStatus, 60]]) {
    const fixedIp = `10.77.0.${send === del ? 1 : 2}`;
    let blocked = null;
    for (let i = 0; i < limit + 2 && !blocked; i++) {
      const response = await send(taskId, bob.cookie, {}, { headers: { "x-forwarded-for": fixedIp } });
      if (response.status === 429) blocked = response;
      else assert.equal(response.status, 400);
    }
    assert.ok(blocked, "rate limited");
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal(blocked.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(world(), before);
});

test("preflight checks the delete ledger: a receipt-less or mismatching audit row, or a bad receipt, fails the store closed", () => {
  const { s, writer, authority } = libFixture();
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('t','team-area','x')").run();
  const write = authority.issueWritable("alice");
  const request = { commandId: randomUUID(), taskId: "t", expectedRevision: token(authority, write.sessionToken, "t") };
  assert.deepEqual(authority.deleteTask(write.sessionToken, request), { ok: true });
  const issues = () => inspectIsolatedTargetStore({ stagingDirectory: s.directory, mode: "r2-model" }).issues;
  assert.deepEqual(issues(), []);
  const receipt = writer.prepare("SELECT key, value FROM metadata WHERE key LIKE ?").get(TARGET_STAGING_DELETE_RECEIPT_PREFIX + "%");
  writer.prepare("DELETE FROM metadata WHERE key=?").run(receipt.key);
  assert.ok(issues().includes("audit_invalid") || issues().includes("metadata_invalid"), "audit without receipt");
  writer.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receipt.key, receipt.value);
  assert.deepEqual(issues(), []);
  writer.prepare("UPDATE metadata SET value='not-a-digest' WHERE key=?").run(receipt.key);
  assert.ok(issues().includes("metadata_invalid"));
  writer.prepare("UPDATE metadata SET value=? WHERE key=?").run(receipt.value, receipt.key);
  writer.prepare("INSERT INTO metadata(key,value) VALUES (?, 'x')").run(TARGET_STAGING_DELETE_RECEIPT_PREFIX + "zz");
  assert.ok(issues().includes("metadata_invalid"), "malformed delete receipt key");
  writer.prepare("DELETE FROM metadata WHERE key=?").run(TARGET_STAGING_DELETE_RECEIPT_PREFIX + "zz");
  // Audit row pointing at another tombstone revision.
  const ddl = writer.prepare("SELECT sql FROM sqlite_schema WHERE name='task_delete_audit_no_update'").get().sql;
  writer.exec("DROP TRIGGER task_delete_audit_no_update; UPDATE task_delete_audit SET change_seq=change_seq+1; " + ddl);
  assert.deepEqual(issues(), ["audit_invalid"]);
});

// ------------------------------------------------------------ library level
const libs = [];
function libFixture() {
  const s = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, randomUUID()), ownerUserId: "alice" });
  const writer = new DatabaseSync(s.databasePath);
  writer.exec("PRAGMA foreign_keys=ON");
  writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
  const authority = new TargetStagingSessionAuthority({ stagingDirectory: s.directory, expectedRestoreGeneration: s.restoreGeneration });
  libs.push({ writer, authority });
  return { s, writer, authority };
}
after(() => { for (const { writer, authority } of libs) { authority.close(); writer.close(); } });
const token = (authority, session, taskId) => {
  const result = authority.previewTaskTitleEdit(session, { taskId });
  assert.equal(result.ok, true);
  return result.snapshotRevision;
};

test("library: replay, conflict, read-only audience and invalid shapes", () => {
  const { writer, authority } = libFixture();
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('t','team-area','x')").run();
  const write = authority.issueWritable("alice");
  const read = authority.issue("alice");
  const expectedRevision = token(authority, write.sessionToken, "t");
  const commandId = randomUUID();
  const request = { commandId, taskId: "t", expectedRevision };
  assert.deepEqual(authority.deleteTask(read.sessionToken, request), { ok: false, reason: "unauthorized" });
  assert.deepEqual(authority.taskDeleteCommandStatus(read.sessionToken, request), { ok: false, reason: "unauthorized" });
  for (const bad of [{ ...request, title: "x" }, { ...request, commandId: "nope" }, { commandId, taskId: "t" },
    { ...request, expectedRevision: "abc" }, { ...request, taskId: "" }, null, []]) {
    assert.deepEqual(authority.deleteTask(write.sessionToken, bad), { ok: false, reason: "invalid_request" });
    assert.deepEqual(authority.taskDeleteCommandStatus(write.sessionToken, bad), { ok: false, reason: "invalid_request" });
  }
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM task_tombstones").get().n, 0);
  assert.deepEqual(authority.taskDeleteCommandStatus(write.sessionToken, request), { ok: true, status: "not_recorded" });
  assert.deepEqual(authority.deleteTask(write.sessionToken, request), { ok: true });
  assert.deepEqual(authority.deleteTask(write.sessionToken, request), { ok: true, replayed: true });
  assert.deepEqual(authority.deleteTask(write.sessionToken, { ...request, expectedRevision: "d".repeat(64) }),
    { ok: false, reason: "idempotency_conflict" });
  assert.deepEqual(authority.taskDeleteCommandStatus(write.sessionToken, request), { ok: true, status: "committed" });
  assert.deepEqual(authority.deleteTask(write.sessionToken, { ...request, commandId: randomUUID() }),
    { ok: false, reason: "unavailable" });
  assert.deepEqual(authority.deleteTask(write.sessionToken, { ...request, taskId: "missing", expectedRevision }),
    { ok: false, reason: "unavailable" });
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM task_delete_audit").get().n, 1);
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM change_log WHERE op='tombstone'").get().n, 1);
});

test("library: a store that fails canonical preflight (guard dropped, or old schema) deletes nothing", () => {
  const { s, writer, authority } = libFixture();
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('t','team-area','x')").run();
  const write = authority.issueWritable("alice");
  const expectedRevision = token(authority, write.sessionToken, "t");
  writer.exec("DROP TRIGGER task_tombstones_no_delete");
  assert.deepEqual(authority.deleteTask(write.sessionToken, { commandId: randomUUID(), taskId: "t", expectedRevision }),
    { ok: false, reason: "unauthorized" });
  writer.exec("UPDATE metadata SET value='7' WHERE key='schema_version'");
  assert.deepEqual(authority.deleteTask(write.sessionToken, { commandId: randomUUID(), taskId: "t", expectedRevision }),
    { ok: false, reason: "unauthorized" });
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM task_tombstones").get().n, 0);
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: s.directory, mode: "r2-model" }).ok, false);
});

test("library: a full delete ledger (tombstones, receipts, audit at the cap) fails closed without writing; title commands keep their own budget", () => {
  const crowded = libFixture();
  const { writer } = crowded;
  const insertTask = writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?, 'team-area', 'x')");
  const tomb = writer.prepare("INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms) VALUES (?, 'team-area', 1, ?, 1)");
  const receipt = writer.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
  const auditRow = writer.prepare(`INSERT INTO task_delete_audit(receipt_key,actor_user_id,task_id,area_id,policy_revision,
    revision_before,tombstone_revision,change_seq,expected_revision,restore_generation,committed_at_ms)
    VALUES (?, 'alice', ?, 'team-area', 0, 0, 1, ?, ?, ?, 1)`);
  writer.exec("BEGIN");
  for (let i = 0; i < TARGET_STAGING_MAX_TOMBSTONES; i++) {
    insertTask.run(`c-${i}`);
    const seq = writer.prepare("SELECT MAX(seq)+1 AS n FROM change_log").get().n;
    tomb.run(`c-${i}`, seq);
    writer.prepare("DELETE FROM tasks WHERE id=?").run(`c-${i}`);
    const hash = createHash("sha256").update(String(i)).digest("hex");
    receipt.run(TARGET_STAGING_DELETE_RECEIPT_PREFIX + hash, hash);
    auditRow.run(TARGET_STAGING_DELETE_RECEIPT_PREFIX + hash, `c-${i}`, seq, hash, crowded.s.restoreGeneration);
  }
  writer.exec("COMMIT");
  assert.equal(TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_MAX_TOMBSTONES);
  assert.deepEqual(inspectIsolatedTargetStore({ stagingDirectory: crowded.s.directory, mode: "r2-model" }).issues, []);
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('last','team-area','x')").run();
  const b = crowded.authority.issueWritable("alice");
  const lastRevision = token(crowded.authority, b.sessionToken, "last");
  assert.deepEqual(crowded.authority.deleteTask(b.sessionToken, { commandId: randomUUID(), taskId: "last", expectedRevision: lastRevision }),
    { ok: false, reason: "write_failed" });
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='last'").get().n, 1);
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM task_tombstones").get().n, TARGET_STAGING_MAX_TOMBSTONES);
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM task_delete_audit").get().n, TARGET_STAGING_MAX_TOMBSTONES);
  assert.deepEqual(crowded.authority.updateTaskTitle(b.sessionToken,
    { commandId: randomUUID(), taskId: "last", title: "still works", expectedRevision: lastRevision }), { ok: true });
});

test("preflight: a raw delete receipt without an audit row (live task) is rejected and never replays", () => {
  const { s, writer, authority } = libFixture();
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('live','team-area','x')").run();
  const write = authority.issueWritable("alice");
  const request = { commandId: randomUUID(), taskId: "live", expectedRevision: token(authority, write.sessionToken, "live") };
  const key = TARGET_STAGING_DELETE_RECEIPT_PREFIX + createHash("sha256")
    .update(JSON.stringify(["alice", "live", request.commandId])).digest("hex");
  const digest = createHash("sha256").update(JSON.stringify(["task-delete-v1", "live", request.expectedRevision])).digest("hex");
  writer.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(key, digest);
  assert.ok(inspectIsolatedTargetStore({ stagingDirectory: s.directory, mode: "r2-model" }).issues.includes("audit_invalid"));
  assert.deepEqual(authority.deleteTask(write.sessionToken, request), { ok: false, reason: "unauthorized" });
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
});

test("library: the session recheck immediately before COMMIT rolls back tombstone, delete, log, receipt and audit", () => {
  const { writer, authority, s } = libFixture();
  writer.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
  writer.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
  writer.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob','private','bob-personal','bob','unassigned')").run();
  writer.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  writer.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('t','team-area','x')").run();
  const issued = durable.issueDurableTargetStagingSession(
    { stagingDirectory: s.directory, expectedRestoreGeneration: s.restoreGeneration }, "bob", 120);
  assert.equal(issued.ok, true);
  const tokenHash = createHash("sha256").update(issued.sessionToken).digest("hex");
  const write = authority.issueWritable("bob");
  const request = { commandId: randomUUID(), taskId: "t", expectedRevision: token(authority, write.sessionToken, "t") };
  const snap = () => JSON.stringify([
    writer.prepare("SELECT COUNT(*) AS n FROM tasks").get().n,
    writer.prepare("SELECT COUNT(*) AS n FROM task_tombstones").get().n,
    writer.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM change_log").get().n,
    writer.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?").get(TARGET_STAGING_DELETE_RECEIPT_PREFIX + "%").n,
    writer.prepare("SELECT COUNT(*) AS n FROM task_delete_audit").get().n,
    writer.prepare("SELECT content_revision AS n FROM areas WHERE id='team-area'").get().n,
  ]);
  const before = snap();
  const realNow = Date.now;
  const realPrepare = DatabaseSync.prototype.prepare;
  let skew = 0;
  try {
    // Session live at the first in-transaction check, expired by the second (after the audit INSERT).
    Date.now = () => realNow() + skew;
    DatabaseSync.prototype.prepare = function (sql) {
      if (/^\s*INSERT INTO task_delete_audit/.test(sql)) skew = 10 * 60 * 1000;
      return realPrepare.call(this, sql);
    };
    const result = authority.deleteTask(write.sessionToken, request, false, tokenHash);
    assert.deepEqual(result, { ok: false, reason: "session_revoked" });
    assert.ok(skew > 0, "the audit INSERT was reached before the second check");
  } finally {
    Date.now = realNow;
    DatabaseSync.prototype.prepare = realPrepare;
  }
  assert.equal(snap(), before);
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id='t'").get().n, 1);
});
