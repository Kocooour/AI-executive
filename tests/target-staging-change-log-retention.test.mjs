import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2c.2b: distinct 401 codes, schema v9 (commit time, member index, compaction floor with
// its guarded delete), the operator compaction and the feed behavior behind the floor.
// Synthetic identities and temp stores only.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2c2b-"));
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
const SECRET = "synthetic-r2c2b-session-secret-2026-10-30";
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
  ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = SECRET;
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const { createSessionToken, sessionCookieName } = await import("./support/owner-session-test-cookie.mjs");
const durable = await import("../lib/target-staging-durable-session.ts");
const identityLib = await import("../lib/target-staging-http-identity.ts");
const feedCursor = await import("../lib/target-staging-feed-cursor.ts");
const { readChangeFeedPage } = await import("../lib/target-change-feed-read-model.ts");
const { compactTargetStagingChangeLog } = await import("../lib/target-staging-change-log-compaction.ts");
const { GET: LIST } = await import("../app/api/target-staging/tasks/route.ts");
const { GET: DETAIL } = await import("../app/api/target-staging/tasks/[taskId]/route.ts");
const { GET: AUDIT } = await import("../app/api/target-staging/tasks/[taskId]/audit/route.ts");
const { GET: PROJECTS } = await import("../app/api/target-staging/projects/route.ts");
const { GET: TITLE_GET, PATCH: TITLE_PATCH } = await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const { POST: TITLE_STATUS } = await import("../app/api/target-staging/tasks/[taskId]/title/status/route.ts");
const { POST: DELETE_TASK } = await import("../app/api/target-staging/tasks/[taskId]/delete/route.ts");
const { POST: DELETE_STATUS } = await import("../app/api/target-staging/tasks/[taskId]/delete/status/route.ts");
const { POST: MEMBERS } = await import("../app/api/target-staging/areas/[areaId]/members/route.ts");
const { GET: FEED } = await import("../app/api/target-staging/changes/route.ts");

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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** alice (owner, admin of family-area), bob (editor), carol (viewer), dave (no membership). */
function makeFixture() {
  const name = `fx${++counter}`;
  const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, name), ownerUserId: "alice" });
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for (const user of ["bob", "carol", "dave"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)").run(`${user}-personal`, user);
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
      VALUES (?, ?, 'private', ?, ?, 'unassigned')`).run(`${user}-private`, `${user} private`, `${user}-personal`, user);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('other','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('other-area','Other','shared','other','alice')").run();
  const member = db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)");
  member.run("family-area", "alice", "admin");
  member.run("family-area", "bob", "editor");
  member.run("family-area", "carol", "viewer");
  member.run("other-area", "alice", "admin");
  const task = db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
  for (const id of ["f-1", "f-2", "f-3", "f-4", "mv-1", "d-1"]) task.run(id, "family-area", `Family ${id}`);
  task.run("p-alice-1", stage.unassignedAreaId, "Alice private");
  const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
  const fixture = { name, stage, store, db, databasePath: stage.databasePath, client: `10.5.0.${counter}` };
  activate(fixture);
  return fixture;
}
function activate(fx) {
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = fx.stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fx.stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
}
const deleteTaskSql = id => `BEGIN;
  INSERT INTO task_tombstones(id,area_id,revision,change_seq,deleted_at_ms)
    SELECT t.id, COALESCE(t.area_id,(SELECT area_id FROM projects WHERE id=t.project_id)), t.revision+1,
      (SELECT COALESCE(MAX(seq),0)+1 FROM change_log), ${Date.now()} FROM tasks t WHERE t.id='${id}';
  DELETE FROM tasks WHERE id='${id}'; COMMIT;`;
const maxSeq = db => db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM change_log").get().n;
const floorOf = db => Number(db.prepare("SELECT value FROM metadata WHERE key='change_log_floor'").get().value);
const preflight = fx => inspectIsolatedTargetStore({
  stagingDirectory: fx.stage.directory, expectedRestoreGeneration: fx.stage.restoreGeneration, mode: "r2-model" });

/** Title churn, a move, and membership churn (carol and bob remove/re-add/role change). */
function churn(db, round) {
  for (let i = 0; i < 4; i++) {
    db.prepare("UPDATE tasks SET title=? WHERE id='f-1'").run(`f1 r${round}.${i}`);
    db.prepare("UPDATE tasks SET title=? WHERE id='f-2'").run(`f2 r${round}.${i}`);
  }
  db.exec("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'");
  db.exec("UPDATE tasks SET title='during bob removal' WHERE id='f-3'");
  db.exec("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'");
  db.exec("UPDATE tasks SET title='gap' WHERE id='f-4'");
  db.exec("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','bob','viewer')");
  db.exec("UPDATE area_members SET role='editor' WHERE area_id='family-area' AND user_id='bob'");
  db.exec("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','carol','viewer')");
}

// ---- 401 codes ------------------------------------------------------------------------------

const sessionCookie = token => `${durable.TARGET_STAGING_SESSION_COOKIE}=${token}`;
const ownerCookie = () => `${sessionCookieName}=${createSessionToken()}`;
let ip = 0;
const taskCtx = { params: Promise.resolve({ taskId: "f-1" }) };
const areaCtx = { params: Promise.resolve({ areaId: "family-area" }) };
const body = JSON.stringify({ commandId: "11111111-1111-4111-8111-111111111111", expectedRevision: "a".repeat(64), title: "x" });
const post = (url, cookie, extra = "") => new Request(base + url, {
  method: "POST", body: extra || body,
  headers: { "content-type": "application/json", origin: "http://localhost:3001",
    ...(cookie ? { cookie } : {}), "x-forwarded-for": `10.6.${Math.floor(++ip / 250)}.${ip % 250}` } });
const get = (url, cookie) => new Request(base + url, {
  headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": `10.6.${Math.floor(++ip / 250)}.${ip % 250}` } });
const routes = {
  "tasks list": cookie => LIST(get("tasks?scope=shared", cookie)),
  "task detail": cookie => DETAIL(get("tasks/f-1", cookie), taskCtx),
  "task audit": cookie => AUDIT(get("tasks/f-1/audit", cookie), taskCtx),
  "projects": cookie => PROJECTS(get("projects", cookie)),
  "title preflight": cookie => TITLE_GET(get("tasks/f-1/title", cookie), taskCtx),
  "title PATCH": cookie => TITLE_PATCH(new Request(base + "tasks/f-1/title", {
    method: "PATCH", body, headers: { "content-type": "application/json", origin: "http://localhost:3001",
      ...(cookie ? { cookie } : {}), "x-forwarded-for": `10.6.${Math.floor(++ip / 250)}.${ip % 250}` } }), taskCtx),
  "title status": cookie => TITLE_STATUS(post("tasks/f-1/title/status", cookie), taskCtx),
  "delete": cookie => DELETE_TASK(post("tasks/f-1/delete", cookie), taskCtx),
  "delete status": cookie => DELETE_STATUS(post("tasks/f-1/delete/status", cookie), taskCtx),
  "membership": cookie => MEMBERS(post("areas/family-area/members", cookie), areaCtx),
  "changes": cookie => FEED(get("changes", cookie)),
};
const expectBody = async (response, expected, label) => {
  assert.equal(response.status, 401, label);
  assert.equal(response.headers.get("cache-control"), "no-store", label);
  assert.deepEqual(await response.json(), expected, label);
};
const AUTH = { error: "Authentication required" };

test("401 codes: expired / revoked / epoch / unknown / malformed / precedence on every endpoint family", async () => {
  const fx = makeFixture();
  const issue = (user, seconds) => {
    const r = durable.issueDurableTargetStagingSession(fx.store, user, seconds);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  const expired = issue("alice", 1);
  const revoked = issue("alice", 900);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, revoked.sessionId).ok, true);
  const epoch = issue("carol", 900);
  const epochStale = issue("carol", 1);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "carol").ok, true);
  const both = issue("bob", 1);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, both.sessionId).ok, true);
  const live = issue("alice", 900);
  await sleep(1300); // `expired` and `both` are now past their expiry
  const unknown = randomBytes(32).toString("base64url");
  const cases = [
    ["expired", sessionCookie(expired.sessionToken), { ...AUTH, code: "session_expired" }],
    ["revoked", sessionCookie(revoked.sessionToken), { ...AUTH, code: "session_revoked" }],
    ["revokeAllForUser (epoch)", sessionCookie(epoch.sessionToken), { ...AUTH, code: "session_revoked" }],
    ["stale epoch AND expired", sessionCookie(epochStale.sessionToken), { ...AUTH, code: "session_revoked" }],
    ["revoked AND expired", sessionCookie(both.sessionToken), { ...AUTH, code: "session_revoked" }],
    ["unknown token", sessionCookie(unknown), { ...AUTH, code: "session_revoked" }],
    ["malformed cookie", `${durable.TARGET_STAGING_SESSION_COOKIE}=not-a-token`, { ...AUTH, code: "session_revoked" }],
    ["no cookie", "", AUTH],
    ["invalid owner cookie", `${sessionCookieName}=garbage`, AUTH],
  ];
  for (const [routeName, call] of Object.entries(routes)) {
    for (const [label, cookie, expected] of cases) {
      await expectBody(await call(cookie || undefined), expected, `${routeName}: ${label}`);
    }
  }
  // Owner-cookie path unchanged, and a live session is not refused.
  assert.equal((await routes["tasks list"](ownerCookie())).status, 200);
  assert.equal((await routes["tasks list"](sessionCookie(live.sessionToken))).status, 200);
});

test("401 codes take precedence over invalid path / query input on every route", async () => {
  const fx = makeFixture();
  const issue = (user, seconds) => {
    const r = durable.issueDurableTargetStagingSession(fx.store, user, seconds);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  const expired = issue("alice", 1);
  const revoked = issue("alice", 900);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, revoked.sessionId).ok, true);
  const live = issue("alice", 900);
  await sleep(1300);
  const badTask = { params: Promise.resolve({ taskId: "" }) };
  const badArea = { params: Promise.resolve({ areaId: "" }) };
  const writeHeaders = cookie => ({ "content-type": "application/json", origin: "http://localhost:3001",
    cookie, "x-forwarded-for": `10.7.${Math.floor(++ip / 250)}.${ip % 250}` });
  const invalid = {
    "tasks list (unknown query)": cookie => LIST(get("tasks?scope=shared&bogus=1", cookie)),
    "task detail (query)": cookie => DETAIL(get("tasks/f-1?x=1", cookie), taskCtx),
    "task audit (query)": cookie => AUDIT(get("tasks/f-1/audit?x=1", cookie), taskCtx),
    "projects (unknown query)": cookie => PROJECTS(get("projects?bogus=1", cookie)),
    "title preflight (empty id)": cookie => TITLE_GET(get("tasks/x/title", cookie), badTask),
    "title preflight (query)": cookie => TITLE_GET(get("tasks/f-1/title?bogus=1", cookie), taskCtx),
    "title PATCH (query)": cookie => TITLE_PATCH(new Request(base + "tasks/f-1/title?x=1", {
      method: "PATCH", body, headers: writeHeaders(cookie) }), taskCtx),
    "title PATCH (empty id)": cookie => TITLE_PATCH(new Request(base + "tasks/x/title", {
      method: "PATCH", body, headers: writeHeaders(cookie) }), badTask),
    "title status (query)": cookie => TITLE_STATUS(post("tasks/f-1/title/status?x=1", cookie), taskCtx),
    "title status (empty id)": cookie => TITLE_STATUS(post("tasks/x/title/status", cookie), badTask),
    "delete (query)": cookie => DELETE_TASK(post("tasks/f-1/delete?x=1", cookie), taskCtx),
    "delete (empty id)": cookie => DELETE_TASK(post("tasks/x/delete", cookie), badTask),
    "delete status (query)": cookie => DELETE_STATUS(post("tasks/f-1/delete/status?x=1", cookie), taskCtx),
    "delete status (empty id)": cookie => DELETE_STATUS(post("tasks/x/delete/status", cookie), badTask),
    "membership (query)": cookie => MEMBERS(post("areas/family-area/members?unexpected=1", cookie), areaCtx),
    "membership (empty id)": cookie => MEMBERS(post("areas/x/members", cookie), badArea),
    "changes (unknown query)": cookie => FEED(get("changes?since=1", cookie)),
  };
  for (const [label, call] of Object.entries(invalid)) {
    await expectBody(await call(sessionCookie(expired.sessionToken)), { ...AUTH, code: "session_expired" }, `${label}: expired`);
    await expectBody(await call(sessionCookie(revoked.sessionToken)), { ...AUTH, code: "session_revoked" }, `${label}: revoked`);
    const response = await call(sessionCookie(live.sessionToken));
    assert.equal(response.status, 400, `${label}: live session still gets 400`);
  }
});

test("in-transaction refusal mapper: a session dying inside the write TX keeps its 401 code", async () => {
  // A write child reports `session_revoked` only when the session dies between its two
  // in-transaction checks; routes then call stagingUnauthorizedRefusal. That window is not
  // reachable over HTTP without a child test hook (the library-level clock-skew tests cover
  // the writer), so the mapper is asserted directly against the live store.
  const fx = makeFixture();
  const issue = (user, seconds) => {
    const r = durable.issueDurableTargetStagingSession(fx.store, user, seconds);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  const expired = issue("alice", 1);
  const revoked = issue("alice", 900);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, revoked.sessionId).ok, true);
  await sleep(1300);
  const refusal = async cookie => {
    const request = get("tasks/f-1", cookie);
    const identity = identityLib.resolveStagingHttpIdentity(request);
    assert.ok(identity, "identity resolves from the cookie");
    return identityLib.stagingUnauthorizedRefusal(request, identity, fx.store);
  };
  await expectBody(await refusal(sessionCookie(expired.sessionToken)), { ...AUTH, code: "session_expired" }, "expired");
  await expectBody(await refusal(sessionCookie(revoked.sessionToken)), { ...AUTH, code: "session_revoked" }, "revoked");
  await expectBody(await refusal(sessionCookie(randomBytes(32).toString("base64url"))),
    { ...AUTH, code: "session_revoked" }, "unknown");
  await expectBody(await refusal(ownerCookie()), AUTH, "owner cookie keeps the code-less body");
});

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
      await sleep(20);
    }
    await between();
    writeFileSync(path.join(gate, "go"), "");
    return await pending;
  } finally {
    process.execPath = REAL_NODE;
  }
}

test("401 codes at the release point after the read child: revoked and expired in between", async () => {
  const fx = makeFixture();
  const a = durable.issueDurableTargetStagingSession(fx.store, "alice", 900);
  const revoked = await withGatedChild(() => routes["tasks list"](sessionCookie(a.sessionToken)),
    async () => assert.equal(durable.revokeDurableTargetStagingSession(fx.store, a.sessionId).ok, true));
  await expectBody(revoked, { ...AUTH, code: "session_revoked" }, "revoked after the read");
  const short = durable.issueDurableTargetStagingSession(fx.store, "alice", 1);
  const expired = await withGatedChild(() => routes["changes"](sessionCookie(short.sessionToken)),
    async () => { await sleep(1300); });
  await expectBody(expired, { ...AUTH, code: "session_expired" }, "expired after the read");
  // The library primitive carries the same distinction.
  const request = new Request(base + "tasks", { headers: { cookie: sessionCookie(short.sessionToken) } });
  const identity = identityLib.resolveStagingHttpIdentity(request);
  assert.equal(identityLib.verifyStagingIdentityBeforeRelease(request, identity, fx.store), "session_expired");
});

// ---- schema v9, floor and guarded delete ------------------------------------------------------

test("schema v9: committed_at_ms is stamped automatically; a v8-style store is rejected by preflight", () => {
  const fx = makeFixture();
  const rows = fx.db.prepare("SELECT committed_at_ms AS t FROM change_log").all();
  assert.ok(rows.length > 0 && rows.every(r => Number.isSafeInteger(r.t) && Math.abs(r.t - Date.now()) < 60_000));
  assert.throws(() => fx.db.exec(`INSERT INTO change_log(entity_kind,entity_id,area_id,op,revision,committed_at_ms)
    VALUES ('task','zz','family-area','upsert',1,0)`), /CHECK/);
  assert.equal(floorOf(fx.db), 0);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  const v8 = makeFixture();
  v8.db.exec("UPDATE metadata SET value='8' WHERE key='schema_version'");
  const result = preflight(v8);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("metadata_invalid"), JSON.stringify(result));
  const noIndex = makeFixture();
  noIndex.db.exec("DROP INDEX change_log_by_member");
  assert.ok(preflight(noIndex).issues.includes("schema_invalid"));
});

test("floor triggers: only increases, never above MAX(seq), cannot be deleted, renamed or replaced", () => {
  const { db } = makeFixture();
  churn(db, 1);
  const top = maxSeq(db);
  const setFloor = value => db.prepare("UPDATE metadata SET value=? WHERE key='change_log_floor'").run(value);
  setFloor("5");
  assert.equal(floorOf(db), 5);
  assert.throws(() => setFloor("4"), /may only increase/);
  assert.throws(() => setFloor(String(top + 1)), /may only increase/);
  for (const bad of ["", "x", "-1", "05", "6.0", "1e1", " 7", "5\u0000x", "5\u0000"]) assert.throws(() => setFloor(bad), /may only increase/, bad);
  assert.throws(() => db.exec("UPDATE metadata SET key='other' WHERE key='change_log_floor'"), /may only increase/);
  assert.throws(() => db.exec("DELETE FROM metadata WHERE key='change_log_floor'"), /cannot be deleted/);
  // No other row can be renamed onto the key, with or without OR REPLACE; the floor stays.
  const keep = floorOf(db);
  for (const verb of ["UPDATE", "UPDATE OR REPLACE", "UPDATE OR IGNORE", "UPDATE OR ABORT"]) {
    assert.throws(() => db.exec(`${verb} metadata SET key='change_log_floor', value='0' WHERE key='activated'`),
      /cannot be replaced/, verb);
  }
  assert.throws(() => db.exec("REPLACE INTO metadata(key,value) VALUES ('change_log_floor','0')"), /cannot be replaced/);
  assert.equal(floorOf(db), keep);
  assert.equal(db.prepare("SELECT value FROM metadata WHERE key='activated'").get().value, "false");
  assert.throws(() => db.exec("INSERT OR REPLACE INTO metadata(key,value) VALUES ('change_log_floor','0')"), /cannot be replaced/);
  assert.throws(() => db.exec("INSERT INTO metadata(key,value) VALUES ('change_log_floor','9')"));
  assert.throws(() => db.exec("UPDATE metadata SET key='change_log_floor' WHERE key='activated'"));
  setFloor("5"); // equal is fine
  setFloor(String(top));
  assert.equal(floorOf(db), top);
});

test("guarded delete: only superseded rows at or below the floor; last row of a key, rows above and tombstones stay", () => {
  const fx = makeFixture();
  const { db } = fx;
  churn(db, 1);
  db.exec(deleteTaskSql("d-1"));
  churn(db, 2);
  const tombstone = db.prepare("SELECT seq FROM change_log WHERE op='tombstone'").get().seq;
  const del = seq => db.prepare("DELETE FROM change_log WHERE seq=?").run(seq);
  assert.throws(() => del(1), /compacted below the floor/, "floor 0 forbids every delete");
  const floor = maxSeq(db) - 3;
  db.prepare("UPDATE metadata SET value=? WHERE key='change_log_floor'").run(String(floor));
  const keyOf = r => `${r.entity_kind}|${r.entity_id}|${r.member_user_id}`;
  const rows = db.prepare("SELECT * FROM change_log ORDER BY seq").all();
  const lastBelow = new Map();
  for (const r of rows) if (r.seq <= floor) lastBelow.set(keyOf(r), r.seq);
  const superseded = rows.find(r => r.seq <= floor && lastBelow.get(keyOf(r)) !== r.seq);
  assert.ok(superseded, "the churn produced a superseded row " + floor + " " + JSON.stringify(rows.map(r => r.seq + r.op)));
  for (const seq of lastBelow.values()) assert.throws(() => del(seq), /compacted below the floor/, `last row ${seq}`);
  for (const r of rows.filter(r => r.seq > floor)) assert.throws(() => del(r.seq), /compacted below the floor/, `above ${r.seq}`);
  assert.ok(tombstone <= floor);
  assert.throws(() => del(tombstone), /compacted below the floor/, "tombstone is the last row of its key");
  assert.equal(del(superseded.seq).changes, 1);
  // Replace / update stay forbidden.
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO change_log(seq,entity_kind,entity_id,area_id,op,revision)
    VALUES (?, 'task','x','family-area','upsert',1)`).run(rows[0].seq), /replacement is forbidden/);
  assert.throws(() => db.prepare("UPDATE change_log SET revision=revision WHERE seq=?").run(rows[3].seq), /append-only/);
  // The tombstone reference stays valid. A floor with superseded rows still below it
  // (a partial or missing compaction) is an inconsistent state which preflight flags.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_tombstones t JOIN change_log c ON c.seq=t.change_seq").get().n, 1);
  assert.ok(preflight(fx).issues.includes("change_log_floor_invalid"), JSON.stringify(preflight(fx)));
  // Deleting every remaining superseded row restores consistency.
  const remaining = db.prepare("SELECT * FROM change_log WHERE seq<=? ORDER BY seq").all(floor);
  const lastOf = new Map();
  for (const r of remaining) lastOf.set(keyOf(r), r.seq);
  for (const r of remaining) if (lastOf.get(keyOf(r)) !== r.seq) del(r.seq);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
});

test("own-membership lookup is an index seek on change_log_by_member", () => {
  const { db } = makeFixture();
  const plan = sql => db.prepare("EXPLAIN QUERY PLAN " + sql).all().map(r => r.detail).join("\n");
  const query = hint => `SELECT area_id AS areaId, seq, op, member_role AS role FROM change_log ${hint}
    WHERE entity_kind = 'membership' AND member_user_id = ? ORDER BY entity_id COLLATE BINARY ASC, seq ASC`;
  const interval = plan(`SELECT seq FROM change_log INDEXED BY change_log_content_by_area
    WHERE area_id = 'family-area' AND seq > 1 AND seq < 99 AND entity_kind <> 'membership' ORDER BY seq LIMIT 5`);
  assert.match(interval, /USING (COVERING )?INDEX change_log_content_by_area \(area_id=\? AND seq>\? AND seq<\?\)/, interval);
  // The read model pins the index with INDEXED BY (the planner alone prefers the entity index).
  for (const hint of ["INDEXED BY change_log_by_member"]) {
    const detail = plan(query(hint).replace("= ?", "= 'bob'"));
    assert.match(detail, /SEARCH .*USING (COVERING )?INDEX change_log_by_member \(entity_kind=\? AND member_user_id=\?\)/, detail);
    assert.doesNotMatch(detail, /SCAN change_log/, detail);
  }
});

// ---- compaction ---------------------------------------------------------------------------------

test("compaction: floor from retention, superseded rows only, preflight green, monotonic, minimum 7 days", async () => {
  const fx = makeFixture();
  churn(fx.db, 1);
  fx.db.exec(deleteTaskSql("d-1"));
  fx.db.exec("UPDATE tasks SET area_id='other-area' WHERE id='mv-1'");
  const markA = maxSeq(fx.db);
  await sleep(2600);
  churn(fx.db, 2);
  const before = fx.db.prepare("SELECT * FROM change_log ORDER BY seq").all();
  const cutoff = (fx.db.prepare("SELECT MAX(committed_at_ms) AS t FROM change_log WHERE seq<=?").get(markA).t) + 1000;
  const DAY = 86_400_000;

  for (const days of [0, 6, -1, 1.5, NaN, 7.0001]) {
    assert.deepEqual(compactTargetStagingChangeLog(fx.store, { retentionDays: days, now: cutoff + 30 * DAY }),
      { ok: false, reason: "invalid_request" }, String(days));
  }
  assert.equal(maxSeq(fx.db), before.length ? before.at(-1).seq : 0, "rejected requests change nothing");
  assert.equal(floorOf(fx.db), 0);

  const first = compactTargetStagingChangeLog(fx.store, { retentionDays: 30, now: cutoff + 30 * DAY });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.floor, markA);
  assert.ok(first.deleted > 0);
  assert.equal(floorOf(fx.db), markA);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));

  const after = fx.db.prepare("SELECT * FROM change_log ORDER BY seq").all();
  assert.equal(after.length, before.length - first.deleted);
  const keyOf = r => `${r.entity_kind}|${r.entity_id}|${r.member_user_id}`;
  const expectedKept = new Map();
  for (const r of before) if (r.seq <= markA) expectedKept.set(keyOf(r), r.seq);
  assert.deepEqual(after.filter(r => r.seq <= markA).map(r => r.seq),
    [...expectedKept.values()].sort((x, y) => x - y), "each key keeps exactly its last row <= floor");
  assert.deepEqual(after.filter(r => r.seq > markA), before.filter(r => r.seq > markA), "rows above the floor untouched");
  assert.equal(after.filter(r => r.op === "tombstone").length, 1, "tombstone kept");

  // Repeating, or running with a younger cutoff, never lowers the floor and deletes nothing.
  assert.deepEqual(compactTargetStagingChangeLog(fx.store, { retentionDays: 30, now: cutoff + 30 * DAY }),
    { ok: true, floor: markA, deleted: 0 });
  assert.deepEqual(compactTargetStagingChangeLog(fx.store, { retentionDays: 30, now: 1_000_000_000_000 }),
    { ok: true, floor: markA, deleted: 0 });
  // A later run raises the floor to the newest sequence and compacts the second round too.
  const last = compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() + 8 * DAY });
  assert.equal(last.ok, true, JSON.stringify(last));
  assert.equal(last.floor, maxSeq(fx.db));
  assert.ok(last.deleted > 0);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  // Wrong generation: refused, nothing written.
  assert.equal(compactTargetStagingChangeLog({ ...fx.store, expectedRestoreGeneration: "00000000-0000-4000-8000-000000000000" },
    { retentionDays: 30, now: Date.now() + 40 * DAY }).ok, false);
});

// ---- feed behind the floor --------------------------------------------------------------------

const login = (fx, user) => {
  const issued = durable.issueDurableTargetStagingSession(fx.store, user, 900);
  assert.equal(issued.ok, true, `session issue failed for ${user}: ${JSON.stringify(issued)}`);
  return sessionCookie(issued.sessionToken);
};
const feed = (fx, cookie, cursor) => FEED(new Request(`${base}changes${cursor ? "?cursor=" + cursor : ""}`,
  { headers: { cookie, "x-forwarded-for": fx.client } }));
async function page(fx, cookie, cursor) {
  const response = await feed(fx, cookie, cursor);
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 200));
  return JSON.parse(text);
}
async function drain(fx, cookie, cursor = null) {
  const items = [];
  for (let i = 0; i < 50; i++) {
    const body = await page(fx, cookie, cursor);
    items.push(...body.items);
    cursor = body.cursor;
    if (body.phase === "area_bootstrap" ? body.done : !body.more) return { items, cursor };
  }
  throw new Error("feed did not end");
}
const seal = (user, p, epoch = 0, gen) => feedCursor.sealStagingFeedCursor(SECRET,
  { uid: user, epoch, gen, pos: { ph: "f", p } });
function applyAll(state, items) {
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (item.type === "upsert") {
      if (!state.tombstones.has(key)) state.items.set(key, `${item.areaId}|${item.title}|${item.revision}`);
    } else if (item.type === "tombstone") { state.tombstones.add(key); state.items.delete(key); }
    else if (item.type === "left_scope") state.items.delete(key);
    else if (item.type === "access_lost") {
      for (const [k, v] of state.items) if (v.startsWith(item.areaId + "|")) state.items.delete(k);
    }
  }
  return state;
}
/** Area cursors are freshly encrypted each time: compare what they decrypt to. */
const normalize = item => item.areaCursor
  ? { ...item, areaCursor: feedCursor.openStagingFeedCursor(SECRET, item.areaCursor).claims.pos } : item;
const newState = () => ({ items: new Map(), tombstones: new Set() });
const view = state => [...state.items].map(([k, v]) => `${k}|${v}`).sort();
/** Same store directory contents under another path, for before/after comparisons. */
function cloneStore(fx) {
  fx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const dir = path.join(root, `${fx.name}-copy`);
  mkdirSync(dir, { mode: 0o700 });
  copyFileSync(fx.databasePath, path.join(dir, "lumi-target.sqlite"));
  // R2c.4a: a usable copy of a store carries its journal (mode 0600) taken at the same moment.
  copyFileSync(path.join(fx.stage.directory, "lumi-target.journal"), path.join(dir, "lumi-target.journal"));
  chmodSync(path.join(dir, "lumi-target.journal"), 0o600);
  copyFileSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"), path.join(dir, "lumi-target-witness.sqlite"));
  chmodSync(path.join(dir, "lumi-target-witness.sqlite"), 0o600);
  return { ...fx, stage: { ...fx.stage, directory: dir }, store: { ...fx.store, stagingDirectory: dir },
    databasePath: path.join(dir, "lumi-target.sqlite"), client: fx.client + "9" };
}

test("feed after compaction: P < floor -> 409 resync_required; P >= floor equals the uncompacted store; re-bootstrap converges", async () => {
  const fx = makeFixture();
  const bob = login(fx, "bob");
  const dave = login(fx, "dave");
  const gen = fx.stage.restoreGeneration;
  const bootstrapped = await drain(fx, bob);
  const staleCursor = bootstrapped.cursor; // P = W0, before any churn
  const daveStart = await drain(fx, dave);
  churn(fx.db, 1);
  fx.db.exec(deleteTaskSql("d-1"));
  const markA = maxSeq(fx.db);
  await sleep(2600);
  churn(fx.db, 2);
  fx.db.exec("UPDATE tasks SET title='after' WHERE id='f-3'");
  fx.db.exec("PRAGMA journal_mode");
  const uncompacted = cloneStore(fx);
  const cutoff = fx.db.prepare("SELECT MAX(committed_at_ms) AS t FROM change_log WHERE seq<=?").get(markA).t + 1000;
  const result = compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: cutoff + 7 * 86_400_000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.floor, markA);
  assert.ok(result.deleted > 0);
  assert.ok(markA > 1);

  // Cursors behind the floor: 409 resync_required, no data. At or beyond: served.
  activate(fx);
  for (const cursor of [staleCursor, seal("bob", markA - 1, 0, gen)]) {
    const response = await feed(fx, bob, cursor);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: "resync_required" });
  }
  for (const position of [markA, markA + 1, maxSeq(fx.db)]) {
    for (const user of ["bob", "alice", "carol"]) {
      const cookie = user === "alice" ? ownerCookie() : login(fx, user);
      const cursor = seal(user, position, 0, gen);
      activate(fx);
      const compacted = await drain(fx, cookie, cursor);
      activate(uncompacted);
      const reference = await drain(uncompacted, user === "alice" ? ownerCookie() : login(uncompacted, user), cursor);
      assert.deepEqual(compacted.items.map(normalize), reference.items.map(normalize), `${user} from ${position}`);
      assert.deepEqual(feedCursor.openStagingFeedCursor(SECRET, compacted.cursor).claims.pos,
        feedCursor.openStagingFeedCursor(SECRET, reference.cursor).claims.pos);
    }
  }
  // Bob's remove/re-add history lies below the floor; he is a member above it and sees B-round titles.
  activate(fx);
  const bobAbove = await drain(fx, login(fx, "bob"), seal("bob", markA, 0, gen));
  assert.ok(bobAbove.items.some(i => i.type === "upsert" && i.title === "after"));
  assert.equal(bobAbove.items.some(i => i.type === "upsert" && i.title === "gap"), false, "no gap-period content");

  // Fresh bootstrap keeps working, hands off P >= floor, and converges with the atomic read.
  const fresh = await drain(fx, login(fx, "bob"));
  assert.ok(feedCursor.openStagingFeedCursor(SECRET, fresh.cursor).claims.pos.p >= markA);
  fx.db.exec("UPDATE tasks SET title='post-bootstrap' WHERE id='f-1'");
  fx.db.exec("DELETE FROM area_members WHERE area_id='family-area' AND user_id='carol'");
  const replay = await drain(fx, login(fx, "bob"), fresh.cursor);
  const state = applyAll(applyAll(newState(), fresh.items), replay.items);
  const atomic = applyAll(newState(), (await drain(fx, login(fx, "bob"))).items);
  assert.deepEqual(view(state), view(atomic));

  // An Area bootstrap after compaction ends in the same state as the main feed.
  const daveCookie = login(fx, "dave");
  const daveBoot = await drain(fx, daveCookie);
  fx.db.exec("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','dave','viewer')");
  fx.db.exec("UPDATE tasks SET title='after dave joined' WHERE id='f-2'");
  const granted = await page(fx, daveCookie, daveBoot.cursor);
  const grant = granted.items.find(i => i.type === "access_granted");
  assert.ok(grant && grant.areaCursor);
  const area = await drain(fx, daveCookie, grant.areaCursor);
  const daveState = applyAll(applyAll(applyAll(newState(), daveBoot.items), area.items), granted.items);
  const rest = await drain(fx, daveCookie, granted.cursor);
  applyAll(daveState, rest.items);
  assert.deepEqual(view(daveState), view(applyAll(newState(), (await drain(fx, daveCookie)).items)));
  assert.deepEqual(daveStart.items.map(i => i.id), []);
});

test("operator CLI: strict arguments, minimum retention, JSON result", () => {
  const fx = makeFixture();
  churn(fx.db, 1);
  const run = (...args) => {
    const r = spawnSync(REAL_NODE, ["--experimental-loader", "./tests/ts-loader.mjs",
      "scripts/target-staging-compact-change-log.mjs", ...args], { encoding: "utf8" });
    return { status: r.status, body: JSON.parse(r.stdout) };
  };
  const common = ["--directory", fx.stage.directory, "--generation", fx.stage.restoreGeneration];
  assert.deepEqual(run(...common, "--retention-days", "3"), { status: 1, body: { ok: false, reason: "invalid_request" } });
  assert.deepEqual(run("--directory", "relative", "--generation", fx.stage.restoreGeneration).status, 1);
  assert.equal(run(...common, "--bogus", "1").status, 1);
  // Everything was just written, so the default 30 days compacts nothing.
  assert.deepEqual(run(...common), { status: 0, body: { ok: true, floor: 0, deleted: 0 } });
  assert.equal(floorOf(fx.db), 0);
}, { timeout: 60_000 });

const DAY_MS = 86_400_000;
test("stale bootstrap and Area-bootstrap cursors across a compaction -> 409 resync_required, never partial data", async () => {
  const fx = makeFixture();
  const seedBulk = count => {
    const insert = fx.db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
    for (let i = 1; i <= count; i++) insert.run(`bt-${String(i).padStart(3, "0")}`, "family-area", `Bulk ${i}`);
  };
  seedBulk(130);
  const bob = login(fx, "bob");
  const first = await page(fx, bob, null);
  assert.equal(first.more, true);
  assert.equal(feedCursor.openStagingFeedCursor(SECRET, first.cursor).claims.pos.ph, "b");
  fx.db.exec("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'");
  fx.db.exec("UPDATE tasks SET title='later' WHERE id='f-1'");
  // Dave is granted access: his Area cursor carries the grant sequence.
  const dave = login(fx, "dave");
  const daveStart = await drain(fx, dave);
  fx.db.exec("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','dave','viewer')");
  const granted = await page(fx, dave, daveStart.cursor);
  const areaCursor = granted.items.find(i => i.type === "access_granted").areaCursor;
  fx.db.exec("UPDATE tasks SET title='later 2' WHERE id='f-2'");
  const done = compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() + 8 * DAY_MS });
  assert.equal(done.ok, true);
  assert.equal(done.floor, maxSeq(fx.db));
  for (const [cookie, cursor, label] of [[bob, first.cursor, "bootstrap"], [dave, areaCursor, "area bootstrap"]]) {
    const response = await feed(fx, cookie, cursor);
    assert.equal(response.status, 409, label);
    assert.deepEqual(await response.json(), { code: "resync_required" }, label);
  }
  // A fresh bootstrap converges with the atomic read (bob is no longer a member).
  const fresh = await drain(fx, bob);
  assert.deepEqual(fresh.items.map(i => i.id), []);
  assert.ok(feedCursor.openStagingFeedCursor(SECRET, fresh.cursor).claims.pos.p >= done.floor);
});

test("compaction reports a hot journal distinctly", () => {
  const fx = makeFixture();
  writeFileSync(fx.databasePath + "-journal", "");
  assert.deepEqual(compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() + 8 * DAY_MS }),
    { ok: false, reason: "journal_present" });
  rmSync(fx.databasePath + "-journal");
  assert.equal(compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() + 8 * DAY_MS }).ok, true);
});

test("bounded compaction retry never bypasses a mismatched restore generation", () => {
  const fx = makeFixture();
  const originalFloor = floorOf(fx.db);
  const originalAnchor = fx.db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value;
  const wrongGeneration = { ...fx.store, expectedRestoreGeneration: randomUUID() };
  // Both full pinned attempts must deny the same untrusted source, without
  // writing a compaction intent or advancing the retention floor.
  assert.deepEqual(compactTargetStagingChangeLog(wrongGeneration,
    { retentionDays: 7, now: Date.now() + 8 * DAY_MS }),
  { ok: false, reason: "unavailable" });
  assert.equal(floorOf(fx.db), originalFloor);
  assert.equal(fx.db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value,
    originalAnchor);
  assert.equal(preflight(fx).ok, true);
  // A subsequent correctly configured attempt still succeeds.
  assert.equal(compactTargetStagingChangeLog(fx.store,
    { retentionDays: 7, now: Date.now() + 8 * DAY_MS }).ok, true);
});

test("differential (seeded): compacted store == uncompacted store for every P >= floor, resync_required below", () => {
  for (const seed of [1, 7, 42]) {
    let state = seed * 2654435761 % 4294967296;
    const rnd = n => { state = (state * 1664525 + 1013904223) % 4294967296; return Math.floor(state / 4294967296 * n); };
    const plain = makeFixture();
    const compacted = makeFixture();
    const both = sql => { plain.db.exec(sql); compacted.db.exec(sql); };
    let nextTask = 0;
    const present = new Set(["f-1", "f-2", "f-3"]);
    const members = new Map([["bob", "editor"], ["carol", "viewer"]]);
    const step = () => {
      const op = rnd(6);
      if (op <= 1) both(`UPDATE tasks SET title='t${rnd(1000)}' WHERE id='${["f-1", "f-2", "f-3"][rnd(3)]}'`);
      else if (op === 2) { const id = `n-${++nextTask}`; both(`INSERT INTO tasks(id,area_id,title) VALUES ('${id}','family-area','new')`); present.add(id); }
      else if (op === 3) {
        const user = ["bob", "carol", "dave"][rnd(3)];
        if (members.has(user)) { both(`DELETE FROM area_members WHERE area_id='family-area' AND user_id='${user}'`); members.delete(user); }
        else { const role = ["viewer", "editor"][rnd(2)]; both(`INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area','${user}','${role}')`); members.set(user, role); }
      } else if (op === 4) {
        const user = ["bob", "carol", "dave"][rnd(3)];
        if (members.has(user)) { const role = members.get(user) === "viewer" ? "editor" : "viewer";
          both(`UPDATE area_members SET role='${role}' WHERE area_id='family-area' AND user_id='${user}'`); members.set(user, role); }
      } else if (nextTask > 0 && present.has(`n-${nextTask}`)) { both(deleteTaskSql(`n-${nextTask}`)); present.delete(`n-${nextTask}`); }
    };
    for (let phase = 0; phase < 3; phase++) {
      for (let i = 0; i < 12 + rnd(10); i++) step();
      if (phase < 2 || rnd(2)) {
        // Different floors per phase: compact only what exists so far.
        const result = compactTargetStagingChangeLog(compacted.store, { retentionDays: 7, now: Date.now() + 8 * DAY_MS });
        assert.equal(result.ok, true, JSON.stringify(result));
      }
    }
    const floor = floorOf(compacted.db);
    assert.ok(floor > 0);
    assert.equal(preflight(compacted).ok, true, JSON.stringify(preflight(compacted)));
    const open = fx => new DatabaseSync(fx.databasePath, { readOnly: true });
    const a = open(compacted);
    const b = open(plain);
    try {
      for (const user of ["alice", "bob", "carol", "dave"]) {
        for (let p = 0; p <= maxSeq(plain.db); p++) {
          const claims = fx => ({ uid: user, epoch: 0, gen: fx.stage.restoreGeneration, pos: { ph: "f", p } });
          const got = readChangeFeedPage(a, { actorUserId: user, restoreGeneration: compacted.stage.restoreGeneration, claims: claims(compacted) });
          if (p < floor) assert.deepEqual(got, { ok: false, reason: "resync_required" }, `${seed} ${user} ${p}`);
          else assert.deepEqual(got, readChangeFeedPage(b, { actorUserId: user,
            restoreGeneration: plain.stage.restoreGeneration, claims: claims(plain) }), `${seed} ${user} ${p}`);
        }
      }
    } finally { a.close(); b.close(); }
  }
});

test("compaction probes seek the full key (change_log_by_key) and stay linear for tasks and memberships", () => {
  const fx = makeFixture();
  const plan = sql => fx.db.prepare("EXPLAIN QUERY PLAN " + sql).all().map(r => r.detail).join("\n");
  const keySeek = /USING (COVERING )?INDEX change_log_by_key \(entity_kind=\? AND entity_id=\? AND member_user_id=\? AND seq>\? AND seq<\?\)/;
  for (const where of ["x.entity_kind = 'task' AND x.entity_id = 'f-1' AND x.member_user_id IS NULL",
    "x.entity_kind = 'membership' AND x.entity_id = 'family-area' AND x.member_user_id IS 'bob'"]) {
    const probe = `SELECT 1 FROM change_log x WHERE ${where} AND x.seq > 1 AND x.seq <= 9`;
    assert.match(plan(probe), keySeek, plan(probe));
    assert.match(plan(probe.replace("FROM change_log x", "FROM change_log x INDEXED BY change_log_by_key")), keySeek);
  }
  const trigger = fx.db.prepare("SELECT sql FROM sqlite_schema WHERE name='change_log_guarded_delete'").get().sql;
  assert.match(trigger, /x\.member_user_id IS OLD\.member_user_id/);
  assert.doesNotMatch(trigger, /\+x\.member_user_id/);

  // 8000 tasks x 2 rows each compact in one pass well within the lock budget.
  fx.db.exec("BEGIN");
  const insert = fx.db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
  for (let i = 0; i < 8000; i++) insert.run(`perf-${i}`, "family-area", "t");
  fx.db.exec("UPDATE tasks SET title='u' WHERE id LIKE 'perf-%'");
  fx.db.exec("COMMIT");
  const rowsBefore = fx.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n;
  assert.ok(rowsBefore >= 16000);
  const started = performance.now();
  const result = compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() + 8 * DAY_MS });
  const elapsed = performance.now() - started;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.deleted >= 8000, JSON.stringify(result));
  assert.ok(elapsed < 4000, `compaction took ${Math.round(elapsed)} ms for ${rowsBefore} rows`);
  assert.equal(preflight(fx).ok, true);

  // 6000 members of ONE Area x 2 rows each: membership keys share entity_id (the Area),
  // so a seek without the member column would walk the whole Area per row (quadratic).
  const m = makeFixture();
  m.db.exec("BEGIN");
  const identity = m.db.prepare("INSERT INTO identities(id) VALUES (?)");
  const workspace = m.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)");
  const privateArea = m.db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
    VALUES (?, ?, 'private', ?, ?, 'unassigned')`);
  const add = m.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area', ?, 'viewer')");
  const promote = m.db.prepare("UPDATE area_members SET role='editor' WHERE area_id='family-area' AND user_id=?");
  for (let i = 0; i < 6000; i++) {
    const user = `perf-member-${i}`;
    identity.run(user);
    workspace.run(`${user}-personal`, user);
    privateArea.run(`${user}-private`, user, `${user}-personal`, user);
    add.run(user);
    promote.run(user);
  }
  m.db.exec("COMMIT");
  const memberStarted = performance.now();
  const memberResult = compactTargetStagingChangeLog(m.store, { retentionDays: 7, now: Date.now() + 8 * DAY_MS });
  const memberElapsed = performance.now() - memberStarted;
  assert.equal(memberResult.ok, true, JSON.stringify(memberResult));
  assert.ok(memberResult.deleted >= 6000, JSON.stringify(memberResult));
  assert.ok(memberElapsed < 4000, `membership compaction took ${Math.round(memberElapsed)} ms`);
  assert.equal(preflight(m).ok, true);
});

test("floor never passes a row still inside retention, even when commit times are not monotonic", () => {
  const fx = makeFixture();
  churn(fx.db, 1);
  const before = fx.db.prepare("SELECT COUNT(*) AS n FROM change_log").get().n;
  // A clock step backwards: a later sequence stamped 100 days in the past (raw insert, out of the trust model).
  fx.db.prepare(`INSERT INTO change_log(entity_kind,entity_id,area_id,op,revision,committed_at_ms)
    SELECT 'task', id, area_id, 'upsert', revision, ? FROM tasks WHERE id='f-1'`).run(Date.now() - 100 * DAY_MS);
  const stamped = maxSeq(fx.db);
  churn(fx.db, 2);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  // Every earlier row is within the 30 days retention, so nothing may be compacted although a
  // newer row looks ancient (the previous MAX(seq)-below-cutoff rule would have chosen `stamped`).
  assert.deepEqual(compactTargetStagingChangeLog(fx.store, { retentionDays: 30, now: Date.now() }),
    { ok: true, floor: 0, deleted: 0 });
  assert.ok(stamped > before);
  assert.equal(floorOf(fx.db), 0);
});
