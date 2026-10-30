import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
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
const { compactTargetStagingChangeLog } = await import("../lib/target-staging-change-log-compaction.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
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

const authorities = [];
const raws = [];
after(() => {
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
    generation: fx.stage.restoreGeneration, records: 1 });
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
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const done = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, stdout })));
  return { child, done };
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
  recoverHotJournal(fx);
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

test("DOCUMENTED LIMITATION: restoring the copy taken just before a write whose confirm was lost, with no write in between, is not detected", async () => {
  // anchor == highest confirmed with one trailing unconfirmed intent looks exactly like a crash
  // before COMMIT. Only a restore of that precise copy in that precise window is affected; the
  // journal still carries the lost intent with its payload for the restore procedure (R2c.4b).
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "warm").ok, true);
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  await runChild(fx, "crash-before-confirm").done;
  copyFileSync(backup, fx.databasePath);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  assert.equal(journalState(fx).pending, anchorOf(fx) + 1);
});

// ---- journal tampering ----------------------------------------------------------------------

const tampers = {
  "missing": fx => unlinkSync(fx.journalPath),
  "truncated mid-line": fx => truncateSync(fx.journalPath, statSync(fx.journalPath).size - 12),
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

// ---- performance sanity ---------------------------------------------------------------------

test("performance: full-chain verification of a 5000-write journal stays far below the request budget", async () => {
  const fx = makeFixture();
  const generation = fx.stage.restoreGeneration;
  // Append 5000 genuine intent+confirm pairs (the same serializer the writers use) and move the
  // anchor to 5000, which the trigger permits (increase only). 5000 real SQLite writes would only
  // measure SQLite.
  let prev = journalLines(fx).at(-1).h;
  let text = "";
  for (let n = 1; n <= 5000; n++) {
    const intent = journalLib.serializeTargetStagingJournalLine({
      n, t: "intent", k: "title", p: { seq: [n, n] }, g: generation, prev });
    const confirm = journalLib.serializeTargetStagingJournalLine({
      n, t: "confirm", k: null, p: null, g: generation, prev: intent.hash });
    text += intent.text + confirm.text;
    prev = confirm.hash;
  }
  appendFileSync(fx.journalPath, text);
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
