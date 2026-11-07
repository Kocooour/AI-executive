import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2c.4a: irreversible journal + fail-closed rollback detection. Synthetic temp stores only.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2c4a-"));
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
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-r2c4a-session-secret-2026-10-30";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const journalLib = await import("../lib/target-staging-anchor-journal.ts");
const witnessLib = await import("../lib/target-staging-anchor-witness.ts");
const { compactTargetStagingChangeLog } = await import("../lib/target-staging-change-log-compaction.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const pinned = await import("../lib/target-staging-pinned-write.ts");
const identityLib = await import("../lib/target-staging-http-identity.ts");
const { writeFields } = await import("./support/target-write-contract.mjs");
const { PROTOCOL } = await import("./support/target-write-contract.mjs");
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

const REAL_NODE = process.execPath;
const authorities = [];
const raws = [];
after(() => {
  process.execPath = REAL_NODE;
  for (const authority of authorities) authority.close();
  for (const raw of raws) { try { raw.close(); } catch { /* already closed */ } }
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const base = "http://localhost:3001/api/target-staging/";
const SECRET_TITLE = "SECRET-TITLE-do-not-journal";
let counter = 0;
let ip = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** alice (owner, admin of team-area), bob (editor), carol (no membership yet). */
function makeFixture() {
  const name = `fx${++counter}`;
  const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, name), ownerUserId: "alice" });
  const db = new DatabaseSync(stage.databasePath);
  raws.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const user of ["bob", "carol"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)").run(`${user}-personal`, user);
    db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
      VALUES (?, ?, 'private', ?, ?, 'unassigned')`).run(`${user}-private`, `${user} private`, `${user}-personal`, user);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  for (const id of ["t1", "t2", "t3"]) db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)").run(id, "team-area", `Task ${id}`);
  const store = { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration };
  const authority = new TargetStagingSessionAuthority(store);
  authorities.push(authority);
  const fx = { name, stage, store, db, authority, journalPath: path.join(stage.directory, "lumi-target.journal"),
    databasePath: stage.databasePath };
  activate(fx);
  return fx;
}
function activate(fx) {
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = fx.stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fx.stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
}

// ---- journal / anchor accessors -------------------------------------------------------------

const anchorOf = fx => Number(fx.db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value);
const journalText = fx => readFileSync(fx.journalPath, "utf8");
const journalLines = fx => journalText(fx).trimEnd().split("\n").map(line => JSON.parse(line));
const journalState = fx => journalLib.verifyTargetStagingJournal(journalText(fx), fx.stage.restoreGeneration);
const snapshot = fx => ({ lines: journalLines(fx).length, anchor: anchorOf(fx) });

// ---- the six writers ------------------------------------------------------------------------

const writableToken = fx => fx.authority.issueWritable("alice").sessionToken;
/**
 * Each helper prepares the command while the store is still trusted (token, preview, policy
 * revision) and returns a function which sends it later, so tests can prove that a pinned
 * WRITER refuses an untrusted store on its own (not merely that the read path does).
 */
const prepareTitle = (fx, taskId, title = SECRET_TITLE) => {
  const token = writableToken(fx);
  const preview = fx.authority.previewTaskTitleEdit(token, { taskId });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const request = { commandId: randomUUID(), taskId, title, expectedRevision: preview.snapshotRevision,
    ...writeFields(fx.db, taskId, fx.stage.restoreGeneration) };
  return () => fx.authority.updateTaskTitle(token, request);
};
const prepareDelete = (fx, taskId) => {
  const token = writableToken(fx);
  const preview = fx.authority.previewTaskTitleEdit(token, { taskId });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const request = { commandId: randomUUID(), taskId, expectedRevision: preview.snapshotRevision,
    ...writeFields(fx.db, taskId, fx.stage.restoreGeneration) };
  return () => fx.authority.deleteTask(token, request);
};
const prepareMember = (fx, action, user, role) => {
  const policy = fx.db.prepare("SELECT policy_revision AS r FROM areas WHERE id='team-area'").get().r;
  const token = writableToken(fx);
  const command = { commandId: randomUUID(), areaId: "team-area", expectedPolicyRevision: policy,
    writeAreaId: "team-area", restoreGeneration: fx.stage.restoreGeneration, action, targetUserId: user,
    ...(role ? { role } : {}) };
  return () => fx.authority.applyMembershipCommand(token, command);
};
const titleWrite = (fx, taskId, title) => prepareTitle(fx, taskId, title)();
const deleteWrite = (fx, taskId) => prepareDelete(fx, taskId)();
const memberWrite = (fx, action, user, role) => prepareMember(fx, action, user, role)();

// ---- HTTP helpers ---------------------------------------------------------------------------

const ownerCookie = () => `${sessionCookieName}=${createSessionToken()}`;
const sessionCookie = token => `${durable.TARGET_STAGING_SESSION_COOKIE}=${token}`;
const clientIp = () => `10.9.${Math.floor(++ip / 250)}.${ip % 250}`;
const taskCtx = { params: Promise.resolve({ taskId: "t1" }) };
const areaCtx = { params: Promise.resolve({ areaId: "team-area" }) };
const jsonBody = JSON.stringify({ commandId: "11111111-1111-4111-8111-111111111111", expectedRevision: "a".repeat(64), title: "x" });
const post = (url, cookie) => new Request(base + url, { method: "POST", body: jsonBody,
  headers: { "content-type": "application/json", origin: "http://localhost:3001", ...PROTOCOL,
    ...(cookie ? { cookie } : {}), "x-forwarded-for": clientIp() } });
const get = (url, cookie) => new Request(base + url, {
  headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": clientIp() } });
const routes = {
  "tasks list": cookie => LIST(get("tasks?scope=shared", cookie)),
  "task detail": cookie => DETAIL(get("tasks/t1", cookie), taskCtx),
  "task audit": cookie => AUDIT(get("tasks/t1/audit", cookie), taskCtx),
  "projects": cookie => PROJECTS(get("projects", cookie)),
  "title preflight": cookie => TITLE_GET(get("tasks/t1/title", cookie), taskCtx),
  "title PATCH": cookie => TITLE_PATCH(new Request(base + "tasks/t1/title", { method: "PATCH", body: jsonBody,
    headers: { "content-type": "application/json", origin: "http://localhost:3001", ...PROTOCOL,
      ...(cookie ? { cookie } : {}), "x-forwarded-for": clientIp() } }), taskCtx),
  "title status": cookie => TITLE_STATUS(post("tasks/t1/title/status", cookie), taskCtx),
  "delete": cookie => DELETE_TASK(post("tasks/t1/delete", cookie), taskCtx),
  "delete status": cookie => DELETE_STATUS(post("tasks/t1/delete/status", cookie), taskCtx),
  "membership": cookie => MEMBERS(post("areas/team-area/members", cookie), areaCtx),
  "changes": cookie => FEED(get("changes", cookie)),
};
const expectGate = async (response, code, label) => {
  assert.equal(response.status, 503, label);
  assert.equal(response.headers.get("cache-control"), "no-store", label);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "Staging unavailable", code }, label);
  assert.ok(!/Task t|team-area|tasks|alice|bob/.test(text.replace(/Staging unavailable/, "")), `${label}: no data`);
};
/** Every route, with an owner cookie, a live session cookie and no credentials at all. */
async function expectAllRoutesGated(fx, code, label) {
  const live = durable.issueDurableTargetStagingSession; // a session must NOT be needed (or issuable) here
  void live;
  for (const [name, call] of Object.entries(routes)) {
    for (const [who, cookie] of [["owner", ownerCookie()], ["no credential", undefined]]) {
      await expectGate(await call(cookie), code, `${label}: ${name} (${who})`);
    }
  }
}

// ---- bootstrap ------------------------------------------------------------------------------

test("bootstrap creates a private journal (0600) with a genesis record and anchor_seq 0", () => {
  const fx = makeFixture();
  const info = statSync(fx.journalPath);
  assert.equal(info.isFile(), true);
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal(info.nlink, 1);
  const lines = journalLines(fx);
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], h: undefined }, { n: 0, t: "genesis", k: null, p: null,
    g: fx.stage.restoreGeneration, prev: "0".repeat(64), h: undefined });
  assert.match(lines[0].h, /^[0-9a-f]{64}$/);
  assert.equal(anchorOf(fx), 0);
  assert.deepEqual(journalState(fx), { lastIntent: 0, confirmed: 0, pending: null, lastHash: lines[0].h,
    generation: fx.stage.restoreGeneration, records: 1, pendingRestore: null });
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory, mode: "r2-model" }).ok, true);
});

// ---- every writer appends exactly one intent+confirm pair -------------------------------------

test("every writer appends exactly one intent+confirm pair, advances anchor_seq by one, content-free payloads", () => {
  const fx = makeFixture();
  const issued = [];
  const cases = [
    ["title", () => titleWrite(fx, "t1"), payload => {
      assert.ok(Array.isArray(payload.seq) && payload.seq.length === 2 && payload.seq[0] <= payload.seq[1]);
      assert.deepEqual(Object.keys(payload), ["seq"]);
    }],
    ["delete", () => deleteWrite(fx, "t2"), payload => {
      assert.ok(Array.isArray(payload.seq) && payload.seq.length === 2);
      assert.deepEqual(Object.keys(payload), ["seq"]);
    }],
    ["membership", () => memberWrite(fx, "add", "carol", "viewer"), payload => {
      assert.equal(payload.area, "team-area");
      assert.equal(payload.user, "carol");
      assert.equal(payload.op, "add");
      assert.equal(payload.role, "viewer");
    }],
    ["membership", () => memberWrite(fx, "set_role", "carol", "editor"), payload => {
      assert.deepEqual({ ...payload, seq: undefined }, { area: "team-area", user: "carol", op: "set_role", role: "editor", seq: undefined });
    }],
    ["membership", () => memberWrite(fx, "remove", "carol"), payload => {
      assert.equal(payload.op, "remove");
      assert.equal(payload.role, null);
    }],
    ["session_issue", () => {
      const result = durable.issueDurableTargetStagingSession(fx.store, "bob", 600);
      assert.equal(result.ok, true);
      issued.push(result);
      return result;
    }, payload => {
      assert.equal(payload.userId, "bob");
      assert.equal(payload.tokenHash, durable.hashTargetStagingSessionToken(issued.at(-1).sessionToken));
      assert.equal(payload.epoch, 0);
    }],
    ["session_revoke", () => durable.revokeDurableTargetStagingSession(fx.store, issued.at(-1).sessionId), payload => {
      assert.equal(payload.userId, "bob");
      assert.equal(payload.tokenHash, durable.hashTargetStagingSessionToken(issued.at(-1).sessionToken));
      assert.equal(payload.epoch, 0);
    }],
    ["session_revoke_all", () => durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "bob"), payload => {
      assert.deepEqual(payload, { userId: "bob", epochAfter: 1 });
    }],
    ["compaction", () => compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() }), payload => {
      assert.deepEqual(Object.keys(payload), ["floor"]);
      assert.ok(Number.isSafeInteger(payload.floor));
    }],
  ];
  for (const [kind, run, checkPayload] of cases) {
    const before = snapshot(fx);
    const result = run();
    assert.equal(result.ok, true, `${kind}: ${JSON.stringify(result)}`);
    const after = snapshot(fx);
    assert.equal(after.lines, before.lines + 2, `${kind}: one intent + one confirm`);
    assert.equal(after.anchor, before.anchor + 1, `${kind}: anchor advances by one`);
    const [intent, confirm] = journalLines(fx).slice(-2);
    assert.equal(intent.t, "intent");
    assert.equal(intent.k, kind);
    assert.equal(intent.n, after.anchor);
    assert.equal(confirm.t, "confirm");
    assert.equal(confirm.n, intent.n);
    assert.equal(confirm.k, null);
    assert.equal(confirm.prev, intent.h);
    checkPayload(intent.p);
  }
  const state = journalState(fx);
  assert.equal(state.confirmed, anchorOf(fx));
  assert.equal(state.pending, null);
  assert.equal(state.lastIntent, cases.length);
  // Content-free: no title, task content or raw credential ever enters the journal.
  const text = journalText(fx);
  assert.ok(!text.includes(SECRET_TITLE) && !text.includes("Task t") && !text.includes(issued[0].sessionToken));
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory, mode: "r2-model",
    expectedRestoreGeneration: fx.stage.restoreGeneration }).ok, true);
});

test("a write which commits nothing (replay, refusal, unknown user) journals nothing", () => {
  const fx = makeFixture();
  const issued = durable.issueDurableTargetStagingSession(fx.store, "bob", 600);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, issued.sessionId).ok, true);
  const before = snapshot(fx);
  assert.deepEqual(durable.revokeDurableTargetStagingSession(fx.store, issued.sessionId), { ok: true, changed: false });
  assert.deepEqual(durable.issueDurableTargetStagingSession(fx.store, "nobody", 600), { ok: false, reason: "unknown_user" });
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "nobody").ok, false);
  assert.deepEqual(snapshot(fx), before);
});

// ---- hand-copied DB restore -----------------------------------------------------------------

test("copying an older DB file back: every route answers 503 restore_pending with no data (title-only drift)", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "before backup").ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  // Pure content writes after the backup: no revocation, no membership change at all.
  assert.equal(titleWrite(fx, "t1", "after backup 1").ok, true);
  assert.equal(titleWrite(fx, "t3", "after backup 2").ok, true);
  assert.equal(await (await routes["tasks list"](ownerCookie())).status, 200);
  const journalBefore = journalText(fx);
  const armed = { title: prepareTitle(fx, "t2", "late"), member: prepareMember(fx, "add", "carol", "viewer"),
    delete: prepareDelete(fx, "t3") };

  copyFileSync(backup, fx.databasePath);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  await expectAllRoutesGated(fx, "restore_pending", "after copy-back");
  // Writers refuse as well and write nothing (neither DB nor journal).
  assert.equal(armed.title().ok, false);
  assert.deepEqual(durable.issueDurableTargetStagingSession(fx.store, "bob", 600), { ok: false, reason: "unavailable" });
  assert.deepEqual(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "bob"), { ok: false, reason: "unavailable" });
  assert.equal(armed.member().ok, false);
  assert.equal(armed.delete().ok, false);
  assert.equal(compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() }).ok, false);
  assert.equal(journalText(fx), journalBefore);
  // The feature flag still decides first: disabled means plain 404.
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "false";
  try {
    assert.equal((await routes["tasks list"](ownerCookie())).status, 404);
  } finally {
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
  }
});

test("copying an older DB file back: restore_pending when only a session issue happened after the backup", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "before backup").ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  const issued = durable.issueDurableTargetStagingSession(fx.store, "bob", 600);
  assert.equal(issued.ok, true);
  assert.equal((await routes["tasks list"](sessionCookie(issued.sessionToken))).status, 200);
  copyFileSync(backup, fx.databasePath);
  // The session row is gone with the copy-back; before identity resolution the store is untrusted.
  await expectGate(await routes["tasks list"](sessionCookie(issued.sessionToken)), "restore_pending", "stale session");
  await expectAllRoutesGated(fx, "restore_pending", "session-only drift");
});

test("restoring the DB to the genesis state (never written) is also detected once a single write happened", async () => {
  const fx = makeFixture();
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "bob").ok, true);
  copyFileSync(backup, fx.databasePath);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
});

// ---- concurrency and crash recovery ---------------------------------------------------------

function runChild(fx, mode, gate = "", rounds = 1) {
  const child = spawn(process.execPath, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
    "tests/support/target-anchor-gated-child.mjs", fx.stage.directory, fx.stage.restoreGeneration, mode, gate,
    String(rounds)],
  { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  // A failed spawn emits "error" before "close". Keep its diagnosis instead
  // of throwing an unhandled EventEmitter error while another child is live.
  child.on("error", error => { stderr += `spawn error: ${error.message}\n`; });
  const done = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

// A failed readiness assertion must not skip child joins: the test file's
// after() hook deletes the shared fixture root. Always release the gate,
// collect both exits (and stderr), and bound a genuinely hung child.
async function releaseColdWriterGateAndJoin(writers, gate, { terminateAfterMs = 15000, forceAfterMs = 17000 } = {}) {
  let readyCount = 0;
  let setupError = null;
  try {
    for (let i = 0; i < 500; i++) {
      readyCount = readdirSync(gate).filter(name => name.startsWith("ready-")).length;
      if (readyCount === writers.length) break;
      // No need to wait the entire readiness timeout for a crashed child.
      if (writers.some(({ child }) => child.exitCode !== null || child.signalCode !== null)) break;
      await sleep(10);
    }
    assert.equal(readyCount, writers.length, "all cold writer processes must load before release");
  } catch (error) {
    setupError = error;
  }

  const stopLive = signal => {
    for (const { child } of writers) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
  };
  try {
    writeFileSync(path.join(gate, "go"), "");
  } catch (error) {
    setupError ??= error;
    stopLive("SIGTERM");
  }
  let timedOut = false;
  const terminate = setTimeout(() => { timedOut = true; stopLive("SIGTERM"); }, terminateAfterMs);
  const forceKill = setTimeout(() => { timedOut = true; stopLive("SIGKILL"); }, forceAfterMs);
  let results;
  try {
    results = await Promise.all(writers.map(writer => writer.done));
  } finally {
    clearTimeout(terminate);
    clearTimeout(forceKill);
  }
  if (setupError || timedOut) {
    const reason = setupError?.message ?? "child exit deadline expired";
    throw new Error(`cold writer startup/cleanup failed (${readyCount}/${writers.length} ready): ${reason}; children: ${JSON.stringify(results)}`,
      { cause: setupError ?? undefined });
  }
  return results;
}
const recoverHotJournal = fx => {
  // What an operator does after a killed writer: one ordinary open lets SQLite roll back.
  const raw = new DatabaseSync(fx.databasePath);
  raw.prepare("SELECT COUNT(*) FROM metadata").get();
  raw.close();
  // The killed writer's rollback journal never became hot (nothing reached the DB file): the
  // existing runbook (ARCHITECTURE R2c.2b) moves it aside after the check above.
  if (existsSync(fx.databasePath + "-journal")) unlinkSync(fx.databasePath + "-journal");
};

test("concurrent writers in several processes keep one linear, valid chain (every intent confirmed once)", async () => {
  const fx = makeFixture();
  const results = await Promise.all([1, 2, 3].map(() => runChild(fx, "plain", "", 8).done));
  const detail = results.map(r => r.stdout).join(" ");
  const issued = results.reduce((sum, result) => sum + JSON.parse(result.stdout).done, 0);
  assert.equal(issued, 24, detail);
  const state = journalState(fx);
  assert.ok(state, "the chain verifies: " + detail);
  assert.equal(state.pending, null);
  assert.equal(state.confirmed, anchorOf(fx));
  assert.equal(anchorOf(fx), issued, "one anchor step per successful write, none lost or duplicated");
  // Exactly one confirm per intent and no abort: the post-commit guard never double-confirms.
  const counts = new Map();
  for (const line of journalLines(fx)) if (line.t !== "genesis") counts.set(line.t + line.n, (counts.get(line.t + line.n) ?? 0) + 1);
  for (let n = 1; n <= issued; n++) {
    assert.equal(counts.get("intent" + n), 1, "intent " + n);
    assert.equal(counts.get("confirm" + n), 1, "confirm " + n);
    assert.equal(counts.get("abort" + n), undefined, "abort " + n);
  }
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("a transient SQLite rollback sidecar is not mistaken for an untrusted store", async () => {
  const fx = makeFixture();
  const gate = mkdtempSync(path.join(root, "sidecar-contention-"));
  const holding = runChild(fx, "hold-sidecar", gate);
  for (let i = 0; i < 200 && !existsSync(path.join(gate, "ready")); i++) await sleep(5);
  assert.ok(existsSync(path.join(gate, "ready")), "child started its real SQLite write");
  assert.equal(existsSync(fx.databasePath + "-journal"), true, "sidecar exists before second writer");
  // This previously returned `denied` immediately, without ever attempting
  // the SQLite lock, despite a legitimate writer holding the rollback journal.
  const outcome = pinned.withPinnedTargetStagingWrite(fx.store,
    context => { context.commit({ kind: "compaction", payload: { floor: 0 } }); return "ok"; },
    () => "denied", () => "failed", 200);
  const holder = await holding.done;
  assert.equal(holder.code, 0, JSON.stringify(holder));
  assert.equal(outcome, "ok", "the sidecar disappears within the bounded lock wait");
  assert.equal(journalState(fx).pending, null);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("an active SQLite rollback lock beyond busy_timeout is retryable, not denied", async () => {
  const fx = makeFixture();
  const gate = mkdtempSync(path.join(root, "sidecar-long-contention-"));
  const holding = runChild(fx, "hold-sidecar-long", gate);
  for (let i = 0; i < 200 && !existsSync(path.join(gate, "ready")); i++) await sleep(5);
  assert.ok(existsSync(path.join(gate, "ready")), "child holds a live SQLite write transaction");
  assert.equal(existsSync(fx.databasePath + "-journal"), true);
  const before = { anchor: anchorOf(fx), journal: journalText(fx) };
  const outcome = pinned.withPinnedTargetStagingWrite(fx.store,
    context => { context.commit({ kind: "compaction", payload: { floor: 0 } }); return "ok"; },
    () => "denied", () => "failed", 200);
  assert.equal(outcome, "failed", "real lock timeout must not look like untrusted data");
  assert.deepEqual({ anchor: anchorOf(fx), journal: journalText(fx) }, before,
    "a failed writer cannot touch the DB or irreversible journal");
  const holder = await holding.done;
  assert.equal(holder.code, 0, JSON.stringify(holder));
  assert.equal(pinned.withPinnedTargetStagingWrite(fx.store,
    context => { context.commit({ kind: "compaction", payload: { floor: 0 } }); return "ok"; },
    () => "denied", () => "failed"), "ok", "the writer can retry after the other lock releases");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("regular rollback sidecar without an observable writer lock is retryable, never denied", () => {
  const fx = makeFixture();
  const sidecar = fx.databasePath + "-journal";
  const original = { anchor: anchorOf(fx), journal: journalText(fx) };
  // Deterministic model of the lock-release / journal-unlink gap: an SQLite
  // rollback sidecar exists with no current lock. A journal left by a crashed
  // process is observationally identical. The old /proc/locks heuristic
  // returned "denied" on Linux; the writer must fail closed as "failed".
  writeFileSync(sidecar, Buffer.alloc(512));
  let enteredBody = false;
  const attempt = pinned.withPinnedTargetStagingWrite(fx.store,
    () => { enteredBody = true; return "ok"; },
    () => "denied", () => "failed", 0);
  assert.equal(attempt, "failed", "ambiguous sidecar is retryable, never a trust denial");
  assert.equal(enteredBody, false, "never open SQLite or execute the write body");
  assert.deepEqual({ anchor: anchorOf(fx), journal: journalText(fx) }, original,
    "no canonical data or irreversible journal changed");
  assert.equal(existsSync(sidecar), true, "no implicit SQLite rollback or sidecar removal");
  // Once an operator has removed the sidecar, a new independent write succeeds.
  unlinkSync(sidecar);
  assert.equal(pinned.withPinnedTargetStagingWrite(fx.store,
    context => { context.commit({ kind: "compaction", payload: { floor: 0 } }); return "ok"; },
    () => "denied", () => "failed"), "ok");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("symlinked SQLite rollback sidecar is still a strict boundary denial", () => {
  const fx = makeFixture();
  const sidecar = fx.databasePath + "-journal";
  const target = path.join(root, `${fx.name}-sidecar-target`);
  writeFileSync(target, "untouched");
  symlinkSync(target, sidecar);
  let enteredBody = false;
  assert.equal(pinned.withPinnedTargetStagingWrite(fx.store,
    () => { enteredBody = true; return "ok"; },
    () => "denied", () => "failed", 0), "denied");
  assert.equal(enteredBody, false);
  assert.equal(readFileSync(target, "utf8"), "untouched");
  unlinkSync(sidecar);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("six un-retried concurrent writers at the original 6x80 load never confuse contention with trust denial", async () => {
  const fx = makeFixture();
  const workers = Array.from({ length: 6 }, () => runChild(fx, "raw-many", "", 80));
  const results = await Promise.all(workers.map(w => w.done));
  assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
  const counts = results.map(r => JSON.parse(r.stdout));
  const totals = counts.reduce((sum, r) => ({
    ok: sum.ok + r.ok, failed: sum.failed + r.failed, denied: sum.denied + r.denied,
  }), { ok: 0, failed: 0, denied: 0 });
  assert.equal(totals.ok + totals.failed + totals.denied, 480, JSON.stringify(counts));
  assert.equal(totals.denied, 0, "legitimate concurrency must not be an authorization/trust refusal: " +
    JSON.stringify(counts));
  assert.ok(totals.ok > 0, "some writes must have committed");
  // A failed attempt may have fsynced its intent before a SQLite COMMIT failure.
  // Such an intent consumes an n and gets an abort at the NEXT write: anchor_seq
  // need not equal the number of successful writes. Finish with one uncontended
  // write, which also closes any pending intent left by the last failed writer.
  const settled = pinned.withPinnedTargetStagingWrite(fx.store,
    context => { context.commit({ kind: "compaction", payload: { floor: 0 } }); return "ok"; },
    () => "denied", () => "failed");
  assert.equal(settled, "ok", "the shared store remains writable after contention");
  const state = journalState(fx);
  assert.equal(state.pending, null);
  assert.equal(state.confirmed, anchorOf(fx));
  assert.equal(journalLines(fx).filter(line => line.t === "confirm").length, totals.ok + 1);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("a write in flight on another process (intent appended, not committed) does not trip reads", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const gate = mkdtempSync(path.join(root, "gate-"));
  const anchorBefore = anchorOf(fx);
  const running = runChild(fx, "pause", gate);
  for (let i = 0; i < 400 && !existsSync(path.join(gate, "ready")); i++) await sleep(25);
  assert.ok(existsSync(path.join(gate, "ready")), "child reached the pause between intent and commit");
  try {
    const state = journalState(fx);
    assert.equal(state.pending, anchorBefore + 1, "trailing unconfirmed intent");
    assert.equal(anchorOf(fx), anchorBefore, "not committed yet");
    // The first process keeps reading: the anchor gate never reports a rollback or invalid journal.
    for (let i = 0; i < 3; i++) {
      assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
      const response = await routes["tasks list"](ownerCookie());
      const body = await response.json();
      assert.notEqual(body.code, "restore_pending");
      assert.notEqual(body.code, "journal_invalid");
    }
  } finally {
    writeFileSync(path.join(gate, "go"), "");
  }
  const result = await running.done;
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, reason: null, done: 1 });
  assert.equal(anchorOf(fx), anchorBefore + 1);
  const state = journalState(fx);
  assert.equal(state.pending, null);
  assert.equal(state.confirmed, anchorBefore + 1);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  assert.equal((await routes["tasks list"](ownerCookie())).status, 200);
});

test("crash after the intent but before COMMIT: reads stay ok, the next writer appends abort", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const anchorBefore = anchorOf(fx);
  const result = await runChild(fx, "crash-before-commit").done;
  assert.equal(result.signal, "SIGKILL");
  // The killed writer left a NON-hot SQLite journal (zero header). A normal open does not clear
  // it, and the sidecar rule refuses every writer and the read child until the operator acts.
  const sidecar = fx.databasePath + "-journal";
  assert.equal(existsSync(sidecar), true);
  assert.deepEqual([...readFileSync(sidecar).subarray(0, 8)], [0, 0, 0, 0, 0, 0, 0, 0], "zero magic: not hot");
  const opener = new DatabaseSync(fx.databasePath);
  opener.prepare("SELECT COUNT(*) FROM metadata").get();
  opener.close();
  assert.equal(existsSync(sidecar), true, "a normal open does not clear it");
  // Even a crashed writer's regular journal cannot be proven orphaned from
  // the writer's view: fail closed with retryable timeout on every platform.
  // The operator must still inspect/remove the non-hot sidecar manually.
  assert.deepEqual(durable.issueDurableTargetStagingSession(fx.store, "bob", 600),
    { ok: false, reason: "write_failed" });
  assert.equal((await routes["tasks list"](ownerCookie())).status, 503);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok", "still no restore state");
  recoverHotJournal(fx); // documented runbook: header magic is zero -> remove it
  assert.equal(anchorOf(fx), anchorBefore, "nothing committed");
  const crashed = journalState(fx);
  assert.equal(crashed.pending, anchorBefore + 1);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok", "a crash is not a restore");
  assert.equal((await routes["tasks list"](ownerCookie())).status, 200);

  const next = durable.issueDurableTargetStagingSession(fx.store, "bob", 600);
  assert.equal(next.ok, true);
  const tail = journalLines(fx).slice(-4);
  assert.deepEqual(tail.map(line => [line.t, line.n]), [
    ["intent", anchorBefore + 1], ["abort", anchorBefore + 1],
    ["intent", anchorBefore + 2], ["confirm", anchorBefore + 2]]);
  assert.equal(anchorOf(fx), anchorBefore + 2, "numbers are never reused after an abort");
  const state = journalState(fx);
  assert.deepEqual([state.pending, state.confirmed, state.lastIntent], [null, anchorBefore + 2, anchorBefore + 2]);
  // An aborted intent has NO witness row. The gap is legitimate and must not
  // prevent subsequent reads or a cold process from validating the sequence.
  const witness = new DatabaseSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"));
  try {
    assert.deepEqual(witness.prepare("SELECT n FROM commits ORDER BY n").all().map(row => row.n),
      [0, anchorBefore, anchorBefore + 2]);
  } finally { witness.close(); }
  witnessLib.clearTargetStagingWitnessCache();
  journalLib.clearTargetStagingJournalCache();
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("crash after COMMIT but before the confirm: reads stay ok, the next writer appends confirm", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const anchorBefore = anchorOf(fx);
  const result = await runChild(fx, "crash-before-confirm").done;
  assert.equal(result.signal, "SIGKILL");
  assert.equal(anchorOf(fx), anchorBefore + 1, "committed");
  assert.equal(journalState(fx).pending, anchorBefore + 1);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  assert.equal((await routes["tasks list"](ownerCookie())).status, 200);

  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "bob").ok, true);
  const tail = journalLines(fx).slice(-4);
  assert.deepEqual(tail.map(line => [line.t, line.n]), [
    ["intent", anchorBefore + 1], ["confirm", anchorBefore + 1],
    ["intent", anchorBefore + 2], ["confirm", anchorBefore + 2]]);
  assert.equal(anchorOf(fx), anchorBefore + 2);
  assert.equal(journalState(fx).pending, null);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("a restore after a lost confirm is detected once any later write resolved the tail", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  await runChild(fx, "crash-before-confirm").done;
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "bob").ok, true);
  copyFileSync(backup, fx.databasePath);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
});

test("a copied older main DB is rejected even when the latest committed intent lost its confirm", async () => {
  // SQLite's attached witness commits together with main, whereas a backup
  // restoration replaces only main: the witness sees the lost COMMIT.
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  const result = await runChild(fx, "crash-before-confirm").done;
  assert.equal(result.signal, "SIGKILL");
  copyFileSync(backup, fx.databasePath);
  assert.equal(journalState(fx).pending, anchorOf(fx) + 1);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  await expectGate(await routes["tasks list"](ownerCookie()), "restore_pending", "lost confirm main restore");
});

test("committed session revocation remains fail-closed after lost confirm and main-only DB restore", async () => {
  const fx = makeFixture();
  const issued = durable.issueDurableTargetStagingSession(fx.store, "bob", 600);
  assert.equal(issued.ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  const result = await runChild(fx, "crash-before-confirm-revoke", issued.sessionId).done;
  assert.equal(result.signal, "SIGKILL");
  copyFileSync(backup, fx.databasePath);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  await expectGate(await routes["tasks list"](sessionCookie(issued.sessionToken)),
    "restore_pending", "revoked session must not resume");
  assert.equal(durable.verifyDurableTargetStagingSessionLive(fx.store,
    durable.hashTargetStagingSessionToken(issued.sessionToken)).ok, false);
});

// ---- journal tampering ----------------------------------------------------------------------

const tampers = {
  "missing": fx => unlinkSync(fx.journalPath),
  "non-canonical unterminated fragment": fx => appendFileSync(fx.journalPath, '{"n": 1}'),
  "oversized unterminated fragment": fx => appendFileSync(fx.journalPath, "x".repeat(5000)),
  "empty": fx => truncateSync(fx.journalPath, 0),
  "a line edited (chain break)": fx => {
    const text = journalText(fx);
    writeFileSync(fx.journalPath, text.replace(/"epoch":0/, '"epoch":9'), { mode: 0o600 });
    assert.notEqual(journalText(fx), text);
  },
  "a line deleted": fx => {
    const lines = journalText(fx).split("\n");
    lines.splice(2, 1);
    writeFileSync(fx.journalPath, lines.join("\n"), { mode: 0o600 });
  },
  "garbage line appended": fx => appendFileSync(fx.journalPath, "not json\n"),
  "non-canonical whitespace": fx => {
    const lines = journalText(fx).split("\n");
    lines[1] = lines[1].replace('"g":', '"g": ');
    writeFileSync(fx.journalPath, lines.join("\n"), { mode: 0o600 });
  },
  "symlinked journal": fx => {
    const real = fx.journalPath + ".real";
    renameSync(fx.journalPath, real);
    symlinkSync(real, fx.journalPath);
  },
  "wrong mode (0644)": fx => chmodSync(fx.journalPath, 0o644),
  "a second hard link": fx => linkSync(fx.journalPath, fx.journalPath + ".link"),
  "other generation": fx => {
    const other = randomUUID();
    const genesis = journalLib.targetStagingJournalGenesis(other);
    writeFileSync(fx.journalPath, genesis.text, { mode: 0o600 });
  },
  "journal is a directory": fx => { unlinkSync(fx.journalPath); mkdirSync(fx.journalPath, { mode: 0o700 }); },
  "anchor above the highest intent": fx => fx.db.prepare("UPDATE metadata SET value='99' WHERE key='anchor_seq'").run(),
  "reordered records": fx => {
    const lines = journalText(fx).split("\n");
    [lines[1], lines[2]] = [lines[2], lines[1]];
    writeFileSync(fx.journalPath, lines.join("\n"), { mode: 0o600 });
  },
};
for (const [label, tamper] of Object.entries(tampers)) {
  test(`journal ${label}: 503 journal_invalid on every route, writers write nothing`, async () => {
    const fx = makeFixture();
    assert.equal(titleWrite(fx, "t1", "one").ok, true);
    assert.equal(durable.issueDurableTargetStagingSession(fx.store, "bob", 600).ok, true);
    const armed = { title: prepareTitle(fx, "t2", "late"), member: prepareMember(fx, "add", "carol", "viewer"),
      delete: prepareDelete(fx, "t3") };
    tamper(fx);
    // Edits of EARLIER lines are only caught by a process without a verified prefix (a restart);
    // the cache trade-off is asserted explicitly in the prefix-cache test.
    journalLib.clearTargetStagingJournalCache();
    const dbBefore = readFileSync(fx.databasePath);
    const entryBefore = existsSync(fx.journalPath);
    const journalBefore = existsSync(fx.journalPath) && statSync(fx.journalPath).isFile() ? journalText(fx) : null;
    assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
    await expectAllRoutesGated(fx, "journal_invalid", label);
    assert.equal(armed.title().ok, false);
    assert.deepEqual(durable.issueDurableTargetStagingSession(fx.store, "bob", 600), { ok: false, reason: "unavailable" });
    assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "bob").ok, false);
    assert.equal(armed.member().ok, false);
    assert.equal(armed.delete().ok, false);
    assert.equal(compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() }).ok, false);
    assert.deepEqual(readFileSync(fx.databasePath), dbBefore, "database untouched");
    if (journalBefore !== null) assert.equal(journalText(fx), journalBefore, "journal untouched");
    else assert.equal(existsSync(fx.journalPath), entryBefore, "no journal is silently re-created");
  });
}

// ---- anchor_seq triggers --------------------------------------------------------------------

test("anchor_seq: decrease, delete, rename onto, UPDATE OR REPLACE, INSERT [OR REPLACE] and malformed values are refused", () => {
  const fx = makeFixture();
  assert.equal(durable.issueDurableTargetStagingSession(fx.store, "bob", 600).ok, true);
  assert.equal(anchorOf(fx), 1);
  const metadata = () => JSON.stringify(fx.db.prepare("SELECT key,value FROM metadata ORDER BY key").all());
  const before = metadata();
  const refused = (sql, ...args) => {
    assert.throws(() => fx.db.prepare(sql).run(...args), /anchor sequence/, sql);
    assert.equal(metadata(), before, sql);
  };
  refused("UPDATE metadata SET value='0' WHERE key='anchor_seq'");
  refused("DELETE FROM metadata WHERE key='anchor_seq'");
  refused("UPDATE metadata SET key='anchor_seq' WHERE key='write_protocol'");
  refused("UPDATE OR REPLACE metadata SET key='anchor_seq' WHERE key='activated'");
  refused("UPDATE metadata SET key='renamed' WHERE key='anchor_seq'");
  refused("INSERT INTO metadata(key,value) VALUES ('anchor_seq','5')");
  refused("INSERT OR REPLACE INTO metadata(key,value) VALUES ('anchor_seq','0')");
  refused("INSERT OR IGNORE INTO metadata(key,value) VALUES ('anchor_seq','0')");
  for (const bad of ["01", "x", "", "-1", "1.5", "1e3", "1234567890123456"]) {
    refused("UPDATE metadata SET value=? WHERE key='anchor_seq'", bad);
  }
  refused("UPDATE metadata SET value=? WHERE key='anchor_seq'", 7);
  // Only a larger canonical decimal is accepted.
  fx.db.prepare("UPDATE metadata SET value='5' WHERE key='anchor_seq'").run();
  assert.equal(anchorOf(fx), 5);
  // ... and a store whose anchor ran ahead of its journal fails closed.
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
});

test("preflight validates anchor_seq (a missing or malformed value fails the store)", () => {
  const fx = makeFixture();
  const raw = new DatabaseSync(fx.databasePath);
  raw.exec("DROP TRIGGER anchor_seq_no_delete; DELETE FROM metadata WHERE key='anchor_seq'");
  raw.close();
  const check = inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory, mode: "r2-model" });
  assert.equal(check.ok, false);
  assert.ok(check.issues.includes("metadata_invalid") || check.issues.includes("schema_invalid"));
});

test("writer waits for a short EXCLUSIVE main SQLite lock before its first SELECT", async () => {
  const fx = makeFixture();
  const gate = mkdtempSync(path.join(root, "exclusive-lock-"));
  const running = runChild(fx, "exclusive-lock", gate);
  for (let i = 0; i < 200 && !existsSync(path.join(gate, "ready")); i++) await sleep(10);
  assert.ok(existsSync(path.join(gate, "ready")), "competing process took its EXCLUSIVE lock");
  const result = pinned.withPinnedTargetStagingWrite(fx.store,
    context => { context.commit({ kind: "compaction", payload: { floor: 0 } }); return "ok"; },
    () => "denied", () => "failed", 200);
  const finished = await running.done;
  assert.equal(finished.code, 0, JSON.stringify(finished));
  assert.equal(result, "ok", "the writer waits for a short lock instead of throwing SQLITE_BUSY");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("witness detects a changed middle commit hash despite an unchanged head and count", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "first").ok, true);
  assert.equal(titleWrite(fx, "t1", "second").ok, true);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok"); // warm both prefix caches
  const witness = new DatabaseSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"));
  try {
    witness.exec("DROP TRIGGER commits_immutable_update");
    witness.prepare("UPDATE commits SET journal_hash=? WHERE n=1").run("f".repeat(64));
  } finally { witness.close(); }
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
  assert.deepEqual(durable.issueDurableTargetStagingSession(fx.store, "bob", 600),
    { ok: false, reason: "unavailable" }, "writer must not alter an invalid witness");
});

test("witness rejects missing internal committed sequence numbers", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "first").ok, true);
  assert.equal(titleWrite(fx, "t1", "second").ok, true);
  const witness = new DatabaseSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"));
  try {
    witness.exec("DROP TRIGGER commits_immutable_delete");
    witness.exec("DELETE FROM commits WHERE n=1");
  } finally { witness.close(); }
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
});

test("witness rejects a changed last committed intent hash", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "first").ok, true);
  const witness = new DatabaseSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"));
  try {
    witness.exec("DROP TRIGGER commits_immutable_update");
    witness.prepare("UPDATE commits SET journal_hash=? WHERE n=1").run("e".repeat(64));
  } finally { witness.close(); }
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
});

// Synthetic journal inflation bypasses the real writers solely for performance measurements.
// Mirror every fabricated committed intent into the independent witness as well.
function seedSyntheticWitness(fx, entries) {
  const db = new DatabaseSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"));
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const add = db.prepare("INSERT INTO commits(n,journal_hash,generation) VALUES (?,?,?)");
      for (const [n, hash] of entries) add.run(n, hash, fx.stage.restoreGeneration);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  } finally { db.close(); }
}

// ---- performance sanity ---------------------------------------------------------------------

test("performance: full-chain verification of a 5000-write journal stays far below the request budget", async () => {
  const fx = makeFixture();
  const generation = fx.stage.restoreGeneration;
  // Append 5000 genuine intent+confirm pairs (the same serializer the writers use) and move the
  // anchor to 5000, which the trigger permits (increase only). 5000 real SQLite writes would only
  // measure SQLite.
  let prev = journalLines(fx).at(-1).h;
  let text = "";
  const syntheticCommits = [];
  for (let n = 1; n <= 5000; n++) {
    const intent = journalLib.serializeTargetStagingJournalLine({
      n, t: "intent", k: "title", p: { seq: [n, n] }, g: generation, prev });
    const confirm = journalLib.serializeTargetStagingJournalLine({
      n, t: "confirm", k: null, p: null, g: generation, prev: intent.hash });
    text += intent.text + confirm.text;
    syntheticCommits.push([n, intent.hash]);
    prev = confirm.hash;
  }
  appendFileSync(fx.journalPath, text);
  seedSyntheticWitness(fx, syntheticCommits);
  fx.db.prepare("UPDATE metadata SET value='5000' WHERE key='anchor_seq'").run();
  const size = statSync(fx.journalPath).size;

  const time = (fn, rounds = 15) => {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const start = process.hrtime.bigint();
      fn();
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  };
  assert.equal(journalLib.verifyTargetStagingJournal(journalText(fx), generation).confirmed, 5000);
  const verifyMs = time(() => journalLib.verifyTargetStagingJournal(journalText(fx), generation));
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  const gateMs = time(() => durable.checkTargetStagingAnchorLive(fx.store));
  process.stdout.write(`# R2c.4a perf: journal ${size} bytes / 10001 records, verify median ${verifyMs.toFixed(1)} ms, `
    + `live gate (pin + SQLite open + verify) median ${gateMs.toFixed(1)} ms\n`);
  // The existing read budget is seconds (live checks wait up to 2 s on a lock); a verification
  // which is a small fraction of that is "well under". Generous bound for slow CI machines.
  assert.ok(verifyMs < 250, `verify ${verifyMs} ms`);
  assert.ok(gateMs < 400, `live gate ${gateMs} ms`);
  // A real write and a real route still work on the long journal.
  const response = await routes["tasks list"](ownerCookie());
  assert.equal(response.status, 200);
  const start = process.hrtime.bigint();
  const issued = durable.issueDurableTargetStagingSession(fx.store, "bob", 600);
  const writeMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(issued.ok, true);
  assert.equal(anchorOf(fx), 5001);
  assert.ok(writeMs < 2000, `write ${writeMs} ms`);
});

// ---- FIFO at the journal path ---------------------------------------------------------------

test("a FIFO planted at the journal path is refused without blocking (gate and writer)", () => {
  const fx = makeFixture();
  unlinkSync(fx.journalPath);
  execFileSync("mkfifo", ["-m", "600", fx.journalPath]);
  const run = spawnSync(process.execPath, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
    "tests/support/target-anchor-gate-child.mjs", fx.stage.directory, fx.stage.restoreGeneration],
  { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.error, undefined, "the child did not hang: " + String(run.error));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { gate: "journal_invalid", ok: false, reason: "unavailable" });
});

// ---- torn tail ------------------------------------------------------------------------------

test("an unterminated trailing fragment is ignored by readers; the next writer cuts it and appends correctly", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const clean = journalText(fx);
  // A writer's append in flight (or torn by ENOSPC/EIO): half of a would-be intent line.
  const half = journalLib.serializeTargetStagingJournalLine({
    n: anchorOf(fx) + 1, t: "intent", k: "title", p: { seq: [9, 9] }, g: fx.stage.restoreGeneration,
    prev: journalState(fx).lastHash }).text.slice(0, 60);
  appendFileSync(fx.journalPath, half);
  assert.equal(journalState(fx).confirmed, anchorOf(fx));
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  assert.equal((await routes["tasks list"](ownerCookie())).status, 200);
  assert.equal(durable.issueDurableTargetStagingSession(fx.store, "bob", 600).ok, true);
  const text = journalText(fx);
  assert.ok(text.startsWith(clean), "complete lines untouched");
  assert.ok(!text.includes(half.slice(0, 60)) || text.split(half).length === 1, "fragment gone");
  assert.equal(text.endsWith("\n"), true);
  assert.deepEqual(journalLines(fx).slice(-2).map(line => line.t), ["intent", "confirm"]);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("a torn confirm after a committed write: reads ok, the next writer repairs and confirms", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const n = anchorOf(fx);
  truncateSync(fx.journalPath, statSync(fx.journalPath).size - 12); // cut the confirm line
  assert.equal(journalState(fx).pending, n);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, "bob").ok, true);
  assert.deepEqual(journalLines(fx).slice(-4).map(line => [line.t, line.n]),
    [["intent", n], ["confirm", n], ["intent", n + 1], ["confirm", n + 1]]);
});

// ---- verified-prefix cache ------------------------------------------------------------------

const cachedFd = (fx, fn) => {
  const fd = journalLib.openTargetStagingJournal(fx.stage.directory, false);
  try { return fn(fd); } finally { closeSync(fd); }
};
test("prefix cache: appended lines verify incrementally; a changed last line, shrink or new inode forces full checks", () => {
  const fx = makeFixture();
  for (let i = 0; i < 3; i++) assert.equal(titleWrite(fx, "t1", `w${i}`).ok, true);
  const gen = fx.stage.restoreGeneration;
  assert.ok(cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen)));
  // Append through a real writer: incremental result equals a fresh full verification.
  assert.equal(titleWrite(fx, "t1", "more").ok, true);
  const incremental = cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen));
  assert.deepEqual(incremental.state, journalLib.verifyTargetStagingJournal(journalText(fx), gen));
  // Edit the LAST line in place (same size): detected at the boundary.
  const text = journalText(fx);
  const lines = text.split("\n");
  const last = lines.length - 2;
  lines[last] = lines[last].replace(/[0-9a-f]/, c => (c === "a" ? "b" : "a")); // flips a prev/hash hex digit
  writeFileSync(fx.journalPath, lines.join("\n"), { mode: 0o600 });
  assert.equal(cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen)), null);
  // Documented trade-off: an in-place edit of an EARLIER line is invisible to this process (cached
  // prefix) but a restarted process (empty cache) rejects it.
  const early = text.split("\n");
  early[1] = early[1].replace('"k":"title"', '"k":"delete"');
  writeFileSync(fx.journalPath, early.join("\n"), { mode: 0o600 });
  assert.equal(early.join("\n") === text, false);
  cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen));
  journalLib.clearTargetStagingJournalCache();
  assert.equal(cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen)), null);
  // Restore, then shrink below the cached end: full verification of the shorter chain.
  writeFileSync(fx.journalPath, text, { mode: 0o600 });
  assert.ok(cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen)));
  const shorter = lines.slice(0, 3).join("\n") + "\n";
  writeFileSync(fx.journalPath, shorter, { mode: 0o600 });
  assert.equal(cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen)).state.records, 3);
  // A replacement file (new inode) with a broken chain is verified in full.
  const swapped = fx.journalPath + ".new";
  writeFileSync(swapped, shorter.replace('"k":"title"', '"k":"delete"') + text.slice(shorter.length), { mode: 0o600 });
  renameSync(swapped, fx.journalPath);
  assert.equal(cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen)), null);
});

for (const writes of [5000, 20000]) {
  test(`performance: cached per-request check on a ${writes}-write journal (cold vs warm vs +1 append)`, () => {
    const fx = makeFixture();
    const gen = fx.stage.restoreGeneration;
    let prev = journalLines(fx).at(-1).h;
    const chunks = [];
    const syntheticCommits = [];
    for (let n = 1; n <= writes; n++) {
      const intent = journalLib.serializeTargetStagingJournalLine({ n, t: "intent", k: "title", p: { seq: [n, n] }, g: gen, prev });
      const confirm = journalLib.serializeTargetStagingJournalLine({ n, t: "confirm", k: null, p: null, g: gen, prev: intent.hash });
      chunks.push(intent.text, confirm.text);
      syntheticCommits.push([n, intent.hash]);
      prev = confirm.hash;
    }
    appendFileSync(fx.journalPath, chunks.join(""));
    seedSyntheticWitness(fx, syntheticCommits);
    fx.db.prepare("UPDATE metadata SET value=? WHERE key='anchor_seq'").run(String(writes));
    const ms = fn => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
    const median = (fn, rounds = 15) => {
      const samples = Array.from({ length: rounds }, () => ms(fn)).sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)];
    };
    const full = median(() => journalLib.verifyTargetStagingJournal(journalText(fx), gen), 5);
    const cold = ms(() => assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok"));
    const warm = median(() => assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok"));
    const scanWarm = median(() => cachedFd(fx, fd => journalLib.scanTargetStagingJournalFd(fd, gen)));
    // One more real write, then the first check after it (incremental: only the new lines).
    assert.equal(durable.issueDurableTargetStagingSession(fx.store, "bob", 600).ok, true);
    const afterAppend = ms(() => assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok"));
    process.stdout.write(`# R2c.4a perf ${writes} writes: full verify ${full.toFixed(1)} ms, cold gate ${cold.toFixed(1)} ms, `
      + `warm gate ${warm.toFixed(1)} ms (journal scan alone ${scanWarm.toFixed(2)} ms), gate after +1 write ${afterAppend.toFixed(1)} ms\n`);
    assert.ok(scanWarm < 15, `warm journal scan ${scanWarm} ms`);
    assert.ok(afterAppend < 150, `incremental ${afterAppend} ms`);
    assert.ok(warm < Math.max(40, cold), `warm gate ${warm} ms`);
  });
}

// ---- review round 1 -------------------------------------------------------------------------

/** Append `writes` genuine intent+confirm pairs and move the anchor (same serializer as the writers). */
function inflate(fx, writes) {
  const gen = fx.stage.restoreGeneration;
  let state = journalState(fx);
  let prev = state.lastHash;
  let n0 = state.lastIntent;
  const chunks = [];
  const syntheticCommits = [];
  for (let i = 1; i <= writes; i++) {
    const n = n0 + i;
    const intent = journalLib.serializeTargetStagingJournalLine({ n, t: "intent", k: "title", p: { seq: [n, n] }, g: gen, prev });
    const confirm = journalLib.serializeTargetStagingJournalLine({ n, t: "confirm", k: null, p: null, g: gen, prev: intent.hash });
    chunks.push(intent.text, confirm.text);
    syntheticCommits.push([n, intent.hash]);
    prev = confirm.hash;
  }
  appendFileSync(fx.journalPath, chunks.join(""));
  seedSyntheticWitness(fx, syntheticCommits);
  fx.db.prepare("UPDATE metadata SET value=? WHERE key='anchor_seq'").run(String(n0 + writes));
}

test("cold processes verify the long chain BEFORE taking the write lock: two cold 200 ms-timeout writers both succeed", async () => {
  const fx = makeFixture();
  inflate(fx, 20000);
  const base0 = anchorOf(fx);
  // Both processes must be fully loaded *before* either starts its cold
  // journal verification. An arbitrary 100ms stagger raced the OS scheduler
  // and could instead start the second process under the first fsync/lock.
  // This barrier still tests two genuinely cold verifications racing for the
  // same 200ms SQLite lock: no warm-up in the child and no retry.
  const gate = mkdtempSync(path.join(root, "cold-writer-start-"));
  const writers = [runChild(fx, "raw-cold-gated", gate),
    runChild(fx, "raw-cold-gated", gate)];
  const results = await releaseColdWriterGateAndJoin(writers, gate);
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).outcome),
    ["ok", "ok"], JSON.stringify(results));
  assert.equal(anchorOf(fx), base0 + 2);
  assert.equal(journalState(fx).pending, null);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("failed cold writer readiness releases the gate and joins ALL children before cleanup", async () => {
  const fx = makeFixture();
  const before = anchorOf(fx);
  const gate = mkdtempSync(path.join(root, "cold-writer-failure-"));
  const writers = [
    runChild(fx, "raw-cold-gated", gate),
    runChild(fx, "raw-cold-gated-fail-before-ready", gate),
  ];
  await assert.rejects(
    releaseColdWriterGateAndJoin(writers, gate),
    error => error.message.includes("cold writer startup/cleanup failed") &&
      error.message.includes("synthetic pre-ready child failure"),
  );
  // Reaching this assertion means the rejected helper awaited both close events.
  const results = await Promise.all(writers.map(writer => writer.done));
  assert.ok(writers.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
  assert.equal(results[1].code, 42);
  assert.match(results[1].stderr, /synthetic pre-ready child failure/);
  assert.equal(results[0].code, 0);
  assert.equal(JSON.parse(results[0].stdout).outcome, "ok");
  assert.equal(anchorOf(fx), before + 1, "the released healthy writer must finish before cleanup");
  assert.equal(journalState(fx).pending, null);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("a hung cold writer is killed and joined before fixture cleanup", async () => {
  const fx = makeFixture();
  const gate = mkdtempSync(path.join(root, "cold-writer-stall-"));
  const writer = runChild(fx, "raw-cold-gated-hang-after-ready", gate);
  await assert.rejects(
    releaseColdWriterGateAndJoin([writer], gate, { terminateAfterMs: 200, forceAfterMs: 500 }),
    /cold writer startup\/cleanup failed.*child exit deadline expired/,
  );
  const result = await writer.done;
  assert.ok(["SIGTERM", "SIGKILL"].includes(result.signal), JSON.stringify(result));
  assert.equal(journalState(fx).pending, null);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

for (const scenario of ["restore_pending", "journal_invalid"]) {
  const degrade = (fx, backup) => {
    if (scenario === "restore_pending") copyFileSync(backup, fx.databasePath);
    else unlinkSync(fx.journalPath);
    journalLib.clearTargetStagingJournalCache();
  };
  const setup = () => {
    const fx = makeFixture();
    assert.equal(titleWrite(fx, "t1", "warm").ok, true);
    const backup = path.join(root, `${fx.name}.backup.sqlite`);
    copyFileSync(fx.databasePath, backup);
    assert.equal(titleWrite(fx, "t1", "later").ok, true);
    return { fx, backup };
  };
  const observed = { actorUserId: "alice", areas: [] };
  const ownerRequest = () => new Request(base + "tasks", { headers: { cookie: ownerCookie() } });

  test(`${scenario}: the read child, the live checks and the release-time checks refuse (no data)`, () => {
    const { fx, backup } = setup();
    const token = fx.authority.issue("alice").sessionToken;
    const issued = durable.issueDurableTargetStagingSession(fx.store, "bob", 600);
    assert.equal(issued.ok, true);
    const hash = durable.hashTargetStagingSessionToken(issued.sessionToken);
    const sessionIdentity = { kind: "session", tokenHash: hash };
    // Healthy store: everything answers (so the refusals below are caused by the store state).
    const healthy = fx.authority.list(token, { scope: "shared" });
    assert.equal(healthy.ok, true);
    assert.ok(healthy.tasks.length > 0);
    assert.equal(durable.verifyDurableTargetStagingSessionLiveCoded(fx.store, hash).ok, true);
    assert.equal(durable.verifyTargetStagingReadLive(fx.store, { ownerUserId: "alice" }, observed).ok, true);
    assert.equal(identityLib.verifyStagingReadBeforeRelease(ownerRequest(), { kind: "owner" }, fx.store, "alice", observed), "ok");

    degrade(fx, backup);
    // withPreflightedStore (the child-process read path): denied, no tasks.
    assert.deepEqual(fx.authority.list(token, { scope: "shared" }), { ok: false, reason: "unauthorized", tasks: [], nextCursor: null });
    assert.deepEqual(fx.authority.readSharedTaskDetail(token, "t1"), null);
    // Live checks (withLiveStagingReadTransaction without an onAnchorFailure handler).
    assert.deepEqual(durable.verifyDurableTargetStagingSessionLiveCoded(fx.store, hash), { ok: false, reason: "unavailable" });
    assert.deepEqual(durable.verifyDurableTargetStagingSessionLive(fx.store, hash), { ok: false, reason: "unavailable" });
    assert.deepEqual(durable.verifyTargetStagingReadLive(fx.store, { ownerUserId: "alice" }, observed), { ok: false, reason: "unavailable" });
    assert.deepEqual(durable.verifyTargetStagingReadLive(fx.store, { tokenHash: hash }, observed), { ok: false, reason: "unavailable" });
    assert.equal(identityLib.verifyStagingReadBeforeRelease(ownerRequest(), { kind: "owner" }, fx.store, "alice", observed), "unavailable");
    assert.equal(identityLib.verifyStagingReadBeforeRelease(ownerRequest(), sessionIdentity, fx.store, "alice", observed), "unavailable");
    assert.equal(identityLib.verifyStagingIdentityBeforeRelease(ownerRequest(), sessionIdentity, fx.store), "unavailable");
    assert.equal(durable.checkTargetStagingAnchorLive(fx.store), scenario);
  });
}

test("a store restored AFTER the gate passed (between gate and read child) answers 503 with no data", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  assert.equal(titleWrite(fx, "t1", "later").ok, true);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  // The read child is spawned through process.execPath: this wrapper copies the old DB back first.
  const wrapper = path.join(root, `${fx.name}-restore-wrapper.sh`);
  writeFileSync(wrapper, `#!/bin/sh\ncp "${backup}" "${fx.databasePath}"\nexec "${REAL_NODE}" "$@"\n`, { mode: 0o700 });
  process.execPath = wrapper;
  let response;
  try {
    response = await routes["tasks list"](ownerCookie()); // the gate runs in this process, before the swap
  } finally {
    process.execPath = REAL_NODE;
  }
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.ok(!/Task t|later|warm|team-area/.test(text), text);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
});

test("a restore_pending store with a torn fragment: writers refuse and the journal bytes stay unchanged", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  assert.equal(titleWrite(fx, "t1", "later").ok, true);
  appendFileSync(fx.journalPath, '{"g":"');
  copyFileSync(backup, fx.databasePath);
  const before = readFileSync(fx.journalPath);
  assert.deepEqual(durable.issueDurableTargetStagingSession(fx.store, "bob", 600), { ok: false, reason: "unavailable" });
  assert.deepEqual(readFileSync(fx.journalPath), before, "fragment not cut on an untrusted store");
});

test("a reader racing a writer's fragment truncation reads the bytes that exist (short read is not corruption)", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  appendFileSync(fx.journalPath, '{"g":"torn');
  const size = statSync(fx.journalPath).size;
  const fd = journalLib.openTargetStagingJournal(fx.stage.directory, false);
  try {
    // fstat said `size`; the writer then truncated the fragment: the read returns fewer bytes.
    truncateSync(fx.journalPath, size - 10);
    const buffer = journalLib.readTargetStagingJournalRange(fd, 0, size);
    assert.equal(buffer.length, size - 10);
    const scan = journalLib.scanTargetStagingJournalFd(fd, fx.stage.restoreGeneration);
    assert.ok(scan && scan.state.confirmed === anchorOf(fx));
  } finally { closeSync(fd); }
});

test("the serializer enforces the verifier's rules: an invalid record can never be appended", () => {
  const gen = randomUUID();
  const prev = "a".repeat(64);
  const make = overrides => journalLib.serializeTargetStagingJournalLine({
    n: 1, t: "intent", k: "title", p: { seq: [1, 1] }, g: gen, prev, ...overrides });
  assert.doesNotThrow(() => make({}));
  for (const [label, overrides] of Object.entries({
    "unknown kind": { k: "bogus" }, "intent without payload": { p: null }, "intent without kind": { k: null },
    "9 payload keys": { p: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ["k" + i, i])) },
    "long string": { p: { a: "x".repeat(300) } }, "float": { p: { a: 1.5 } }, "nested object": { p: { a: { b: 1 } } },
    "long key": { p: { ["k".repeat(40)]: 1 } }, "bad generation": { g: "nope" }, "bad prev": { prev: "zz" },
    "n zero intent": { n: 0 }, "confirm with payload": { t: "confirm", k: null, p: { a: 1 } },
    "abort with kind": { t: "abort", k: "title", p: null }, "genesis with n": { t: "genesis", k: null, p: null, n: 3 },
  })) assert.throws(() => make(overrides), label);
  // And through the writer: an oversized payload rolls the transaction back.
  const fx = makeFixture();
  const before = { journal: journalText(fx), anchor: anchorOf(fx) };
  const outcome = pinned.withPinnedTargetStagingWrite(fx.store,
    context => { context.commit({ kind: "compaction", payload: { floor: "x".repeat(300) } }); return "done"; },
    () => "denied", () => "failed");
  assert.equal(outcome, "failed");
  assert.deepEqual({ journal: journalText(fx), anchor: anchorOf(fx) }, before);
});

// The lstat-vs-fstat dev/ino comparison in openTargetStagingJournal is defense in depth against a
// swap between lstat and open. It cannot be driven deterministically without a hook between two
// syscalls inside the function (no such hook is added to production code), so it has no test; the
// symlink, FIFO, hard-link, mode and owner checks around it are covered above.

// R2c.4a: the post-COMMIT confirm applies the SAME trust rule as the pre-write path (witness included).
async function confirmAttempt(fx, { fragment = false, restore = null } = {}) {
  // Store with a committed-but-unconfirmed trailing intent n (anchor == witness == n).
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  assert.equal((await runChild(fx, "crash-before-confirm").done).signal, "SIGKILL");
  const n = anchorOf(fx);
  assert.equal(journalState(fx).pending, n);
  if (fragment) appendFileSync(fx.journalPath, '{"g":"');
  if (restore) copyFileSync(backup, fx.databasePath); // in-place restore: anchor n-1
  const before = readFileSync(fx.journalPath);
  const db = new DatabaseSync(fx.databasePath);
  const fd = journalLib.openTargetStagingJournal(fx.stage.directory, true);
  try {
    assert.ok(fd !== null);
    const witness = witnessLib.attachTargetStagingWitness(db, fx.stage.directory, fx.stage.restoreGeneration);
    assert.ok(witness);
    db.exec("BEGIN IMMEDIATE");
    const appended = pinned.appendTargetStagingConfirmIfTrusted(db, fd, fx.stage.restoreGeneration,
      fx.stage.directory, n, () => witness.stillAttached());
    db.exec("ROLLBACK");
    return { appended, before, after: readFileSync(fx.journalPath), n };
  } finally { db.close(); if (fd !== null) closeSync(fd); }
}

test("post-commit confirm: a trusted store gets exactly one confirm n", async () => {
  const fx = makeFixture();
  const r = await confirmAttempt(fx);
  assert.equal(r.appended, true);
  const last = journalLines(fx).at(-1);
  assert.deepEqual([last.t, last.n], ["confirm", r.n]);
  assert.equal(journalState(fx).pending, null);
});

test("post-commit confirm: an in-place restored main DB (anchor n-1, witness n) gets no confirm and no change", async () => {
  const fx = makeFixture();
  const r = await confirmAttempt(fx, { restore: true });
  assert.equal(r.appended, false);
  assert.deepEqual(r.after, r.before, "journal bytes unchanged");
  assert.equal(journalState(fx).pending, r.n);
});

test("post-commit confirm: an untrusted store keeps its torn fragment untouched", async () => {
  const fx = makeFixture();
  const r = await confirmAttempt(fx, { restore: true, fragment: true });
  assert.equal(r.appended, false);
  assert.deepEqual(r.after, r.before, "fragment not cut on an untrusted store");
});

test("post-commit confirm: a trusted store cuts the torn fragment, then confirms", async () => {
  const fx = makeFixture();
  const r = await confirmAttempt(fx, { fragment: true });
  assert.equal(r.appended, true);
  assert.equal(journalState(fx).pending, null);
});

test("post-commit in-place restore through the real writer: no confirm, journal bytes unchanged, next writer denied", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  const backup = path.join(root, `${fx.name}.p2.sqlite`);
  copyFileSync(fx.databasePath, backup); // anchor 2
  const three = prepareTitle(fx, "t1", "three");
  const four = prepareTitle(fx, "t1", "four");
  // Test-local hook: restore the main DB right after the writer's COMMIT, before its confirm.
  const origExec = DatabaseSync.prototype.exec;
  let armed = true;
  let intentOnly = null;
  DatabaseSync.prototype.exec = function (sql) {
    const result = origExec.call(this, sql);
    if (armed && sql === "COMMIT") {
      armed = false;
      intentOnly = readFileSync(fx.journalPath);
      copyFileSync(backup, fx.databasePath);
    }
    return result;
  };
  try { three(); } finally { DatabaseSync.prototype.exec = origExec; }
  assert.ok(intentOnly, "hook ran after COMMIT");
  assert.deepEqual(readFileSync(fx.journalPath), intentOnly, "no confirm appended on the restored store");
  assert.equal(journalLines(fx).at(-1).t, "intent");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  assert.equal(four().ok, false);
  assert.deepEqual(readFileSync(fx.journalPath), intentOnly, "next writer leaves the journal untouched");
});

// Atomic replacement (rename) swaps the inode: the open connection keeps the ORIGINAL file,
// so anchor_seq and the attached witness still read n. Only the path/inode re-check detects it.
function atomicReplaceAfterCommit(fx, target, backupName) {
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  const backup = path.join(root, `${fx.name}.${backupName}.sqlite`);
  copyFileSync(target, backup); // state at anchor 2
  const three = prepareTitle(fx, "t1", "three");
  const four = prepareTitle(fx, "t1", "four");
  const origExec = DatabaseSync.prototype.exec;
  let armed = true;
  let intentOnly = null;
  DatabaseSync.prototype.exec = function (sql) {
    const result = origExec.call(this, sql);
    if (armed && sql === "COMMIT") {
      armed = false;
      intentOnly = readFileSync(fx.journalPath);
      const temp = path.join(path.dirname(target), `${path.basename(target)}.swap`);
      copyFileSync(backup, temp);
      renameSync(temp, target);
    }
    return result;
  };
  try { three(); } finally { DatabaseSync.prototype.exec = origExec; }
  assert.ok(intentOnly, "hook ran after COMMIT");
  assert.deepEqual(readFileSync(fx.journalPath), intentOnly, "no confirm appended");
  assert.equal(journalLines(fx).at(-1).t, "intent");
  return { four, intentOnly };
}

test("post-commit atomic rename of an older main DB: no confirm, journal bytes unchanged, next writer denied", () => {
  const fx = makeFixture();
  const { four, intentOnly } = atomicReplaceAfterCommit(fx, fx.databasePath, "p2rename");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  assert.equal(four().ok, false);
  assert.deepEqual(readFileSync(fx.journalPath), intentOnly, "next writer leaves the journal untouched");
});

test("post-commit atomic rename of an older witness: no confirm, store fails closed", () => {
  const fx = makeFixture();
  const witnessPath = path.join(fx.stage.directory, witnessLib.TARGET_STAGING_WITNESS_FILENAME);
  const { four, intentOnly } = atomicReplaceAfterCommit(fx, witnessPath, "w2rename");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
  assert.equal(four().ok, false);
  assert.deepEqual(readFileSync(fx.journalPath), intentOnly, "next writer leaves the journal untouched");
});

// Run `swap` once, right before the writer runs its anchor UPDATE: after the pre-write check
// and the durable intent, before the witness insert and COMMIT.
function runWithSwapBeforeCommit(write, swap, prefix = "UPDATE metadata SET value = ?") {
  const origPrepare = DatabaseSync.prototype.prepare;
  let armed = true;
  DatabaseSync.prototype.prepare = function (sql) {
    if (armed && String(sql).includes(prefix)) { armed = false; swap(); }
    return origPrepare.call(this, sql);
  };
  try { return write(); } finally { DatabaseSync.prototype.prepare = origPrepare; }
}

test("older journal renamed over the canonical path before COMMIT: write not ok, anchor not advanced", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = path.join(root, `${fx.name}.jold.jsonl`);
  copyFileSync(fx.journalPath, backup);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  const anchorBefore = anchorOf(fx);
  const three = prepareTitle(fx, "t1", "three");
  const result = runWithSwapBeforeCommit(three, () => {
    const temp = `${fx.journalPath}.swap`;
    copyFileSync(backup, temp);
    chmodSync(temp, 0o600);
    renameSync(temp, fx.journalPath);
  });
  assert.equal(result.ok, false, "write must not be acknowledged");
  assert.equal(anchorOf(fx), anchorBefore, "anchor not advanced");
  const raw = new DatabaseSync(fx.databasePath, { readOnly: true });
  try {
    assert.equal(raw.prepare("SELECT title FROM tasks WHERE id='t1'").get().title, "two");
  } finally { raw.close(); }
});

test("older journal renamed over the canonical path after COMMIT: no confirm into the orphan, store fails closed", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = path.join(root, `${fx.name}.jold2.jsonl`);
  copyFileSync(fx.journalPath, backup);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  const three = prepareTitle(fx, "t1", "three");
  const four = prepareTitle(fx, "t1", "four");
  const origExec = DatabaseSync.prototype.exec;
  let armed = true;
  DatabaseSync.prototype.exec = function (sql) {
    const result = origExec.call(this, sql);
    if (armed && sql === "COMMIT") {
      armed = false;
      const temp = `${fx.journalPath}.swap`;
      copyFileSync(backup, temp);
      chmodSync(temp, 0o600);
      renameSync(temp, fx.journalPath);
    }
    return result;
  };
  try { three(); } finally { DatabaseSync.prototype.exec = origExec; }
  assert.deepEqual(readFileSync(fx.journalPath), readFileSync(backup), "replacement journal untouched");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
  assert.equal(four().ok, false);
});

test("main DB renamed over the canonical path before COMMIT: write not ok, nothing committed", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  const backup = path.join(root, `${fx.name}.mold.sqlite`);
  copyFileSync(fx.databasePath, backup);
  const three = prepareTitle(fx, "t1", "three");
  const result = runWithSwapBeforeCommit(three, () => {
    const temp = `${fx.databasePath}.swap`;
    copyFileSync(backup, temp);
    renameSync(temp, fx.databasePath);
  });
  assert.equal(result.ok, false, "write must not be acknowledged");
  assert.deepEqual(readFileSync(fx.databasePath), readFileSync(backup), "canonical DB holds no committed write");
});

// In-place overwrite (same inode) of the witness between COMMIT and confirm.
test("post-commit in-place copy of an older witness: no confirm, journal bytes unchanged, next writer denied", () => {
  const fx = makeFixture();
  const witnessPath = path.join(fx.stage.directory, witnessLib.TARGET_STAGING_WITNESS_FILENAME);
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  const backup = path.join(root, `${fx.name}.w2inplace.sqlite`);
  copyFileSync(witnessPath, backup);
  const three = prepareTitle(fx, "t1", "three");
  const four = prepareTitle(fx, "t1", "four");
  const origExec = DatabaseSync.prototype.exec;
  let armed = true;
  let intentOnly = null;
  DatabaseSync.prototype.exec = function (sql) {
    const result = origExec.call(this, sql);
    if (armed && sql === "COMMIT") {
      armed = false;
      intentOnly = readFileSync(fx.journalPath);
      copyFileSync(backup, witnessPath);
    }
    return result;
  };
  try { three(); } finally { DatabaseSync.prototype.exec = origExec; }
  assert.ok(intentOnly, "hook ran after COMMIT");
  assert.deepEqual(readFileSync(fx.journalPath), intentOnly, "no confirm appended");
  assert.equal(journalLines(fx).at(-1).t, "intent");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
  assert.equal(four().ok, false);
  assert.deepEqual(readFileSync(fx.journalPath), intentOnly, "next writer leaves the journal untouched");
});

test("main DB renamed before the writer's pre-write check: nothing durable, journal bytes unchanged", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = path.join(root, `${fx.name}.mold2.sqlite`);
  copyFileSync(fx.databasePath, backup);
  const journalBefore = readFileSync(fx.journalPath);
  const two = prepareTitle(fx, "t1", "two");
  // The audit INSERT is the last statement the title body prepares before commit().
  const result = runWithSwapBeforeCommit(two, () => {
    const temp = `${fx.databasePath}.swap`;
    copyFileSync(backup, temp);
    renameSync(temp, fx.databasePath);
  }, "INSERT INTO task_title_audit");
  assert.equal(result.ok, false);
  assert.deepEqual(readFileSync(fx.journalPath), journalBefore, "no intent appended");
});

// A rename landing DURING the confirm's verdict (after the first path check, inside the fresh
// transaction) is caught only by the second path check, after the verdict.
test("older main DB renamed during the post-commit verdict: no confirm, store fails closed", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = path.join(root, `${fx.name}.mverdict.sqlite`);
  copyFileSync(fx.databasePath, backup);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  const three = prepareTitle(fx, "t1", "three");
  const origExec = DatabaseSync.prototype.exec;
  const origPrepare = DatabaseSync.prototype.prepare;
  let phase = 0;
  let intentOnly = null;
  DatabaseSync.prototype.exec = function (sql) {
    const result = origExec.call(this, sql);
    if (phase === 0 && sql === "COMMIT") { phase = 1; intentOnly = readFileSync(fx.journalPath); }
    return result;
  };
  DatabaseSync.prototype.prepare = function (sql) {
    // The confirm's verdict reads the anchor first: swap right then (phase 1 = after COMMIT).
    if (phase === 1 && String(sql).includes("SELECT value FROM metadata WHERE key='anchor_seq'")) {
      phase = 2;
      const temp = `${fx.databasePath}.swap`;
      copyFileSync(backup, temp);
      renameSync(temp, fx.databasePath);
    }
    return origPrepare.call(this, sql);
  };
  try { three(); } finally {
    DatabaseSync.prototype.exec = origExec;
    DatabaseSync.prototype.prepare = origPrepare;
  }
  assert.equal(phase, 2, "the swap ran inside the confirm verdict");
  assert.deepEqual(readFileSync(fx.journalPath), intentOnly, "no confirm appended");
  assert.notEqual(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});
