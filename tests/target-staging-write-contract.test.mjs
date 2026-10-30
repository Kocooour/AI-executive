import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2c.3: the identity-bound per-item write contract on EVERY write target endpoint
// (title PATCH, title status, delete, delete status, membership command): protocol
// header, legacy-snapshot barrier, explicit writeAreaId, restoreGeneration, and the
// fixed check order. Synthetic temp store only. Roles: alice owner cookie + admin of
// team-area and team2-area, bob editor of both, carol viewer of team-area,
// dave non-member, erin admin of other-area (bob/carol/dave have no right there).
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2c3-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
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
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-r2c3-session-secret-2026-10-30";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { PROTOCOL_HEADER } = await import("./support/target-write-contract.mjs");
const { GET: PREVIEW, PATCH } = await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const { POST: TITLE_STATUS } = await import("../app/api/target-staging/tasks/[taskId]/title/status/route.ts");
const { POST: DELETE_TASK } = await import("../app/api/target-staging/tasks/[taskId]/delete/route.ts");
const { POST: DELETE_STATUS } = await import("../app/api/target-staging/tasks/[taskId]/delete/status/route.ts");
const feedCursor = await import("../lib/target-staging-feed-cursor.ts");
const { GET: FEED } = await import("../app/api/target-staging/changes/route.ts");
const { GET: DETAIL } = await import("../app/api/target-staging/tasks/[taskId]/route.ts");
const { POST: MEMBERS } = await import("../app/api/target-staging/areas/[areaId]/members/route.ts");

const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
const GEN = stage.restoreGeneration;
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
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team2','shared','alice')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team2-area','Team 2','shared','team2','alice')").run();
db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('other','shared','erin')").run();
db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('other-area','Other','shared','other','erin')").run();
const member = db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)");
for (const area of ["team-area", "team2-area"]) { member.run(area, "alice", "admin"); member.run(area, "bob", "editor"); }
member.run("team-area", "carol", "viewer");
member.run("other-area", "erin", "admin");

let taskCounter = 0;
function newTask(areaId = "team-area") {
  const id = `c-${++taskCounter}`;
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)").run(id, areaId, `${id} original`);
  return id;
}

after(() => {
  db.close();
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers
const base = "http://localhost:3001/api/target-staging/";
const ownerCookie = `${sessionCookieName}=${createSessionToken()}`;
const login = user => {
  const issued = durable.issueDurableTargetStagingSession(store, user, 900);
  assert.equal(issued.ok, true, JSON.stringify(issued));
  return { ...issued, user, cookie: `${durable.TARGET_STAGING_SESSION_COOKIE}=${issued.sessionToken}` };
};
let client = 0;
const ip = () => `10.9.${Math.floor(++client / 250)}.${client % 250 + 1}`;
function request(pathname, method, { cookie, body, raw, protocol = ["1"], clientIp } = {}) {
  const headers = new Headers({ "content-type": "application/json", origin: "http://localhost:3001",
    "x-forwarded-for": clientIp || ip() });
  if (cookie) headers.set("cookie", cookie);
  for (const value of protocol) headers.append(PROTOCOL_HEADER, value);
  return new Request(base + pathname, { method, headers, body: raw ?? JSON.stringify(body) });
}
const ctx = taskId => ({ params: Promise.resolve({ taskId }) });
const KINDS = {
  title: (id, init) => PATCH(request(`tasks/${id}/title`, "PATCH", init), ctx(id)),
  titleStatus: (id, init) => TITLE_STATUS(request(`tasks/${id}/title/status`, "POST", init), ctx(id)),
  delete: (id, init) => DELETE_TASK(request(`tasks/${id}/delete`, "POST", init), ctx(id)),
  deleteStatus: (id, init) => DELETE_STATUS(request(`tasks/${id}/delete/status`, "POST", init), ctx(id)),
};
const members = (areaId, init) =>
  MEMBERS(request(`areas/${areaId}/members`, "POST", init), { params: Promise.resolve({ areaId }) });
const revisionOf = async (taskId, cookie) => {
  const response = await DETAIL(request(`tasks/${taskId}`, "GET", { cookie, protocol: [] }), ctx(taskId));
  assert.equal(response.status, 200, `detail ${taskId}`);
  return (await response.json()).snapshotRevision;
};
/** A well-formed per-item command for the given kind. */
const goodBody = (kind, expectedRevision, writeAreaId = "team-area", extra = {}) => ({
  commandId: randomUUID(), expectedRevision, writeAreaId, restoreGeneration: GEN,
  ...(kind.startsWith("title") ? { title: `T ${randomUUID()}` } : {}), ...extra,
});
const memberBody = (areaId, extra = {}) => ({
  commandId: randomUUID(), expectedPolicyRevision: db.prepare("SELECT policy_revision AS r FROM areas WHERE id=?").get(areaId)?.r ?? 0,
  action: "add", targetUserId: "dave", role: "viewer", writeAreaId: areaId, restoreGeneration: GEN, ...extra,
});
const count = sql => db.prepare(sql).get().n;
/** Everything any write endpoint may touch, as one comparable value. */
const world = () => JSON.stringify({
  tasks: db.prepare("SELECT id,title,revision,area_id FROM tasks ORDER BY id").all(),
  tombstones: db.prepare("SELECT id,area_id,revision FROM task_tombstones ORDER BY id").all(),
  // anchor_seq (R2c.4a) advances with every committed write incl. test-side login() session
  // issuance; it is asserted in target-staging-anchor-journal.test.mjs.
  metadata: db.prepare("SELECT key,value FROM metadata WHERE key<>'anchor_seq' ORDER BY key").all(),
  titleAudit: count("SELECT COUNT(*) AS n FROM task_title_audit"),
  deleteAudit: count("SELECT COUNT(*) AS n FROM task_delete_audit"),
  membershipAudit: count("SELECT COUNT(*) AS n FROM area_membership_audit"),
  membershipReceipts: count("SELECT COUNT(*) AS n FROM area_membership_receipts"),
  log: count("SELECT COALESCE(MAX(seq),0) AS n FROM change_log"),
  areas: db.prepare("SELECT id,policy_revision,content_revision FROM areas ORDER BY id").all(),
  members: db.prepare("SELECT area_id,user_id,role FROM area_members ORDER BY area_id,user_id").all(),
});
const NOISE_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);
const fingerprint = async response => JSON.stringify({
  status: response.status,
  headers: Object.fromEntries([...response.headers.entries()]
    .filter(([name]) => !NOISE_HEADERS.has(name.toLowerCase())).sort(([a], [b]) => a < b ? -1 : 1)),
  body: await response.json(),
});
const PROTOCOL_BODY = { error: "Invalid request", code: "protocol_unsupported" };
const LEGACY_BODY = { error: "Invalid request", code: "legacy_snapshot_rejected" };
const RESYNC_BODY = { error: "Resync required", code: "resync_required" };
const MISMATCH_BODY = { error: "Revision conflict", code: "write_area_mismatch" };
/** Send and assert status + body, and that NOTHING was written (unless `moves` first changed the world). */
async function refused(send, status, body) {
  const before = world();
  const response = await send();
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  if (body !== undefined) assert.deepEqual(await response.json(), body);
  assert.equal(world(), before, "a refused command wrote something");
}

// ------------------------------------------------------------------ positive control
for (const kind of Object.keys(KINDS)) {
  test(`${kind}: a well-formed per-item command is accepted`, async () => {
    const bob = login("bob");
    const taskId = newTask();
    const response = await KINDS[kind](taskId, { cookie: bob.cookie,
      body: goodBody(kind, await revisionOf(taskId, bob.cookie)) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(),
      kind.endsWith("Status") ? { status: "not_recorded" } : { ok: true });
  });
}

// ------------------------------------------------------------------ the matrix for the four task endpoints
for (const kind of Object.keys(KINDS)) {
  test(`${kind}: protocol header must be exactly one "1"`, async () => {
    const bob = login("bob");
    const taskId = newTask();
    const body = goodBody(kind, await revisionOf(taskId, bob.cookie));
    for (const protocol of [[], ["2"], ["0"], [""], ["1", "1"], ["1", "2"], ["01"], ["1.0"], ["true"]]) {
      await refused(() => KINDS[kind](taskId, { cookie: bob.cookie, body, protocol }), 400, PROTOCOL_BODY);
    }
  });

  test(`${kind}: snapshot-shaped payloads are rejected before key-set validation`, async () => {
    const bob = login("bob");
    const taskId = newTask();
    const body = goodBody(kind, await revisionOf(taskId, bob.cookie));
    for (const payload of [
      { entities: [], relations: [], baseRevision: "r" }, { entities: [] }, { relations: {} },
      { baseRevision: "a".repeat(64) }, { ...body, entities: [] }, { ...body, baseRevision: "x" },
      { ...body, relations: [], writeAreaId: undefined },
    ]) {
      await refused(() => KINDS[kind](taskId, { cookie: bob.cookie, body: payload }), 400, LEGACY_BODY);
    }
  });

  test(`${kind}: a missing, malformed or unknown field is a plain 400`, async () => {
    const bob = login("bob");
    const taskId = newTask();
    const body = goodBody(kind, await revisionOf(taskId, bob.cookie));
    for (const payload of [
      { ...body, writeAreaId: undefined }, { ...body, restoreGeneration: undefined },
      { ...body, writeAreaId: "" }, { ...body, writeAreaId: "bad id" }, { ...body, writeAreaId: 7 },
      { ...body, writeAreaId: null }, { ...body, restoreGeneration: "not-a-uuid" },
      { ...body, restoreGeneration: 1 }, { ...body, actorUserId: "alice" },
    ]) {
      await refused(() => KINDS[kind](taskId, { cookie: bob.cookie, body: payload }), 400,
        { error: "Invalid request" });
    }
  });

  test(`${kind}: a foreign or non-existent writeAreaId is the very 404 of a missing task`, async () => {
    const bob = login("bob");
    const taskId = newTask();
    const revision = await revisionOf(taskId, bob.cookie);
    const missing = await fingerprint(await KINDS[kind]("missing-task", { cookie: bob.cookie,
      body: goodBody(kind, revision, "no-such-area") }));
    assert.equal(JSON.parse(missing).status, 404);
    for (const areaId of ["other-area", "no-such-area", "erin-private", "carol-private", stage.unassignedAreaId]) {
      const before = world();
      const response = await KINDS[kind](taskId, { cookie: bob.cookie, body: goodBody(kind, revision, areaId) });
      assert.equal(await fingerprint(response), missing, areaId);
      assert.equal(world(), before);
    }
    // A viewer, a non-member and a foreign actor never get past the task right either.
    for (const user of ["carol", "dave", "erin"]) {
      const who = login(user);
      const response = await KINDS[kind](taskId, { cookie: who.cookie, body: goodBody(kind, revision) });
      assert.equal(await fingerprint(response), missing, user);
    }
    // Even a perfect writeAreaId does not help an actor without the task right.
    const response = await KINDS[kind](taskId, { cookie: login("erin").cookie,
      body: goodBody(kind, revision, "other-area") });
    assert.equal(await fingerprint(response), missing, "erin names her own Area");
  });

  test(`${kind}: another Area the actor may write, but not the task's, is 409 write_area_mismatch`, async () => {
    const bob = login("bob");
    const taskId = newTask();
    const revision = await revisionOf(taskId, bob.cookie);
    // team2-area (shared editor) and bob-private (private owner) are both writable by bob.
    for (const areaId of ["team2-area", "bob-private"]) {
      await refused(() => KINDS[kind](taskId, { cookie: bob.cookie,
        body: goodBody(kind, revision, areaId) }), 409, MISMATCH_BODY);
    }
    // The owner cookie behaves the same (alice administers both shared Areas).
    await refused(() => KINDS[kind](taskId, { cookie: ownerCookie,
      body: goodBody(kind, revision, "team2-area") }), 409, MISMATCH_BODY);
  });

  test(`${kind}: a concurrent move between preview and write is a mismatch, not a write`, async () => {
    const bob = login("bob");
    const taskId = newTask("team-area");
    const revision = await revisionOf(taskId, bob.cookie);
    const body = goodBody(kind, revision, "team-area");
    db.prepare("UPDATE tasks SET area_id='team2-area' WHERE id=?").run(taskId);
    await refused(() => KINDS[kind](taskId, { cookie: bob.cookie, body }), 409, MISMATCH_BODY);
    // Naming the new Area passes the Area check and then fails the revision CAS.
    const fresh = goodBody(kind, revision, "team2-area");
    if (kind === "title" || kind === "delete") {
      await refused(() => KINDS[kind](taskId, { cookie: bob.cookie, body: fresh }), 409);
    }
  });

  test(`${kind}: a stale restoreGeneration is 409 resync_required and reveals nothing about tasks`, async () => {
    const bob = login("bob");
    const taskId = newTask();
    const revision = await revisionOf(taskId, bob.cookie);
    const stale = randomUUID();
    for (const [id, cookie, areaId] of [
      [taskId, bob.cookie, "team-area"], [taskId, bob.cookie, "other-area"],
      [taskId, login("dave").cookie, "team-area"], ["missing-task", bob.cookie, "no-such-area"],
    ]) {
      await refused(() => KINDS[kind](id, { cookie,
        body: goodBody(kind, revision, areaId, { restoreGeneration: stale }) }), 409,
      { error: "Resync required", code: "resync_required" });
    }
  });

  test(`${kind}: ordering, a dead session is the coded 401 before the protocol check`, async () => {
    const taskId = newTask();
    const dead = login("bob");
    const revision = await revisionOf(taskId, dead.cookie);
    assert.equal(durable.revokeDurableTargetStagingSession(store, dead.sessionId).ok, true);
    const live = login("bob");
    for (const [cookie, status, body] of [
      [dead.cookie, 401, { error: "Authentication required", code: "session_revoked" }],
      [live.cookie, 400, PROTOCOL_BODY],
    ]) {
      await refused(() => KINDS[kind](taskId, { cookie, protocol: [],
        body: goodBody(kind, revision) }), status, body);
    }
  });
}

// ------------------------------------------------------------------ protocol check runs before limiter and body read
test("the protocol check precedes the rate limiter and the body read", async () => {
  const bob = login("bob");
  const taskId = newTask();
  const clientIp = "10.77.1.1";
  for (let index = 0; index < 40; index++) {
    const response = await KINDS.title(taskId, { cookie: bob.cookie, protocol: [], clientIp, body: {} });
    assert.equal(response.status, 400, "never 429 while the header is missing");
  }
  const oversized = await KINDS.title(taskId, { cookie: bob.cookie, protocol: [], raw: Buffer.alloc(32 * 1024 + 1, 0x20) });
  assert.equal(oversized.status, 400, "an unversioned oversized body is refused before it is read");
  assert.deepEqual(await oversized.json(), PROTOCOL_BODY);
  // Versioned requests from the same client still have their full budget.
  const revision = await revisionOf(taskId, bob.cookie);
  const ok = await KINDS.title(taskId, { cookie: bob.cookie, clientIp, body: goodBody("title", revision) });
  assert.equal(ok.status, 200);
});

test("the title GET preview is a read: no protocol header needed", async () => {
  const bob = login("bob");
  const taskId = newTask();
  const response = await PREVIEW(request(`tasks/${taskId}/title`, "GET", { cookie: bob.cookie, protocol: [] }), ctx(taskId));
  assert.equal(response.status, 200);
  assert.match((await response.json()).snapshotRevision, /^[a-f0-9]{64}$/);
});

// ------------------------------------------------------------------ membership
test("membership: protocol, snapshot, field and restoreGeneration refusals write nothing", async () => {
  const alice = login("alice");
  const send = (extra = {}, init = {}) => members("team-area", { cookie: alice.cookie, body: memberBody("team-area", extra), ...init });
  for (const protocol of [[], ["2"], ["1", "1"]]) {
    await refused(() => send({}, { protocol }), 400, PROTOCOL_BODY);
  }
  for (const body of [{ entities: [], relations: [], baseRevision: "x" }, { ...memberBody("team-area"), entities: [] }]) {
    await refused(() => send({}, { body }), 400, LEGACY_BODY);
  }
  for (const extra of [{ writeAreaId: undefined }, { restoreGeneration: undefined }, { writeAreaId: "bad id" },
    { restoreGeneration: "nope" }, { actorUserId: "alice" }]) {
    await refused(() => send(extra), 400, { error: "Invalid request" });
  }
  await refused(() => send({ restoreGeneration: randomUUID() }), 409, { error: "Resync required", code: "resync_required" });
  // Store-level: a non-admin and an unknown Area get the same 409, before the admin check.
  await refused(() => members("team-area", { cookie: login("dave").cookie,
    body: memberBody("team-area", { restoreGeneration: randomUUID() }) }), 409, RESYNC_BODY);
  await refused(() => members("no-such-area", { cookie: alice.cookie,
    body: memberBody("no-such-area", { restoreGeneration: randomUUID() }) }), 409, RESYNC_BODY);
  const ok = await send({});
  assert.equal(ok.status, 200);
});

test("membership: writeAreaId different from the path is 400 BEFORE the admin check", async () => {
  const before = world();
  for (const user of ["alice", "bob", "carol", "dave", "erin"]) {
    const who = login(user);
    for (const writeAreaId of ["team2-area", "other-area", "no-such-area", "bob-private"]) {
      const response = await members("team-area", { cookie: who.cookie,
        body: memberBody("team-area", { writeAreaId }) });
      assert.equal(response.status, 400, `${user} -> ${writeAreaId}`);
      assert.deepEqual(await response.json(), { error: "Invalid request" });
    }
    // A non-existent path Area behaves the same: 400, not 404.
    const response = await members("no-such-area", { cookie: who.cookie,
      body: memberBody("no-such-area", { writeAreaId: "team-area" }) });
    assert.equal(response.status, 400, `${user} on a missing path Area`);
  }
  assert.equal(world(), before);
});

// ------------------------------------------------------------------ delete with a lost response
test("delete with a lost response: retry and status return the stored result; others learn nothing", async () => {
  const bob = login("bob");
  const taskId = newTask();
  const revision = await revisionOf(taskId, bob.cookie);
  const command = goodBody("delete", revision, "team-area");
  const deleted = await KINDS.delete(taskId, { cookie: bob.cookie, body: command });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  // The response "got lost": the exact retry and the status check still answer from the tombstone Area.
  const retry = await KINDS.delete(taskId, { cookie: bob.cookie, body: command });
  assert.deepEqual([retry.status, await retry.json()], [200, { ok: true, replayed: true }]);
  const status = await KINDS.deleteStatus(taskId, { cookie: bob.cookie, body: command });
  assert.deepEqual([status.status, await status.json()], [200, { status: "committed" }]);
  const stored = world();
  // Non-member, viewer, a foreign actor and even another WRITER of the Area (alice, no receipt) get the plain 404.
  const missing = await fingerprint(await KINDS.deleteStatus("missing-task", { cookie: bob.cookie,
    body: goodBody("deleteStatus", revision, "no-such-area") }));
  for (const user of ["dave", "carol", "erin", "alice"]) {
    for (const kind of ["delete", "deleteStatus"]) {
      const response = await KINDS[kind](taskId, { cookie: login(user).cookie, body: command });
      assert.equal(await fingerprint(response), missing, `${user} ${kind}`);
    }
  }
  assert.equal(world(), stored);
  // A retry naming another Area: the tombstone's Area decides. An Area bob may write is a
  // write_area_mismatch (checked BEFORE the receipt digest), one he may not write is the plain 404.
  for (const kind of ["delete", "deleteStatus"]) {
    await refused(() => KINDS[kind](taskId, { cookie: bob.cookie, body: { ...command, writeAreaId: "team2-area" } }), 409, MISMATCH_BODY);
    await refused(() => KINDS[kind](taskId, { cookie: bob.cookie, body: { ...command, writeAreaId: "other-area" } }), 404);
    await refused(() => KINDS[kind](taskId, { cookie: bob.cookie, body: { ...command, restoreGeneration: randomUUID() } }), 409,
      { error: "Resync required", code: "resync_required" });
  }
  // Still replayable afterwards.
  const again = await KINDS.deleteStatus(taskId, { cookie: bob.cookie, body: command });
  assert.deepEqual(await again.json(), { status: "committed" });
});

test("after a move the old Area is a mismatch and the current Area still verifies and replays the command", async () => {
  const bob = login("bob");
  const taskId = newTask("team-area");
  const command = goodBody("title", await revisionOf(taskId, bob.cookie), "team-area");
  assert.equal((await KINDS.title(taskId, { cookie: bob.cookie, body: command })).status, 200);
  db.prepare("UPDATE tasks SET area_id='team2-area' WHERE id=?").run(taskId);
  // The digest excludes writeAreaId. Old Area: the Area check fails first. Current Area: normal result.
  await refused(() => KINDS.title(taskId, { cookie: bob.cookie, body: command }), 409, MISMATCH_BODY);
  await refused(() => KINDS.titleStatus(taskId, { cookie: bob.cookie, body: command }), 409, MISMATCH_BODY);
  const current = { ...command, writeAreaId: "team2-area" };
  const status = await KINDS.titleStatus(taskId, { cookie: bob.cookie, body: current });
  assert.deepEqual([status.status, await status.json()], [200, { status: "committed" }]);
  const before = world();
  const replay = await KINDS.title(taskId, { cookie: bob.cookie, body: current });
  assert.deepEqual([replay.status, await replay.json()], [200, { ok: true, replayed: true }]);
  assert.equal(world(), before);
  // A changed payload is still an idempotency conflict.
  await refused(() => KINDS.title(taskId, { cookie: bob.cookie, body: { ...current, title: "Other" } }), 409,
    { error: "Revision conflict" });
});

test("delete oracle: a writer of the tombstone Area who did not delete cannot tell a deleted ID from a ghost", async () => {
  const bob = login("bob");
  const taskId = newTask();
  const command = goodBody("delete", await revisionOf(taskId, bob.cookie), "team-area");
  assert.equal((await KINDS.delete(taskId, { cookie: bob.cookie, body: command })).status, 200);
  const alice = login("alice"); // may write team-area AND team2-area, did not delete
  for (const kind of ["delete", "deleteStatus"]) {
    for (const areaId of ["team-area", "team2-area"]) {
      const body = { ...command, writeAreaId: areaId };
      const ghost = await fingerprint(await KINDS[kind]("ghost-task", { cookie: alice.cookie, body }));
      assert.equal(JSON.parse(ghost).status, 404);
      for (const cookie of [alice.cookie, ownerCookie]) {
        const before = world();
        assert.equal(await fingerprint(await KINDS[kind](taskId, { cookie, body })), ghost, `${kind} ${areaId}`);
        assert.equal(world(), before);
      }
    }
  }
  // The deleter's own retry with another writable Area still learns write_area_mismatch.
  for (const kind of ["delete", "deleteStatus"]) {
    await refused(() => KINDS[kind](taskId, { cookie: bob.cookie,
      body: { ...command, writeAreaId: "team2-area" } }), 409, MISMATCH_BODY);
  }
});

test("every successful /changes response carries the store's restoreGeneration, and a write built from it succeeds", async () => {
  const bob = login("bob");
  const feed = cursor => FEED(new Request(`${base}changes${cursor ? "?cursor=" + cursor : ""}`,
    { headers: { cookie: bob.cookie, "x-forwarded-for": ip() } }));
  const stored = db.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value;
  assert.equal(stored, GEN);
  // bootstrap -> feed phase
  const first = await feed(null);
  assert.equal(first.status, 200);
  const bootstrap = await first.json();
  assert.equal(bootstrap.phase, "bootstrap");
  assert.equal(bootstrap.restoreGeneration, stored);
  assert.equal(bootstrap.more, false);
  const polled = await (await feed(bootstrap.cursor)).json();
  assert.equal(polled.phase, "feed");
  assert.equal(polled.restoreGeneration, stored);
  // area_bootstrap: a viewer is granted a new Area, the grant notice carries the Area cursor.
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team2-area','carol','viewer')").run();
  const carol = login("carol");
  const carolFeed = cursor => FEED(new Request(`${base}changes${cursor ? "?cursor=" + cursor : ""}`,
    { headers: { cookie: carol.cookie, "x-forwarded-for": ip() } }));
  let state = await (await carolFeed(null)).json();
  while (state.phase === "bootstrap" && state.more) state = await (await carolFeed(state.cursor)).json();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('other-area','carol','viewer')").run();
  const grant = (await (await carolFeed(state.cursor)).json()).items.find(item => item.type === "access_granted");
  assert.ok(grant, "grant notice");
  const area = await (await carolFeed(grant.areaCursor)).json();
  assert.equal(area.phase, "area_bootstrap");
  assert.equal(area.restoreGeneration, stored);
  // A write built from the feed value succeeds ...
  const taskId = newTask();
  const revision = await revisionOf(taskId, bob.cookie);
  const written = await KINDS.title(taskId, { cookie: bob.cookie,
    body: goodBody("title", revision, "team-area", { restoreGeneration: polled.restoreGeneration }) });
  assert.equal(written.status, 200);
  // ... and a client holding another generation gets resync_required on the write ...
  const wrong = await KINDS.delete(taskId, { cookie: bob.cookie,
    body: goodBody("delete", revision, "team-area", { restoreGeneration: randomUUID() }) });
  assert.equal(wrong.status, 409);
  assert.deepEqual(await wrong.json(), RESYNC_BODY);
  // ... and resync_required on a feed cursor sealed for another generation.
  const claims = feedCursor.openStagingFeedCursor(process.env.AI_EXECUTIVE_SESSION_SECRET, polled.cursor).claims;
  const foreignCursor = feedCursor.sealStagingFeedCursor(process.env.AI_EXECUTIVE_SESSION_SECRET,
    { ...claims, gen: randomUUID() });
  const resync = await feed(foreignCursor);
  assert.equal(resync.status, 409);
  assert.deepEqual(await resync.json(), { code: "resync_required" });
});
