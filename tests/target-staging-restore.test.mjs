import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2c.4b: operator restore with anti-rollback (replay, new restoreGeneration, revoke all, last-admin
// invariant, the 401 code session_restored). Synthetic temp stores only.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2c4b-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED", "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION", "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
];
const old = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
const SECRET = "synthetic-r2c4b-session-secret-2026-10-30";
process.env.NODE_ENV = "production";
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") +
  ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = SECRET;
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore, TARGET_STORE_SCHEMA_VERSION, TARGET_STAGING_RESTORE_HISTORY_MAX, TARGET_STAGING_SUPERSEDED_SESSIONS_MAX } = await import("../lib/target-store-bootstrap.ts");
const preflightLib = await import("../lib/target-store-preflight.ts");
const { inspectIsolatedTargetStore } = preflightLib;
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const journalLib = await import("../lib/target-staging-anchor-journal.ts");
const witnessLib = await import("../lib/target-staging-anchor-witness.ts");
const restoreLib = await import("../lib/target-staging-restore.ts");
const identityLib = await import("../lib/target-staging-http-identity.ts");
const feedCursor = await import("../lib/target-staging-feed-cursor.ts");
const writePreflight = await import("../lib/target-task-write-preflight.ts");
const noteWritePreflight = await import("../lib/target-note-write-contract.ts");
const { compactTargetStagingChangeLog } = await import("../lib/target-staging-change-log-compaction.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const pinned = await import("../lib/target-staging-pinned-write.ts");
const { writeFields, PROTOCOL } = await import("./support/target-write-contract.mjs");
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

function addIdentity(db, user) {
  db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)").run(`${user}-personal`, user);
  db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
    VALUES (?, ?, 'private', ?, ?, 'unassigned')`).run(`${user}-private`, `${user} private`, `${user}-personal`, user);
}
/** alice (owner, admin of team-area), bob + carol (editors), dave (no membership). t2 is assigned to bob. */
function makeFixture() {
  const name = `fx${++counter}`;
  const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, name), ownerUserId: "alice" });
  const db = new DatabaseSync(stage.databasePath);
  raws.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const user of ["bob", "carol", "dave"]) addIdentity(db, user);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','alice','admin')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','carol','editor')").run();
  for (const id of ["t1", "t2", "t3"]) db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)").run(id, "team-area", `Task ${id}`);
  db.prepare("UPDATE tasks SET assignee_user_id='bob' WHERE id='t2'").run();
  const fx = { name, stage, db, journalPath: path.join(stage.directory, "lumi-target.journal"),
    databasePath: stage.databasePath, store: null, authority: null, generations: [stage.restoreGeneration] };
  useStore(fx, stage.restoreGeneration);
  return fx;
}
/** Point the fixture (and the process environment, like a restarted server) at a generation. */
function useStore(fx, generation) {
  fx.stage = { ...fx.stage, restoreGeneration: generation };
  fx.store = { stagingDirectory: fx.stage.directory, expectedRestoreGeneration: generation };
  if (fx.authority) fx.authority.close();
  fx.authority = new TargetStagingSessionAuthority(fx.store);
  authorities.push(fx.authority);
  activate(fx);
}
function activate(fx) {
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = fx.stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = fx.stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
}

// ---- accessors -------------------------------------------------------------------------------

const anchorOf = fx => Number(fx.db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value);
const generationOf = fx => fx.db.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value;
const journalText = fx => readFileSync(fx.journalPath, "utf8");
const journalLines = fx => journalText(fx).trimEnd().split("\n").map(line => JSON.parse(line));
const journalState = fx => journalLib.verifyTargetStagingJournal(journalText(fx), generationOf(fx));
const epochs = fx => Object.fromEntries(fx.db.prepare("SELECT id, revocation_epoch AS e FROM identities").all().map(r => [r.id, r.e]));
const roleOf = (fx, user, area = "team-area") =>
  fx.db.prepare("SELECT role FROM area_members WHERE area_id=? AND user_id=?").get(area, user)?.role ?? null;
const preflight = fx => inspectIsolatedTargetStore({
  stagingDirectory: fx.stage.directory, expectedRestoreGeneration: generationOf(fx), mode: "r2-model" });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const worldHash = fx => sha(Buffer.concat([readFileSync(fx.databasePath), readFileSync(fx.journalPath),
  readFileSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"))]));

// ---- writers (the real pinned writers) ---------------------------------------------------------

const writableToken = fx => fx.authority.issueWritable("alice").sessionToken;
const titleWrite = (fx, taskId, title = SECRET_TITLE) => {
  const token = writableToken(fx);
  const preview = fx.authority.previewTaskTitleEdit(token, { taskId });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  return fx.authority.updateTaskTitle(token, { commandId: randomUUID(), taskId, title,
    expectedRevision: preview.snapshotRevision, ...writeFields(fx.db, taskId, fx.stage.restoreGeneration) });
};
const memberWrite = (fx, action, user, role, actor = "alice") => {
  const policy = fx.db.prepare("SELECT policy_revision AS r FROM areas WHERE id='team-area'").get().r;
  const result = fx.authority.applyMembershipCommand(fx.authority.issueWritable(actor).sessionToken, { commandId: randomUUID(),
    areaId: "team-area", expectedPolicyRevision: policy, writeAreaId: "team-area",
    restoreGeneration: fx.stage.restoreGeneration, action, targetUserId: user, ...(role ? { role } : {}) });
  assert.equal(result.ok, true, `${action} ${user}: ${JSON.stringify(result)}`);
  return result;
};
const issue = (fx, user, seconds = 600) => {
  const result = durable.issueDurableTargetStagingSession(fx.store, user, seconds);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const revokeAll = (fx, user) => {
  const result = durable.revokeAllDurableTargetStagingSessionsForUser(fx.store, user);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const revokeOne = (fx, session) => assert.equal(durable.revokeDurableTargetStagingSession(fx.store, session.sessionId).ok, true);

// ---- backup / copy-back / restore --------------------------------------------------------------

const backupOf = fx => {
  const file = path.join(root, `${fx.name}.backup-${++counter}.sqlite`);
  copyFileSync(fx.databasePath, file);
  return file;
};
const copyBack = (fx, backup) => copyFileSync(backup, fx.databasePath);
/** The tool, then what an operator does next: configure the printed generation. */
function restoreNow(fx, grants = []) {
  const result = restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: grants });
  if (result.ok) {
    fx.generations.push(result.restoreGeneration);
    useStore(fx, result.restoreGeneration);
  }
  return result;
}

// The note delete intent intentionally carries no note ID, so recovery cannot
// reapply a confirmed deletion to a backed-up live note. Only a backup from
// AFTER the deletion is safe to restore.
function deleteSharedNote(fx, noteId) {
  const token = writableToken(fx);
  const preview = noteWritePreflight.previewTargetNoteWrite(fx.db, "alice", noteId);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const { ok: _allowed, ...fields } = preview;
  return fx.authority.deleteNote(token, { ...fields, noteId, commandId: randomUUID() });
}

test("restore refuses a backup older than a confirmed note deletion without resurrecting the note", () => {
  const fx = makeFixture();
  fx.db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('sensitive',?,'Private','Sensitive text')")
    .run(fx.stage.unassignedAreaId);
  const backup = backupOf(fx);
  assert.deepEqual(deleteSharedNote(fx, "sensitive"), { ok: true });
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id='sensitive'").get().n, 0);
  assert.equal(preflight(fx).ok, true);
  assert.ok(journalLines(fx).some(row => row.t === "intent" && row.k === "note_delete"));
  copyBack(fx, backup);
  const before = worldHash(fx);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store),
    { ok: false, reason: "backup_predates_note_delete" });
  assert.equal(worldHash(fx), before, "refused restore does not change DB, journal or witness");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending",
    "resurrected snapshot is still inaccessible to the staging API");
});

test("restore accepts a backup after note deletion when only replayable events followed", () => {
  const fx = makeFixture();
  fx.db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('sensitive',?,'Private','Sensitive text')")
    .run(fx.stage.unassignedAreaId);
  assert.deepEqual(deleteSharedNote(fx, "sensitive"), { ok: true });
  const backup = backupOf(fx);
  assert.deepEqual(titleWrite(fx, "t1", "Post-deletion edit"), { ok: true });
  copyBack(fx, backup);
  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id='sensitive'").get().n, 0);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM note_tombstones WHERE id='sensitive'").get().n, 1);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM note_delete_audit WHERE note_id='sensitive'").get().n, 1);
  assert.equal(preflight(fx).ok, true);
});

// ---- HTTP helpers --------------------------------------------------------------------------------

const ownerCookie = () => `${sessionCookieName}=${createSessionToken()}`;
const sessionCookie = token => `${durable.TARGET_STAGING_SESSION_COOKIE}=${token}`;
const clientIp = () => `10.8.${Math.floor(++ip / 250)}.${ip % 250}`;
const taskCtx = { params: Promise.resolve({ taskId: "t1" }) };
const areaCtx = { params: Promise.resolve({ areaId: "team-area" }) };
const jsonBody = JSON.stringify({ commandId: "11111111-1111-4111-8111-111111111111", expectedRevision: "a".repeat(64), title: "x" });
const post = (url, cookie, body = jsonBody) => new Request(base + url, { method: "POST", body,
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
const AUTH = { error: "Authentication required" };
const expectBody = async (response, expected, label) => {
  assert.equal(response.status, 401, label);
  assert.equal(response.headers.get("cache-control"), "no-store", label);
  assert.deepEqual(await response.json(), expected, label);
};
const expectGate = async (response, code, label) => {
  assert.equal(response.status, 503, label);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "Staging unavailable", code }, label);
  assert.ok(!/Task t|team-area|tasks|alice|bob/.test(text.replace(/Staging unavailable/, "")), `${label}: no data`);
};
async function expectAllRoutesGated(code, label) {
  for (const [name, call] of Object.entries(routes)) {
    for (const [who, cookie] of [["owner", ownerCookie()], ["no credential", undefined]]) {
      await expectGate(await call(cookie), code, `${label}: ${name} (${who})`);
    }
  }
}
/** The token is refused with `code` on every target endpoint (the list/changes ones go through the read child). */
async function expectDeadEverywhere(token, code, label) {
  for (const [name, call] of Object.entries(routes)) {
    await expectBody(await call(sessionCookie(token)), { ...AUTH, code }, `${label}: ${name}`);
  }
}

// =====================================================================================================
// acceptance (roadmap R2c.4, scenario 4)
// =====================================================================================================

test("acceptance: backup before removing B, revoking C and revokeAll D; the restore brings none of it back", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "before backup").ok, true);
  const cBefore = issue(fx, "carol");
  const dPre = issue(fx, "dave");
  const aLive = issue(fx, "alice");
  const backup = backupOf(fx);
  const epochsAtBackup = epochs(fx);

  // After the backup: remove B (with its assigned task), revoke C's session, sign D out everywhere,
  // then D signs in again and A gets another session (both issued AFTER the recorded revokeAll).
  memberWrite(fx, "remove", "bob");
  revokeOne(fx, cBefore);
  revokeAll(fx, "dave");
  revokeAll(fx, "dave");
  const dPost = issue(fx, "dave");
  const aPost = issue(fx, "alice");
  assert.equal(titleWrite(fx, "t3", "content after backup").ok, true);
  const epochsBeforeRestore = epochs(fx);
  const generationBefore = generationOf(fx);
  assert.equal(epochsBeforeRestore.dave, 2);

  copyBack(fx, backup);
  assert.equal(roleOf(fx, "bob"), "editor", "the copy brought bob back");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  // Before the tool ran: reads and writes answer 503 restore_pending, no data, with every credential.
  await expectAllRoutesGated("restore_pending", "before the tool");
  for (const token of [cBefore, dPre, aLive, dPost, aPost]) {
    await expectGate(await routes["tasks list"](sessionCookie(token.sessionToken)), "restore_pending", "session cookie");
  }
  assert.equal(fx.authority.issueWritable("alice"), null, "no process-local writable session on an untrusted store");
  assert.deepEqual(durable.issueDurableTargetStagingSession(fx.store, "bob", 600), { ok: false, reason: "unavailable" });

  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.restoreGeneration, generationBefore);
  assert.equal(result.previousGeneration, generationBefore);
  assert.equal(generationOf(fx), result.restoreGeneration);
  assert.equal(result.replayedMembership, 1);
  assert.equal(result.epochsBumped, 4);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");

  // B has no membership and no role; the assigned task was unassigned like the live command does.
  assert.equal(roleOf(fx, "bob"), null);
  assert.equal(fx.db.prepare("SELECT assignee_user_id AS a FROM tasks WHERE id='t2'").get().a, null);
  assert.equal(roleOf(fx, "alice"), "admin");
  // Content after the backup is lost by definition.
  assert.equal(fx.db.prepare("SELECT title FROM tasks WHERE id='t3'").get().title, "Task t3");
  assert.equal(fx.db.prepare("SELECT title FROM tasks WHERE id='t1'").get().title, "before backup");
  // Epochs never go back: strictly above both the backup and everything the journal knew.
  const after = epochs(fx);
  for (const user of Object.keys(after)) {
    assert.ok(after[user] > epochsBeforeRestore[user], `${user}: ${after[user]} > ${epochsBeforeRestore[user]}`);
    assert.ok(after[user] > epochsAtBackup[user]);
  }
  assert.equal(after.dave, 3);

  // C: revoked in the irreversible source -> session_revoked (never the restore code).
  await expectDeadEverywhere(cBefore.sessionToken, "session_revoked", "C revoked after the backup");
  // D's pre-revokeAll session has a lower epoch than the source -> session_revoked.
  await expectDeadEverywhere(dPre.sessionToken, "session_revoked", "D before revokeAll");
  // Live under the source: issued before the backup and never revoked, or issued after it (even after the
  // recorded revokeAll) -> the restore code, so a client does not wipe its queue.
  await expectDeadEverywhere(aLive.sessionToken, "session_restored", "A live in the backup");
  await expectDeadEverywhere(dPost.sessionToken, "session_restored", "D after the recorded revokeAll");
  await expectDeadEverywhere(aPost.sessionToken, "session_restored", "A issued after the backup");
  // A random unknown token never gets the restore code; neither does a malformed one.
  await expectDeadEverywhere(randomBytes(32).toString("base64url"), "session_revoked", "unknown token");
  await expectBody(await routes["tasks list"](`${durable.TARGET_STAGING_SESSION_COOKIE}=not-a-token`),
    { ...AUTH, code: "session_revoked" }, "malformed cookie");
  // The owner cookie path is unchanged and a brand-new session works.
  assert.equal((await routes["tasks list"](ownerCookie())).status, 200);
  const fresh = issue(fx, "alice");
  assert.equal((await routes["tasks list"](sessionCookie(fresh.sessionToken))).status, 200);

  // The journal records the restore (content free), under the new generation, and nothing else changed.
  const lines = journalLines(fx);
  const restoreIntent = lines.find(line => line.t === "intent" && line.k === "restore");
  assert.equal(restoreIntent.g, result.restoreGeneration);
  assert.equal(restoreIntent.p.previousGeneration, generationBefore);
  assert.equal(restoreIntent.p.from, anchorAtBackupOf(backup));
  assert.equal(restoreIntent.p.superseded, 3);
  assert.deepEqual(restoreIntent.p.grantAdmin, []);
  assert.ok(!journalText(fx).includes(SECRET_TITLE));
  assert.equal(journalState(fx).pending, null);
});
test("a token issued after the backup (journal only) and then revoked by revokeAll is session_revoked, a later one session_restored", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  const early = issue(fx, "alice");   // journal-only after the backup, epoch below the later revokeAll
  revokeAll(fx, "alice");
  const late = issue(fx, "alice");    // journal-only, issued after the revokeAll: live under the source
  copyBack(fx, backup);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM staging_sessions").get().n, 0, "neither token is in the backup rows");
  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.supersededTokens, 1, "only the token which was live under the irreversible source is listed");
  await expectDeadEverywhere(early.sessionToken, "session_revoked", "journal-only token revoked by a later revokeAll");
  await expectDeadEverywhere(late.sessionToken, "session_restored", "journal-only token issued after the revokeAll");
});

function anchorAtBackupOf(file) {
  const raw = new DatabaseSync(file, { readOnly: true });
  try { return Number(raw.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value); } finally { raw.close(); }
}

test("a plain file copy without the tool is 503 even when nothing was revoked after the backup", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  copyBack(fx, backup);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  await expectAllRoutesGated("restore_pending", "plain copy");
});

test("removal, demotion and revocation committed right after the backup are applied; add and set_role are replayed too", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const carolSession = issue(fx, "carol");
  const backup = backupOf(fx);
  memberWrite(fx, "remove", "bob");
  memberWrite(fx, "set_role", "carol", "viewer");
  memberWrite(fx, "add", "dave", "editor");
  memberWrite(fx, "set_role", "dave", "viewer");
  revokeOne(fx, carolSession);
  copyBack(fx, backup);
  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.replayedMembership, 4);
  assert.equal(result.skipped, 0);
  assert.equal(roleOf(fx, "bob"), null);
  assert.equal(roleOf(fx, "carol"), "viewer");
  assert.equal(roleOf(fx, "dave"), "viewer");
  assert.equal(roleOf(fx, "alice"), "admin");
  assert.equal(durable.verifyDurableTargetStagingSessionLiveCoded(fx.store,
    durable.hashTargetStagingSessionToken(carolSession.sessionToken)).code, "session_revoked");
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
});

test("a skipped replay step never grants access: missing identity, missing member row", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  addIdentity(fx.db, "erin");                  // created AFTER the backup: absent from the restored DB
  memberWrite(fx, "add", "erin", "editor");    // skipped: no identity
  memberWrite(fx, "set_role", "erin", "admin"); // skipped: no identity
  memberWrite(fx, "remove", "bob");
  memberWrite(fx, "add", "bob", "viewer");     // bob re-added with a LOWER role
  memberWrite(fx, "remove", "carol");
  copyBack(fx, backup);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM identities WHERE id='erin'").get().n, 0);
  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.skipped, 2);
  assert.equal(roleOf(fx, "erin"), null);
  assert.equal(roleOf(fx, "bob"), "viewer");
  assert.equal(roleOf(fx, "carol"), null);
});

// =====================================================================================================
// last-admin invariant (d)
// =====================================================================================================

test("C promoted after the backup, then A demoted: C stays admin", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  memberWrite(fx, "set_role", "carol", "admin");
  memberWrite(fx, "set_role", "alice", "editor");
  copyBack(fx, backup);
  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(roleOf(fx, "carol"), "admin");
  assert.equal(roleOf(fx, "alice"), "editor");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM area_members WHERE area_id='team-area' AND role='admin'").get().n, 1);
  assert.equal(preflight(fx).ok, true);
});

test("a last-admin violation blocks the restore (store unchanged, still 503) until --grant-admin decides", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  addIdentity(fx.db, "erin");                   // exists only after the backup
  memberWrite(fx, "add", "erin", "admin");      // skipped by the restore: erin is unknown there
  memberWrite(fx, "set_role", "alice", "viewer"); // the replay would leave the Area without an admin
  copyBack(fx, backup);
  const before = worldHash(fx);

  const blocked = restoreLib.restoreTargetStagingFromBackup(fx.store);
  assert.deepEqual(blocked, { ok: false, reason: "last_admin", blockedAreas: ["team-area"] });
  assert.equal(worldHash(fx), before, "nothing changed");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  await expectAllRoutesGated("restore_pending", "after a refused restore");
  // A grant to an unknown identity or Area is a mistake of the operator, not a decision.
  for (const grant of [{ areaId: "team-area", userId: "nobody" }, { areaId: "no-area", userId: "bob" },
    { areaId: "bob-private", userId: "bob" }]) {
    assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: [grant] }),
      { ok: false, reason: "grant_invalid" });
    assert.equal(worldHash(fx), before);
  }

  const result = restoreNow(fx, [{ areaId: "team-area", userId: "bob" }]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.grantedAdmins, 1);
  assert.equal(roleOf(fx, "bob"), "admin");
  assert.equal(roleOf(fx, "alice"), "viewer", "the journaled demotion still applies");
  assert.equal(preflight(fx).ok, true);
  const record = journalLines(fx).find(line => line.k === "restore");
  assert.deepEqual(record.p.grantAdmin, [["team-area", "bob"]], "readable ID pairs, nothing else");
  assert.deepEqual(result.grantAdmin, [["team-area", "bob"]]);
  assert.equal("grantDigest" in record.p, false);
});

test("a grant for an Area which the last-admin invariant does not block is refused (grant_unneeded), nothing changes", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  memberWrite(fx, "remove", "bob");
  copyBack(fx, backup);
  const before = worldHash(fx);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: [{ areaId: "team-area", userId: "carol" }] }),
    { ok: false, reason: "grant_unneeded" });
  assert.equal(worldHash(fx), before, "dry evaluation left no trace");
  assert.equal(roleOf(fx, "bob"), "editor");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  // One needed and one unneeded grant: the whole restore is refused.
  const second = makeFixture();
  second.db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team2','shared','alice')").run();
  second.db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('other-area','Other','shared','team2','alice')").run();
  second.db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('other-area','alice','admin')").run();
  assert.equal(titleWrite(second, "t1", "x").ok, true);
  const secondBackup = backupOf(second);
  addIdentity(second.db, "erin");
  memberWrite(second, "add", "erin", "admin");
  memberWrite(second, "set_role", "alice", "viewer");
  copyBack(second, secondBackup);
  const secondBefore = worldHash(second);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(second.store, { grantAdmin: [
    { areaId: "team-area", userId: "bob" }, { areaId: "other-area", userId: "bob" }] }),
  { ok: false, reason: "grant_unneeded" });
  assert.equal(worldHash(second), secondBefore);
  // Two grants for the same blocked Area are fine; duplicates collapse; the pairs are sorted.
  const ok = restoreNow(second, [{ areaId: "team-area", userId: "carol" }, { areaId: "team-area", userId: "bob" },
    { areaId: "team-area", userId: "carol" }]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(ok.grantAdmin, [["team-area", "bob"], ["team-area", "carol"]]);
  assert.equal(ok.grantedAdmins, 2);
});

test("grant limits: more than 16 grants or an over-long list is invalid_request", () => {
  const fx = makeFixture();
  const many = Array.from({ length: 17 }, (_, i) => ({ areaId: `a${i}`, userId: "bob" }));
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: many }), { ok: false, reason: "invalid_request" });
  const long = Array.from({ length: 6 }, (_, i) => ({ areaId: `${"a".repeat(119)}${i}`, userId: "u".repeat(120) }));
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: long }), { ok: false, reason: "invalid_request" });
});

test("a grant never overrides the journal: a user removed or demoted after the backup refuses the restore (grant_removed_by_journal)", () => {
  for (const [name, change] of [["removed", fx => memberWrite(fx, "remove", "bob")],
    ["demoted", fx => memberWrite(fx, "set_role", "bob", "editor")]]) {
    const fx = makeFixture();
    assert.equal(titleWrite(fx, "t1", "x").ok, true);
    memberWrite(fx, "set_role", "bob", "admin");
    const backup = backupOf(fx);
    addIdentity(fx.db, "erin");
    memberWrite(fx, "add", "erin", "admin");   // skipped on restore: erin is unknown there
    change(fx);
    memberWrite(fx, "set_role", "alice", "viewer");
    copyBack(fx, backup);
    const before = worldHash(fx);
    const journalBefore = readFileSync(fx.journalPath);
    assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: [{ areaId: "team-area", userId: "bob" }] }),
      { ok: false, reason: "grant_removed_by_journal" }, name);
    assert.equal(worldHash(fx), before, `${name}: nothing changed`);
    assert.deepEqual(readFileSync(fx.journalPath), journalBefore, `${name}: journal bytes unchanged`);
    assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
    // A grant for another eligible user still works.
    const ok = restoreNow(fx, [{ areaId: "team-area", userId: "carol" }]);
    assert.equal(ok.ok, true, `${name}: ${JSON.stringify(ok)}`);
    assert.equal(roleOf(fx, "carol"), "admin");
  }
  // The LAST op decides: removed, then re-added as admin, is eligible.
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  memberWrite(fx, "remove", "bob");
  memberWrite(fx, "add", "bob", "admin");
  memberWrite(fx, "set_role", "alice", "viewer");
  copyBack(fx, backup);
  const ok = restoreNow(fx, []);
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("a grant is refused when the last journal op for the pair is an add with a non-admin role (grant_removed_by_journal)", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  addIdentity(fx.db, "erin");
  memberWrite(fx, "add", "erin", "admin");          // skipped on restore: erin is unknown there
  memberWrite(fx, "set_role", "alice", "viewer");   // blocks the Area without a grant
  memberWrite(fx, "remove", "bob", undefined, "erin");
  memberWrite(fx, "add", "bob", "editor", "erin");  // the LAST op for bob: add, non-admin
  copyBack(fx, backup);
  const before = worldHash(fx);
  const journalBefore = readFileSync(fx.journalPath);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: [{ areaId: "team-area", userId: "bob" }] }),
    { ok: false, reason: "grant_removed_by_journal" });
  assert.equal(worldHash(fx), before);
  assert.deepEqual(readFileSync(fx.journalPath), journalBefore);
});

test("restoreExitCode: 0 success, 1 refusal, 2 confirm_untrusted", () => {
  assert.equal(restoreLib.restoreExitCode({ ok: true }), 0);
  assert.equal(restoreLib.restoreExitCode({ ok: false, reason: "last_admin" }), 1);
  assert.equal(restoreLib.restoreExitCode({ ok: false, reason: "confirm_untrusted" }), 2);
});

test("the largest accepted grant list (16 pairs of long IDs within the limit) still fits one journal line", () => {
  const pairs = Array.from({ length: 5 }, (_, i) => [`${"a".repeat(100)}${i}`, "u".repeat(100)]);
  assert.ok(JSON.stringify(pairs).length <= 1200);
  const line = journalLib.serializeTargetStagingJournalLine({ n: 2, t: "intent", k: "restore", g: G1, prev: "0".repeat(64),
    p: { from: 0, through: 1, previousGeneration: G0, superseded: 16384, skipped: 999999, grantAdmin: pairs, seq: [1, 2] } });
  assert.ok(Buffer.byteLength(line.text) <= 2048);
});

test("an operator grant holds through the replay when the journal demotes and later re-promotes the user", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  addIdentity(fx.db, "erin");
  memberWrite(fx, "add", "erin", "admin");          // skipped by the restore: erin does not exist in the backup
  memberWrite(fx, "set_role", "alice", "viewer");   // blocked without a grant
  memberWrite(fx, "set_role", "carol", "admin", "erin");
  memberWrite(fx, "set_role", "bob", "viewer", "erin"); // an intermediate demotion; the LAST op for bob is admin
  memberWrite(fx, "set_role", "bob", "admin", "erin");
  copyBack(fx, backup);
  const result = restoreNow(fx, [{ areaId: "team-area", userId: "bob" }]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(roleOf(fx, "bob"), "admin", "the grant holds after the replay");
  assert.equal(roleOf(fx, "carol"), "admin");
  assert.equal(roleOf(fx, "alice"), "viewer");
});

test("a grant does not re-add a user whom the journal removed (grant_removed_by_journal, nothing changes)", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  addIdentity(fx.db, "erin");
  memberWrite(fx, "add", "erin", "admin");
  memberWrite(fx, "set_role", "alice", "viewer");
  memberWrite(fx, "set_role", "carol", "admin", "erin");
  memberWrite(fx, "remove", "bob", undefined, "erin");
  copyBack(fx, backup);
  const before = worldHash(fx);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: [{ areaId: "team-area", userId: "bob" }] }),
    { ok: false, reason: "grant_removed_by_journal" });
  assert.equal(worldHash(fx), before);
});

// =====================================================================================================
// untrusted sources
// =====================================================================================================

const tampers = {
  "missing journal": fx => unlinkSync(fx.journalPath),
  "garbage line appended": fx => appendFileSync(fx.journalPath, "not json\n"),
  "a line edited": fx => {
    const text = journalText(fx);
    writeFileSync(fx.journalPath, text.replace(/"role":"editor"/, '"role":"admin"'), { mode: 0o600 });
    assert.notEqual(journalText(fx), text);
  },
  "missing witness": fx => unlinkSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite")),
  "witness row edited": fx => {
    const witness = new DatabaseSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"));
    try {
      witness.exec("DROP TRIGGER commits_immutable_update");
      witness.prepare("UPDATE commits SET journal_hash=? WHERE n=1").run("f".repeat(64));
    } finally { witness.close(); }
  },
  "witness generation edited": fx => {
    const witness = new DatabaseSync(path.join(fx.stage.directory, "lumi-target-witness.sqlite"));
    try {
      witness.exec("DROP TRIGGER commits_immutable_update");
      witness.prepare("UPDATE commits SET generation=? WHERE n=1").run(randomUUID());
    } finally { witness.close(); }
  },
};
for (const [label, tamper] of Object.entries(tampers)) {
  test(`${label}: the tool refuses and the store stays blocked`, async () => {
    const fx = makeFixture();
    assert.equal(titleWrite(fx, "t1", "x").ok, true);
    memberWrite(fx, "set_role", "carol", "editor");
    const backup = backupOf(fx);
    memberWrite(fx, "remove", "bob");
    copyBack(fx, backup);
    tamper(fx);
    // Edits of EARLIER lines/rows are only caught by a process without verified prefixes (a restart).
    journalLib.clearTargetStagingJournalCache();
    witnessLib.clearTargetStagingWitnessCache();
    const dbBefore = readFileSync(fx.databasePath);
    const journalBefore = existsSync(fx.journalPath) ? journalText(fx) : null;
    const gate = durable.checkTargetStagingAnchorLive(fx.store);
    assert.ok(gate === "journal_invalid" || gate === "unavailable", gate);
    assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "unavailable" });
    assert.deepEqual(readFileSync(fx.databasePath), dbBefore, "database untouched");
    assert.equal(existsSync(fx.journalPath) ? journalText(fx) : null, journalBefore, "journal untouched");
    assert.equal((await routes["tasks list"](ownerCookie())).status, 503);
  });
}

test("the tool restores only a restore_pending store: a healthy store and a journal_invalid one refuse", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const healthy = worldHash(fx);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "unavailable" });
  assert.equal(worldHash(fx), healthy);
  // Anchor ABOVE the journal is journal_invalid, not restore_pending.
  fx.db.prepare("UPDATE metadata SET value='99' WHERE key='anchor_seq'").run();
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "unavailable" });
});

test("a wrong configured generation refuses; a backup of another store refuses", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "y").ok, true);
  const other = makeFixture();
  assert.equal(titleWrite(other, "t1", "z").ok, true);
  copyBack(fx, backup);
  const wrong = { stagingDirectory: fx.stage.directory, expectedRestoreGeneration: randomUUID() };
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(wrong), { ok: false, reason: "generation_mismatch" });
  // The backup of ANOTHER store (another restore_generation) is not this journal's state at its anchor.
  const otherBackup = backupOf(other);
  copyBack(fx, otherBackup);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "backup_provenance" });
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "unavailable");
});

test("a backup of another schema version is refused with its own reason, nothing changes", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "y").ok, true);
  copyBack(fx, backup);
  fx.db.prepare("UPDATE metadata SET value=? WHERE key='schema_version'").run(String(TARGET_STORE_SCHEMA_VERSION - 1));
  const before = worldHash(fx);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "unsupported_backup" });
  assert.equal(worldHash(fx), before);
  fx.db.prepare("UPDATE metadata SET value=? WHERE key='schema_version'").run(String(TARGET_STORE_SCHEMA_VERSION));
  assert.equal(restoreLib.restoreTargetStagingFromBackup(fx.store).ok, true);
});

test("a backup whose anchor names an intent which never committed (aborted) is refused (provenance)", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  const killed = await new Promise(resolve => {
    const child = spawn(REAL_NODE, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
      "tests/support/target-anchor-gated-child.mjs", fx.stage.directory, fx.stage.restoreGeneration,
      "crash-before-commit", ""], { stdio: "ignore" });
    child.on("close", (code, signal) => resolve(signal));
  });
  assert.equal(killed, "SIGKILL");
  const raw = new DatabaseSync(fx.databasePath);
  raw.prepare("SELECT COUNT(*) FROM metadata").get();
  raw.close();
  if (existsSync(fx.databasePath + "-journal")) unlinkSync(fx.databasePath + "-journal");
  assert.equal(titleWrite(fx, "t2", "later").ok, true); // aborts the killed intent 2, commits 3
  assert.equal(titleWrite(fx, "t3", "later").ok, true);
  const aborted = journalLines(fx).find(line => line.t === "abort").n;
  copyBack(fx, backup);
  fx.db.prepare("UPDATE metadata SET value=? WHERE key='anchor_seq'").run(String(aborted));
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  const before = worldHash(fx);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "backup_provenance" });
  assert.equal(worldHash(fx), before);
});

// =====================================================================================================
// the new generation (e)
// =====================================================================================================

// ---- the restore's own post-COMMIT confirm uses the writer's trust rule ----------------------------

/**
 * A restore_pending store plus older copies of the main DB (the backup), the witness and the journal.
 * `swap` runs once right after the restore's COMMIT (test-local exec hook, restored in finally), before
 * its confirm; the journal bytes at that moment are returned.
 */
function restoreWithSwapAfterCommit(swap) {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const witnessPath = path.join(fx.stage.directory, "lumi-target-witness.sqlite");
  const old = { db: backupOf(fx), witness: path.join(root, `${fx.name}.w-old`), journal: path.join(root, `${fx.name}.j-old`) };
  copyFileSync(witnessPath, old.witness);
  copyFileSync(fx.journalPath, old.journal);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  copyBack(fx, old.db);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  const origExec = DatabaseSync.prototype.exec;
  let armed = true;
  let afterCommit = null;
  DatabaseSync.prototype.exec = function (sql) {
    const result = origExec.call(this, sql);
    if (armed && sql === "COMMIT") {
      armed = false;
      afterCommit = readFileSync(fx.journalPath);
      swap(fx, old, witnessPath);
    }
    return result;
  };
  let result;
  try { result = restoreLib.restoreTargetStagingFromBackup(fx.store); } finally { DatabaseSync.prototype.exec = origExec; }
  assert.ok(afterCommit, "the hook ran after the restore COMMIT");
  const lines = afterCommit.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  assert.deepEqual([lines.at(-1).t, lines.at(-1).k], ["intent", "restore"], "the restore intent is the tail");
  const newStore = { stagingDirectory: fx.stage.directory, expectedRestoreGeneration: lines.at(-1).g };
  return { fx, result, afterCommit, newStore };
}
function assertNoConfirmAndFailClosed({ fx, result, afterCommit, newStore }) {
  assert.deepEqual(result, { ok: false, reason: "confirm_untrusted", restoreGeneration: newStore.expectedRestoreGeneration,
    previousGeneration: fx.stage.restoreGeneration }, "the tool must not report ok, but names the committed generation");
  assert.deepEqual(readFileSync(fx.journalPath), afterCommit, "no confirm appended, journal bytes as right after COMMIT");
  for (const store of [fx.store, newStore]) {
    assert.notEqual(durable.checkTargetStagingAnchorLive(store), "ok", "store fails closed");
  }
  assert.equal(fx.authority.issueWritable("alice"), null, "no writer is admitted");
  assert.deepEqual(readFileSync(fx.journalPath), afterCommit, "refused writers and live checks leave the journal untouched");
}
const atomicReplace = (target, source, mode = null) => {
  const temp = `${target}.swap`;
  copyFileSync(source, temp);
  if (mode !== null) chmodSync(temp, mode);
  renameSync(temp, target);
};

test("restore: older main DB renamed over the canonical path between COMMIT and confirm: no confirm, not ok, fails closed", () => {
  assertNoConfirmAndFailClosed(restoreWithSwapAfterCommit((fx, old) => atomicReplace(fx.databasePath, old.db)));
});

test("restore: older witness renamed over the canonical path between COMMIT and confirm: no confirm, not ok, fails closed", () => {
  assertNoConfirmAndFailClosed(restoreWithSwapAfterCommit((fx, old, witnessPath) => atomicReplace(witnessPath, old.witness, 0o600)));
});

test("restore: older journal renamed over the canonical path between COMMIT and confirm: no confirm into the orphan, not ok", () => {
  const run = restoreWithSwapAfterCommit((fx, old) => atomicReplace(fx.journalPath, old.journal, 0o600));
  assert.deepEqual(run.result, { ok: false, reason: "confirm_untrusted", restoreGeneration: run.newStore.expectedRestoreGeneration,
    previousGeneration: run.fx.stage.restoreGeneration });
  // The replacement journal is untouched (the orphan inode got nothing either: it is unlinked).
  assert.deepEqual(readFileSync(run.fx.journalPath), readFileSync(path.join(root, `${run.fx.name}.j-old`)));
  assert.notEqual(durable.checkTargetStagingAnchorLive(run.fx.store), "ok");
  assert.notEqual(durable.checkTargetStagingAnchorLive(run.newStore), "ok");
});

test("restore: main DB rolled back to the backup IN PLACE after the COMMIT: no confirm, not ok, fails closed", () => {
  assertNoConfirmAndFailClosed(restoreWithSwapAfterCommit((fx, old) => copyFileSync(old.db, fx.databasePath)));
});

test("restore: witness copied back IN PLACE after the COMMIT: no confirm, not ok, fails closed", () => {
  assertNoConfirmAndFailClosed(restoreWithSwapAfterCommit((fx, old, witnessPath) => copyFileSync(old.witness, witnessPath)));
});

test("restore: confirm_untrusted after a benign swap (identical bytes renamed in): the new generation is reported, the gate accepts it, the next writer appends the confirm", () => {
  const run = restoreWithSwapAfterCommit((fx) => {
    const copy = `${fx.databasePath}.same`;
    copyFileSync(fx.databasePath, copy);
    renameSync(copy, fx.databasePath);
  });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.reason, "confirm_untrusted");
  assert.equal(run.result.restoreGeneration, run.newStore.expectedRestoreGeneration);
  assert.equal(run.result.previousGeneration, run.fx.stage.restoreGeneration);
  assert.deepEqual(readFileSync(run.fx.journalPath), run.afterCommit, "no confirm yet");
  // The operator inspected the directory (nothing hostile) and sets the printed generation.
  assert.notEqual(durable.checkTargetStagingAnchorLive(run.fx.store), "ok", "the old generation stays closed");
  assert.equal(durable.checkTargetStagingAnchorLive(run.newStore), "ok", "the gate verifies the store under the new generation");
  useStore(run.fx, run.result.restoreGeneration);
  assert.equal(titleWrite(run.fx, "t1", "after").ok, true, "the first writer is admitted");
  const lines = journalLines(run.fx);
  const restoreN = lines.find(line => line.t === "intent" && line.k === "restore").n;
  assert.equal(lines.some(line => line.t === "confirm" && line.n === restoreN && line.g === run.result.restoreGeneration), true,
    "the writer appended the missing confirm of the restore intent");
});

test("restore: an untouched run still confirms under the new generation and reports ok (control)", () => {
  const { result, fx } = restoreWithSwapAfterCommit(() => {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(journalLines(fx).at(-1).t, "confirm");
});

test("after the restore an old offline command, an old cursor and an old CAS token are refused", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const oldGeneration = fx.stage.restoreGeneration;
  // What a client synchronised to the old generation holds.
  const oldSession = issue(fx, "alice");
  let state = await (await routes.changes(sessionCookie(oldSession.sessionToken))).json();
  while (state.phase === "bootstrap" && state.more) {
    state = await (await FEED(get(`changes?cursor=${state.cursor}`, sessionCookie(oldSession.sessionToken)))).json();
  }
  const oldCursor = state.cursor;
  const oldToken = writePreflight.targetTaskTitleEditRevision(fx.db, "t1");
  const oldPolicy = fx.db.prepare("SELECT policy_revision AS r FROM areas WHERE id='team-area'").get().r;
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "after backup").ok, true);
  memberWrite(fx, "set_role", "carol", "viewer");
  copyBack(fx, backup);
  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const writer = issue(fx, "alice");
  const cookie = sessionCookie(writer.sessionToken);
  const RESYNC = { error: "Resync required", code: "resync_required" };

  // A cursor of the old generation: resync_required, never data (also after the change-log sequence was reused).
  assert.equal(titleWrite(fx, "t3", "reuses a sequence number of the lost future").ok, true);
  const staleFeed = await FEED(get(`changes?cursor=${oldCursor}`, cookie));
  assert.equal(staleFeed.status, 409);
  assert.deepEqual(await staleFeed.json(), { code: "resync_required" });
  // ... while a bootstrap of the new generation works and carries the new value.
  const fresh = await (await routes.changes(cookie)).json();
  assert.equal(fresh.restoreGeneration, result.restoreGeneration);
  // An old offline title command and membership command: resync_required, nothing written.
  const before = worldHash(fx);
  const titleBody = (generation, revision) => JSON.stringify({ commandId: randomUUID(), expectedRevision: revision,
    title: "offline edit", writeAreaId: "team-area", restoreGeneration: generation });
  const oldTitle = await TITLE_PATCH(new Request(base + "tasks/t1/title", { method: "PATCH",
    body: titleBody(oldGeneration, oldToken), headers: { "content-type": "application/json",
      origin: "http://localhost:3001", ...PROTOCOL, cookie, "x-forwarded-for": clientIp() } }), taskCtx);
  assert.equal(oldTitle.status, 409);
  assert.deepEqual(await oldTitle.json(), RESYNC);
  const oldDelete = await DELETE_TASK(post("tasks/t1/delete", cookie, JSON.stringify({ commandId: randomUUID(),
    expectedRevision: oldToken, writeAreaId: "team-area", restoreGeneration: oldGeneration })), taskCtx);
  assert.equal(oldDelete.status, 409);
  assert.deepEqual(await oldDelete.json(), RESYNC);
  const oldMember = await MEMBERS(post("areas/team-area/members", cookie, JSON.stringify({ commandId: randomUUID(),
    expectedPolicyRevision: oldPolicy, action: "remove", targetUserId: "bob", writeAreaId: "team-area",
    restoreGeneration: oldGeneration })), areaCtx);
  assert.equal(oldMember.status, 409);
  assert.deepEqual(await oldMember.json(), RESYNC);
  assert.equal(roleOf(fx, "bob"), "editor");
  assert.equal(worldHash(fx), before, "no refused command wrote anything");

  // The old CAS token no longer matches although the task row itself is back at the very same revision.
  const newToken = writePreflight.targetTaskTitleEditRevision(fx.db, "t1");
  assert.notEqual(newToken, oldToken);
  const writeWithOldToken = fx.authority.updateTaskTitle(writableToken(fx), { commandId: randomUUID(), taskId: "t1",
    title: "stale", expectedRevision: oldToken, ...writeFields(fx.db, "t1", fx.stage.restoreGeneration) });
  assert.equal(writeWithOldToken.ok, false);
  assert.notEqual(writeWithOldToken.reason, "resync_required");
  assert.equal(fx.db.prepare("SELECT title FROM tasks WHERE id='t1'").get().title, "x");
  // A command with the NEW generation and the NEW token is accepted.
  const accepted = fx.authority.updateTaskTitle(writableToken(fx), { commandId: randomUUID(), taskId: "t1",
    title: "after restore", expectedRevision: newToken, ...writeFields(fx.db, "t1", fx.stage.restoreGeneration) });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
});

test("a cursor sealed for the old generation and a matching claim set are refused as resync_required (library level)", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const session = issue(fx, "alice");
  const first = await (await routes.changes(sessionCookie(session.sessionToken))).json();
  const claims = feedCursor.openStagingFeedCursor(SECRET, first.cursor).claims;
  assert.equal(claims.gen, fx.stage.restoreGeneration);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "y").ok, true);
  copyBack(fx, backup);
  const result = restoreNow(fx);
  assert.equal(result.ok, true);
  const cookie = sessionCookie(issue(fx, "alice").sessionToken);
  const forged = feedCursor.sealStagingFeedCursor(SECRET, { ...claims, gen: claims.gen, uid: "alice",
    epoch: epochs(fx).alice });
  const response = await FEED(get(`changes?cursor=${forged}`, cookie));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: "resync_required" });
});

test("a second restore from a backup older than the first is refused; a backup taken after it works (two-step history)", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "gen0").ok, true);
  const gen0 = fx.stage.restoreGeneration;
  const backup0 = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "after backup 0").ok, true);
  copyBack(fx, backup0);
  const first = restoreNow(fx);
  assert.equal(first.ok, true, JSON.stringify(first));
  const gen1 = first.restoreGeneration;
  // Work under the new generation, a backup, then more security-relevant work.
  assert.equal(titleWrite(fx, "t1", "gen1").ok, true);
  const backup1 = backupOf(fx);
  memberWrite(fx, "remove", "carol");
  assert.equal(titleWrite(fx, "t3", "gen1 later").ok, true);

  // The old backup again: its replay window crosses the first restore.
  copyBack(fx, backup0);
  // The backup carries the OLD generation, the configuration the new one: fail closed (503, no code).
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "unavailable");
  assert.equal((await routes["tasks list"](ownerCookie())).status, 503);
  const before = worldHash(fx);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "backup_predates_restore" });
  assert.equal(worldHash(fx), before);
  assert.equal(generationOf(fx), gen0, "the refused tool changed nothing");

  // A backup taken AFTER the first restore is a valid source of a second one.
  copyBack(fx, backup1);
  const second = restoreNow(fx);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.restoreGeneration, gen1);
  assert.equal(second.previousGeneration, gen1);
  assert.equal(roleOf(fx, "carol"), null, "the removal after backup1 is replayed");
  const history = fx.db.prepare("SELECT generation, previous_generation FROM restore_generations ORDER BY journal_n").all();
  assert.deepEqual(history.map(row => [row.previous_generation, row.generation]), [[gen0, gen1], [gen1, second.restoreGeneration]]);
  // Audit rows written under gen0 and gen1 stay valid; the chain of the journal is intact.
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  journalLib.clearTargetStagingJournalCache();
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  const generationsInJournal = journalLines(fx).filter(line => line.k === "restore").map(line => line.g);
  assert.deepEqual(generationsInJournal, [gen1, second.restoreGeneration]);
  // Sessions of the first restore stay superseded for their own generation.
  assert.ok(fx.db.prepare("SELECT COUNT(*) AS n FROM restore_generations").get().n === 2);
});

test("a stale configuration after a restore fails closed: the old generation does not match the store", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const oldStore = fx.store;
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "y").ok, true);
  copyBack(fx, backup);
  const result = restoreNow(fx);
  assert.equal(result.ok, true);
  // The server was started again with the OLD generation (the operator skipped step 4).
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = oldStore.expectedRestoreGeneration;
  assert.equal(durable.checkTargetStagingAnchorLive(oldStore), "unavailable");
  assert.equal((await routes["tasks list"](ownerCookie())).status, 503);
  assert.deepEqual(durable.issueDurableTargetStagingSession(oldStore, "alice", 600), { ok: false, reason: "unavailable" });
  activate(fx);
  assert.equal((await routes["tasks list"](ownerCookie())).status, 200);
});

// =====================================================================================================
// failures and crashes
// =====================================================================================================

test("--generation: malformed is invalid_request; well-formed but not this store's is generation_mismatch only for this store's own journal", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "y").ok, true);
  copyBack(fx, backup);
  const before = worldHash(fx);
  for (const bad of ["not-a-uuid", "", "00000000-0000-0000-0000-000000000000", 7, undefined, null]) {
    assert.deepEqual(restoreLib.restoreTargetStagingFromBackup({ stagingDirectory: fx.stage.directory, expectedRestoreGeneration: bad }),
      { ok: false, reason: "invalid_request" }, String(bad));
  }
  // Well-formed, wrong: the reply carries nothing beyond the reason.
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup({ stagingDirectory: fx.stage.directory, expectedRestoreGeneration: randomUUID() }),
    { ok: false, reason: "generation_mismatch" });
  assert.equal(worldHash(fx), before);
  // A store which is not otherwise recognised stays `unavailable`: a tampered journal, a missing journal,
  // a backup of another store, another directory.
  const wrong = { stagingDirectory: fx.stage.directory, expectedRestoreGeneration: randomUUID() };
  const other = makeFixture();
  assert.equal(titleWrite(other, "t1", "z").ok, true);
  const otherBackup = backupOf(other);
  copyBack(fx, otherBackup);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(wrong), { ok: false, reason: "unavailable" }, "backup of another store");
  copyBack(fx, backup);
  const journalBytes = readFileSync(fx.journalPath);
  appendFileSync(fx.journalPath, "not json\n");
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(wrong), { ok: false, reason: "unavailable" }, "tampered journal");
  writeFileSync(fx.journalPath, journalBytes, { mode: 0o600 });
  unlinkSync(fx.journalPath);
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(wrong), { ok: false, reason: "unavailable" }, "missing journal");
  writeFileSync(fx.journalPath, journalBytes, { mode: 0o600 });
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup({ stagingDirectory: path.join(root, "nope"), expectedRestoreGeneration: randomUUID() }),
    { ok: false, reason: "unavailable" }, "no store");
  // The right generation still restores.
  assert.equal(restoreNow(fx).ok, true);
});

/** Make a table of a backup FILE genuinely full (the preflight checks the trigger DDL, so no shortcut). */
function fillBackup(file, table) {
  const raw = new DatabaseSync(file);
  try {
    const current = raw.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value;
    raw.exec("BEGIN");
    if (table === "restore_generations") {
      // One chain of 256 rows which ends at the current generation.
      let next = current;
      for (let i = 0; i < TARGET_STAGING_RESTORE_HISTORY_MAX; i++) {
        const before = randomUUID();
        raw.prepare("INSERT INTO restore_generations VALUES (?,?,?,?)").run(next, before, 1, Date.now());
        next = before;
      }
    } else {
      raw.prepare("INSERT INTO restore_generations VALUES (?,?,?,?)").run(current, randomUUID(), 1, Date.now());
      const insert = raw.prepare("INSERT INTO restore_superseded_sessions VALUES (?,?,?)");
      for (let i = 0; i < TARGET_STAGING_SUPERSEDED_SESSIONS_MAX; i++) insert.run(randomBytes(32).toString("hex"), "alice", current);
    }
    raw.exec("COMMIT");
  } finally { raw.close(); }
}
for (const table of ["restore_generations", "restore_superseded_sessions"]) {
  test(`${table} full: capacity_exhausted (not write_failed), nothing changes, the store stays restore_pending`, () => {
    const fx = makeFixture();
    assert.equal(titleWrite(fx, "t1", "x").ok, true);
    issue(fx, "carol");                       // live under the source: superseded needs a row
    const backup = backupOf(fx);
    memberWrite(fx, "remove", "bob");
    fillBackup(backup, table);
    copyBack(fx, backup);
    const before = worldHash(fx);
    assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "capacity_exhausted" });
    assert.equal(worldHash(fx), before);
    assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  });
}

function runRestoreChild(fx, mode) {
  const child = spawn(REAL_NODE, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
    "tests/support/target-restore-gated-child.mjs", fx.stage.directory, fx.stage.restoreGeneration, mode],
  { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  return new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, stdout })));
}
const stalePending = () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const session = issue(fx, "carol");
  const backup = backupOf(fx);
  memberWrite(fx, "remove", "bob");
  revokeOne(fx, session);
  copyBack(fx, backup);
  return { fx, session };
};

test("a failure before COMMIT leaves the store unchanged and 503; the rerun succeeds", async () => {
  const { fx, session } = stalePending();
  const dbBefore = readFileSync(fx.databasePath);
  const generation = generationOf(fx);
  const failed = await runRestoreChild(fx, "throw-before-commit");
  assert.equal(failed.code, 0);
  assert.deepEqual(JSON.parse(failed.stdout), { ok: false, reason: "write_failed" });
  assert.deepEqual(readFileSync(fx.databasePath), dbBefore, "database untouched");
  assert.equal(existsSync(fx.databasePath + "-journal"), false);
  assert.equal(generationOf(fx), generation);
  assert.equal(roleOf(fx, "bob"), "editor");
  // The journal holds the unfinished restore intent, nothing is committed: still restore_pending.
  const tail = journalLines(fx).slice(-1)[0];
  assert.deepEqual([tail.t, tail.k], ["intent", "restore"]);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  await expectAllRoutesGated("restore_pending", "after a failed restore");
  assert.equal(journalState(fx) === null, false);

  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const kinds = journalLines(fx).slice(-4).map(line => [line.t, line.k]);
  assert.deepEqual(kinds, [["intent", "restore"], ["abort", null], ["intent", "restore"], ["confirm", null]]);
  assert.equal(roleOf(fx, "bob"), null);
  assert.equal(durable.verifyDurableTargetStagingSessionLiveCoded(fx.store,
    durable.hashTargetStagingSessionToken(session.sessionToken)).code, "session_revoked");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  journalLib.clearTargetStagingJournalCache();
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("a kill after the restore intent (before COMMIT) leaves the store blocked; after the runbook the rerun succeeds", async () => {
  const { fx } = stalePending();
  const dbBefore = readFileSync(fx.databasePath);
  const killed = await runRestoreChild(fx, "crash-before-commit");
  assert.equal(killed.signal, "SIGKILL");
  assert.deepEqual(readFileSync(fx.databasePath), dbBefore, "database untouched");
  // Same runbook as a killed writer (R2c.4a): a zero-header rollback journal is moved aside.
  const sidecar = fx.databasePath + "-journal";
  if (existsSync(sidecar)) {
    assert.deepEqual([...readFileSync(sidecar).subarray(0, 8)], [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "unavailable" });
    unlinkSync(sidecar);
  }
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(roleOf(fx, "bob"), null);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("a kill after COMMIT before the restore confirm: the new generation is in the DB; the next writer confirms it", async () => {
  const { fx } = stalePending();
  const killed = await runRestoreChild(fx, "crash-before-confirm");
  assert.equal(killed.signal, "SIGKILL");
  const newGeneration = generationOf(fx);
  assert.notEqual(newGeneration, fx.stage.restoreGeneration);
  assert.equal(roleOf(fx, "bob"), null, "committed");
  const tail = journalLines(fx).slice(-1)[0];
  assert.deepEqual([tail.t, tail.k, tail.g], ["intent", "restore", newGeneration]);
  // The old configuration (the operator lost the tool output) does not match; the new one (read from the DB) does.
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "unavailable");
  const oldStore = fx.store;
  useStore(fx, newGeneration);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  assert.equal((await routes["tasks list"](ownerCookie())).status, 200);
  // A second restore attempt while the first one's confirm is missing refuses.
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(fx.store), { ok: false, reason: "unavailable" });
  assert.deepEqual(restoreLib.restoreTargetStagingFromBackup(oldStore), { ok: false, reason: "unavailable" });
  // The next ordinary writer resolves the tail with the NEW generation.
  assert.equal(titleWrite(fx, "t1", "after crash").ok, true);
  const lines = journalLines(fx).slice(-4);
  assert.deepEqual(lines.map(line => [line.t, line.k, line.g]), [
    ["intent", "restore", newGeneration], ["confirm", null, newGeneration],
    ["intent", "title", newGeneration], ["confirm", null, newGeneration]]);
  assert.equal(journalState(fx).generation, newGeneration);
  journalLib.clearTargetStagingJournalCache();
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("a restore after a lost confirm: the witness (not the stale anchor) decides, the committed intent is confirmed and replayed", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  const issued = issue(fx, "carol");
  // A revocation which COMMITS but whose JSONL confirm is lost (SIGKILL between COMMIT and confirm).
  const killed = await new Promise(resolve => {
    const child = spawn(REAL_NODE, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
      "tests/support/target-anchor-gated-child.mjs", fx.stage.directory, fx.stage.restoreGeneration,
      "crash-before-confirm-revoke", issued.sessionId], { stdio: "ignore" });
    child.on("close", (code, signal) => resolve(signal));
  });
  assert.equal(killed, "SIGKILL");
  const crashedN = journalState(fx).pending;
  assert.ok(crashedN > anchorAtBackupOf(backup));
  copyBack(fx, backup);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "restore_pending");
  const result = restoreNow(fx);
  assert.equal(result.ok, true, JSON.stringify(result));
  const lines = journalLines(fx);
  const resolution = lines.find(line => line.n === crashedN && line.t !== "intent");
  assert.equal(resolution.t, "confirm", "committed, so confirmed (an abort would contradict the witness)");
  // The lost-confirm revocation is part of the replay: the session stays revoked, never `restored`.
  assert.equal(durable.verifyDurableTargetStagingSessionLiveCoded(fx.store,
    durable.hashTargetStagingSessionToken(issued.sessionToken)).code, "session_revoked");
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  journalLib.clearTargetStagingJournalCache();
  witnessLib.clearTargetStagingWitnessCache();
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

// =====================================================================================================
// journal verifier: the generation changes only at a restore intent
// =====================================================================================================

function chainOf(steps) {
  let prev = "0".repeat(64);
  let text = "";
  for (const step of steps) {
    const line = journalLib.serializeTargetStagingJournalLine({ ...step, prev });
    text += line.text;
    prev = line.hash;
  }
  return text;
}
const G0 = randomUUID();
const G1 = randomUUID();
const G2 = randomUUID();
const genesis = { n: 0, t: "genesis", k: null, p: null, g: G0 };
const title = (n, g) => ({ n, t: "intent", k: "title", p: { seq: [n, n] }, g });
const resolve = (n, t, g) => ({ n, t, k: null, p: null, g });
const restoreRecord = (n, g, p = {}) => ({ n, t: "intent", k: "restore",
  p: { from: 0, through: 1, previousGeneration: G0, superseded: 0, skipped: 0, grantAdmin: [], ...p }, g });

test("verifier: a restore intent is the only place the generation changes; resolutions carry the new generation", () => {
  const good = [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "confirm", G1),
    title(3, G1), resolve(3, "confirm", G1)];
  const state = journalLib.verifyTargetStagingJournal(chainOf(good), G1);
  assert.equal(state.generation, G1);
  assert.equal(state.confirmed, 3);
  assert.equal(journalLib.verifyTargetStagingJournal(chainOf(good), G0), null, "the old generation is not the one in effect");
  // A pending restore: both generations are acceptable configurations, the one in effect stays the old one.
  const pending = chainOf([genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1)]);
  assert.equal(journalLib.verifyTargetStagingJournal(pending, G0).generation, G0);
  assert.equal(journalLib.verifyTargetStagingJournal(pending, G0).pendingRestore.to, G1);
  assert.equal(journalLib.verifyTargetStagingJournal(pending, G1).pendingRestore.to, G1);
  assert.equal(journalLib.verifyTargetStagingJournal(pending, G2), null);
  // After an abort the records revert to the previous generation; the abort itself carries the new one.
  const aborted = [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "abort", G1),
    title(3, G0), resolve(3, "confirm", G0)];
  assert.equal(journalLib.verifyTargetStagingJournal(chainOf(aborted), G0).generation, G0);
  assert.equal(journalLib.verifyTargetStagingJournal(chainOf(aborted), G1), null);
  // ... and the aborted generation cannot be introduced again.
  const reused = [...aborted, restoreRecord(4, G1, { through: 3, from: 1 }), resolve(4, "confirm", G1)];
  assert.equal(journalLib.verifyTargetStagingJournal(chainOf(reused), G1), null, "a generation is never reused");
});

const invalidChains = {
  "generation changes at an ordinary intent": [genesis, title(1, G1)],
  "generation changes at a confirm": [genesis, title(1, G0), resolve(1, "confirm", G1)],
  "restore names another previousGeneration": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { previousGeneration: G2 })],
  "restore keeps the generation": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G0)],
  "restore confirm carries the old generation": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "confirm", G0)],
  "record after the confirm uses the old generation": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "confirm", G1), title(3, G0)],
  "record after the abort uses the new generation": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "abort", G1), title(3, G1)],
  "restore does not end at the highest confirmed intent": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { through: 0 })],
  // through > from in all of these, so ONLY the `through === highest confirmed` rule can reject them
  "restore stops below the highest confirmed intent": [genesis, title(1, G0), resolve(1, "confirm", G0), title(2, G0), resolve(2, "confirm", G0),
    restoreRecord(3, G1, { from: 0, through: 1 })],
  "restore claims to replay beyond the highest confirmed intent": [genesis, title(1, G0), resolve(1, "confirm", G0), title(2, G0), resolve(2, "confirm", G0),
    restoreRecord(3, G1, { from: 0, through: 3 })],
  "restore reuses a generation which was aborted": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "abort", G1),
    restoreRecord(3, G1, { from: 0, through: 1 })],
  "restore returns to an earlier generation": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "confirm", G1),
    restoreRecord(3, G0, { previousGeneration: G1, from: 2, through: 2 })],
  "restore without grantAdmin": [genesis, title(1, G0), resolve(1, "confirm", G0), { n: 2, t: "intent", k: "restore", g: G1,
    p: { from: 0, through: 1, previousGeneration: G0, superseded: 0, skipped: 0 } }],
  "restore grantAdmin as a number (old count shape)": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { grantAdmin: 1 })],
  "restore grantAdmin unsorted": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { grantAdmin: [["b", "u"], ["a", "u"]] })],
  "restore grantAdmin with a duplicate": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { grantAdmin: [["a", "u"], ["a", "u"]] })],
  "restore grantAdmin with a malformed pair": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { grantAdmin: [["a"]] })],
  "restore grantAdmin with a bad ID": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { grantAdmin: [["a b", "u"]] })],
  "restore grantAdmin above the cap": [genesis, title(1, G0), resolve(1, "confirm", G0),
    restoreRecord(2, G1, { grantAdmin: Array.from({ length: 17 }, (_, i) => [`a${String(i).padStart(2, "0")}`, "u"]) })],
  "grantAdmin on an ordinary intent": [genesis, { ...title(1, G0), p: { seq: [1, 1], grantAdmin: [["a", "u"]] } }],
  "restore replays from the future": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { from: 1, through: 1 })],
  "restore starts before the previous restore": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "confirm", G1),
    restoreRecord(3, G2, { previousGeneration: G1, from: 1, through: 2 })],
  "restore without a payload shape": [genesis, title(1, G0), resolve(1, "confirm", G0),
    { n: 2, t: "intent", k: "restore", p: { superseded: 0 }, g: G1 }],
  "restore resolution of an ordinary intent with the new generation": [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1), resolve(2, "confirm", G1),
    resolve(1, "confirm", G0)],
};
/** The same chain WITHOUT the serializer's own shape check, so the VERIFIER alone must reject it. */
function rawChainOf(steps) {
  let prev = "0".repeat(64);
  let text = "";
  for (const step of steps) {
    const record = { k: null, p: null, ...step, prev };
    const h = createHash("sha256").update(prev + journalLib.canonicalJournalJson(record)).digest("hex");
    text += journalLib.canonicalJournalJson({ ...record, h }) + "\n";
    prev = h;
  }
  return text;
}
test("verifier: the raw chain builder produces chains the verifier accepts (control for the rejection tests)", () => {
  const good = [genesis, title(1, G0), resolve(1, "confirm", G0), restoreRecord(2, G1, { grantAdmin: [["a", "u"], ["a", "v"], ["b", "u"]] }),
    resolve(2, "confirm", G1), title(3, G1), resolve(3, "confirm", G1)];
  for (const build of [chainOf, rawChainOf]) assert.equal(journalLib.verifyTargetStagingJournal(build(good), G1).generation, G1, build.name);
  assert.equal(journalLib.verifyTargetStagingJournal(rawChainOf(good), G1).confirmed, 3);
});

for (const [label, steps] of Object.entries(invalidChains)) {
  test(`verifier rejects: ${label}`, () => {
    for (const build of [chainOf, rawChainOf]) {
      let text;
      try { text = build(steps); } catch { continue; } // the serializer already refuses a malformed record
      for (const generation of [G0, G1, G2]) assert.equal(journalLib.verifyTargetStagingJournal(text, generation), null, `${build.name} ${generation}`);
    }
  });
}

test("the witness follows the same generation rule: a row of the wrong generation breaks the store", async () => {
  const { fx } = stalePending();
  const result = restoreNow(fx);
  assert.equal(result.ok, true);
  assert.equal(titleWrite(fx, "t1", "after").ok, true);
  const witnessPath = path.join(fx.stage.directory, "lumi-target-witness.sqlite");
  const witness = new DatabaseSync(witnessPath);
  try {
    const rows = witness.prepare("SELECT n, generation FROM commits ORDER BY n").all();
    assert.equal(rows[0].generation, fx.generations[0]);
    assert.ok(rows.slice(1).some(row => row.generation === fx.generations[0]), "pre-restore rows keep the old generation");
    assert.ok(rows.slice(-2).every(row => row.generation === result.restoreGeneration), "restore and later rows carry the new one");
    witness.exec("DROP TRIGGER commits_immutable_update");
    witness.prepare("UPDATE commits SET generation=? WHERE n=1").run(result.restoreGeneration);
  } finally { witness.close(); }
  journalLib.clearTargetStagingJournalCache();
  witnessLib.clearTargetStagingWitnessCache();
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "journal_invalid");
});

// =====================================================================================================
// schema v19 and the session code
// =====================================================================================================

test("schema v19: the restore tables are append-only and capacity-bound", () => {
  const fx = makeFixture();
  assert.equal(TARGET_STORE_SCHEMA_VERSION, 19);
  assert.equal(generationOf(fx) !== undefined, true);
  const db = fx.db;
  assert.throws(() => db.prepare("INSERT INTO restore_superseded_sessions VALUES (?,?,?)")
    .run("a".repeat(64), "alice", randomUUID()), /replacement is forbidden/, "needs a generation of the history");
  db.prepare("INSERT INTO restore_generations VALUES (?,?,?,?)").run(G1, G0, 1, Date.now());
  assert.throws(() => db.prepare("INSERT INTO restore_generations VALUES (?,?,?,?)").run(G1, G2, 2, Date.now()), /forbidden/);
  assert.throws(() => db.prepare("INSERT INTO restore_generations VALUES (?,?,?,?)").run(G2, G0, 2, Date.now()), /forbidden|UNIQUE/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO restore_generations VALUES (?,?,?,?)").run(G1, G0, 1, 1), /forbidden/);
  assert.throws(() => db.exec("DELETE FROM restore_generations"), /append-only/);
  assert.throws(() => db.exec("UPDATE restore_generations SET journal_n=5"), /append-only/);
  db.prepare("INSERT INTO restore_superseded_sessions VALUES (?,?,?)").run("a".repeat(64), "alice", G1);
  assert.throws(() => db.prepare("INSERT INTO restore_superseded_sessions VALUES (?,?,?)").run("a".repeat(64), "bob", G1), /forbidden/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO restore_superseded_sessions VALUES (?,?,?)").run("a".repeat(64), "bob", G1), /forbidden/);
  assert.throws(() => db.prepare("INSERT INTO restore_superseded_sessions VALUES (?,?,?)").run("not-hex", "bob", G1), /CHECK/);
  assert.throws(() => db.exec("DELETE FROM restore_superseded_sessions"), /append-only/);
  assert.throws(() => db.exec("UPDATE restore_superseded_sessions SET user_id='x'"), /append-only/);
  // The classifier: a listed token is session_restored, an unlisted one is not.
  assert.equal(durable.classifyTargetStagingSessionDenial(db, "a".repeat(64), Date.now()), "session_restored");
  assert.equal(durable.classifyTargetStagingSessionDenial(db, "b".repeat(64), Date.now()), "session_revoked");
});

test("preflight: audit rows of an unknown generation fail, rows of a recorded earlier one pass; the history must be one chain ending at the current generation", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  assert.equal(preflight(fx).ok, true);
  const current = generationOf(fx);
  // Rewriting the generation WITHOUT a history entry breaks the audit rows (as in 4a).
  const row = fx.db.prepare("SELECT restore_generation AS g FROM task_title_audit").get();
  assert.equal(row.g, current);
  fx.db.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(G1);
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory, mode: "r2-model" }).issues.includes("audit_invalid"), true);
  // ... with a history that names the old one it is valid again.
  fx.db.prepare("INSERT INTO restore_generations VALUES (?,?,?,?)").run(G1, current, 1, Date.now());
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory, mode: "r2-model" }).ok, true);
  // A history whose newest generation is not the current one is rejected.
  fx.db.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(G2);
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory, mode: "r2-model" }).issues.includes("restore_history_invalid"), true);
});

test("preflight: the restore history is exactly one chain from the current generation (detached cycle or chain, self-loop, duplicate previous fail)", () => {
  const issues = fx => inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory, mode: "r2-model" });
  const insert = (fx, generation, previous, n) =>
    fx.db.prepare("INSERT INTO restore_generations VALUES (?,?,?,?)").run(generation, previous, n, Date.now());
  const fresh = () => {
    const fx = makeFixture();
    assert.equal(titleWrite(fx, "t1", "x").ok, true);
    return { fx, current: generationOf(fx) };
  };
  // Valid multi-restore chain C <- B <- A (A is the original, not a row's generation).
  {
    const { fx, current } = fresh();
    const [B, A] = [randomUUID(), randomUUID()];
    insert(fx, current, B, 2);
    insert(fx, B, A, 1);
    assert.equal(issues(fx).ok, true, "valid two-restore chain");
    assert.equal(issues(fx).issues.includes("restore_history_invalid"), false);
  }
  // Detached cycle: metadata C; rows (C,B),(B,A),(X,Y),(Y,X) used to pass.
  {
    const { fx, current } = fresh();
    const [B, A, X, Y] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    insert(fx, current, B, 2);
    insert(fx, B, A, 1);
    insert(fx, X, Y, 3);
    insert(fx, Y, X, 4);
    assert.equal(issues(fx).issues.includes("restore_history_invalid"), true, "detached cycle");
  }
  // Detached chain: every row must be reached from the current generation.
  {
    const { fx, current } = fresh();
    const [B, A, X, Y] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    insert(fx, current, B, 2);
    insert(fx, B, A, 1);
    insert(fx, X, Y, 3);
    assert.equal(issues(fx).issues.includes("restore_history_invalid"), true, "detached chain");
  }
  // A single detached row besides a valid chain, and a history not containing the current generation.
  {
    const { fx } = fresh();
    insert(fx, randomUUID(), randomUUID(), 1);
    assert.equal(issues(fx).issues.includes("restore_history_invalid"), true, "current generation not in history");
  }
  // The schema already forbids a self-loop and a duplicate previous generation; the validator rejects them
  // on its own as well (defense in depth, e.g. against a DDL which is ever relaxed).
  const [C, B, A, D] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const row = (generation, previous_generation) => ({ generation, previous_generation });
  assert.equal(preflightLib.restoreHistoryIsOneChain([], C), true);
  assert.equal(preflightLib.restoreHistoryIsOneChain([row(C, B), row(B, A)], C), true);
  assert.equal(preflightLib.restoreHistoryIsOneChain([row(C, C)], C), false, "self-loop");
  assert.equal(preflightLib.restoreHistoryIsOneChain([row(C, B), row(D, B)], C), false, "duplicate previous");
  assert.equal(preflightLib.restoreHistoryIsOneChain([row(C, B), row(B, C)], C), false, "cycle through the current generation");
  assert.equal(preflightLib.restoreHistoryIsOneChain([row(C, B), row(B, A), row(D, C)], C), false, "a later generation is not the current one");
});

test("a superseded token keeps the restore code across expiry, and revocation precedence holds for tokens listed by an earlier restore", async () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const short = issue(fx, "alice", 1);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "y").ok, true);
  copyBack(fx, backup);
  assert.equal(restoreNow(fx).ok, true);
  await new Promise(resolve => setTimeout(resolve, 1300));
  const hash = durable.hashTargetStagingSessionToken(short.sessionToken);
  assert.equal(durable.verifyDurableTargetStagingSessionLiveCoded(fx.store, hash).code, "session_restored");
  // The coded primitives used by the routes agree (release check, read linearization, in-transaction mapper).
  const request = new Request(base + "tasks", { headers: { cookie: sessionCookie(short.sessionToken) } });
  const identity = identityLib.resolveStagingHttpIdentity(request);
  assert.equal(identityLib.verifyStagingIdentityBeforeRelease(request, identity, fx.store), "session_restored");
  assert.equal(identityLib.verifyStagingReadBeforeRelease(request, identity, fx.store, "alice",
    { actorUserId: "alice", areas: [] }), "session_restored");
  await expectBody(identityLib.stagingUnauthorizedRefusal(request, identity, fx.store),
    { ...AUTH, code: "session_restored" }, "in-transaction mapper");
  await expectBody(identityLib.stagingIdentityRefusal("session_restored"), { ...AUTH, code: "session_restored" }, "refusal");
});

// =====================================================================================================
// the operator CLI
// =====================================================================================================

test("CLI: help, strict arguments, a refusal, and a success whose output carries no tokens or content", () => {
  const run = (...args) => {
    const r = spawnSync(REAL_NODE, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
      "scripts/target-staging-restore.mjs", ...args], { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout };
  };
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", SECRET_TITLE).ok, true);
  const session = issue(fx, "alice");
  const backup = backupOf(fx);
  memberWrite(fx, "remove", "bob");
  const common = ["--directory", fx.stage.directory, "--generation", fx.stage.restoreGeneration];
  assert.equal(run("--help").status, 0);
  assert.match(run("--help").stdout, /--grant-admin/);
  for (const bad of [[], ["--directory", "relative", "--generation", fx.stage.restoreGeneration], [...common, "--bogus", "1"],
    [...common, "--directory", fx.stage.directory], [...common, "--grant-admin", "nocolon"], [...common, "--grant-admin"],
    [...common, "--grant-admin", ":bob"], ["--generation", fx.stage.restoreGeneration],
    ["--directory", fx.stage.directory, "--generation", "not-a-uuid"]]) {
    const result = run(...bad);
    assert.equal(result.status, 1, bad.join(" "));
    assert.equal(JSON.parse(result.stdout).reason, "invalid_request");
  }
  // Not restore_pending yet: a refusal, nothing changes.
  const before = worldHash(fx);
  assert.deepEqual(run(...common), { status: 1, stdout: JSON.stringify({ ok: false, reason: "unavailable" }) });
  assert.equal(worldHash(fx), before);
  copyBack(fx, backup);
  assert.deepEqual(run("--directory", fx.stage.directory, "--generation", randomUUID()),
    { status: 1, stdout: JSON.stringify({ ok: false, reason: "generation_mismatch" }) });
  assert.deepEqual(run(...common, "--grant-admin", "team-area:alice"),
    { status: 1, stdout: JSON.stringify({ ok: false, reason: "grant_unneeded" }) });
  const done = run(...common);
  assert.equal(done.status, 0, done.stdout);
  const report = JSON.parse(done.stdout);
  assert.equal(report.ok, true);
  assert.match(report.restoreGeneration, /^[0-9a-f-]{36}$/);
  assert.equal(report.replayedMembership, 1);
  assert.equal(report.grantedAdmins, 0);
  assert.deepEqual(report.grantAdmin, []);
  assert.deepEqual(Object.keys(report).sort(), ["backupAnchor", "confirmedThrough", "epochsBumped", "grantAdmin", "grantedAdmins", "ok",
    "previousGeneration", "replayedMembership", "restoreGeneration", "revokedTokens", "skipped", "stampedSessions",
    "supersededTokens"]);
  for (const secret of [session.sessionToken, durable.hashTargetStagingSessionToken(session.sessionToken), SECRET_TITLE]) {
    assert.ok(!done.stdout.includes(secret), "no token or content in the report");
  }
  assert.equal(generationOf(fx), report.restoreGeneration);
  // A second run on the restored store is a refusal again.
  const again = spawnSync(REAL_NODE, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
    "scripts/target-staging-restore.mjs", "--directory", fx.stage.directory, "--generation", report.restoreGeneration],
  { encoding: "utf8" });
  assert.equal(again.status, 1);
});

test("CLI: --grant-admin for a blocked Area prints the readable ID pairs, sorted, and the journal carries the same", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const backup = backupOf(fx);
  addIdentity(fx.db, "erin");
  memberWrite(fx, "add", "erin", "admin");
  memberWrite(fx, "set_role", "alice", "viewer");
  copyBack(fx, backup);
  const run = spawnSync(REAL_NODE, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
    "scripts/target-staging-restore.mjs", "--directory", fx.stage.directory, "--generation", fx.stage.restoreGeneration,
    "--grant-admin", "team-area:carol", "--grant-admin", "team-area:bob"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.grantAdmin, [["team-area", "bob"], ["team-area", "carol"]]);
  assert.equal(report.grantedAdmins, 2);
  assert.deepEqual(journalLines(fx).find(line => line.k === "restore").p.grantAdmin, report.grantAdmin);
});

test("the restore never reads or modifies content: titles stay out of the journal and the report", () => {
  const { fx } = stalePending();
  const result = restoreNow(fx);
  assert.equal(result.ok, true);
  assert.ok(!journalText(fx).includes(SECRET_TITLE));
  assert.ok(!JSON.stringify(result).includes(SECRET_TITLE));
  for (const line of journalLines(fx).filter(l => l.k === "restore")) {
    assert.deepEqual(Object.keys(line.p).sort().filter(k => !["seq"].includes(k)),
      ["from", "grantAdmin", "previousGeneration", "skipped", "superseded", "through"]);
  }
});

test("other operators keep working on the restored store (compaction, writers), through the same two-phase path", () => {
  const { fx } = stalePending();
  assert.equal(restoreNow(fx).ok, true);
  assert.equal(compactTargetStagingChangeLog(fx.store, { retentionDays: 7, now: Date.now() }).ok, true);
  assert.equal(titleWrite(fx, "t1", "post").ok, true);
  assert.equal(revokeAll(fx, "alice").ok, true);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  const state = journalState(fx);
  assert.equal(state.pending, null);
  assert.equal(anchorOf(fx), state.confirmed);
});

test("pinned helper: a normal writer cannot journal a restore record, and the restore helper writes nothing else", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "x").ok, true);
  const before = worldHash(fx);
  const asWriter = pinned.withPinnedTargetStagingWrite(fx.store, context => {
    context.commit({ kind: "restore", payload: { from: 0, through: 1, previousGeneration: fx.stage.restoreGeneration } });
    return "committed";
  }, () => "denied", () => "failed");
  assert.equal(asWriter, "failed");
  assert.equal(worldHash(fx), before);
  // The restore helper refuses a healthy store before the body runs.
  let ran = false;
  const asRestore = pinned.withPinnedTargetStagingRestore(fx.store, () => { ran = true; return "ran"; }, () => "denied", () => "failed");
  assert.equal(asRestore, "denied");
  assert.equal(ran, false);
});

// ---- COMMIT that throws AFTER it took effect (R2c.4b round 4, F1) ----------------------------------

/** The real COMMIT happens, then the first one throws; `afterReal` may also tamper with the files. */
function restoreWithThrowAfterCommit(afterReal = () => {}) {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  copyBack(fx, backup);
  const origExec = DatabaseSync.prototype.exec;
  let armed = true;
  DatabaseSync.prototype.exec = function (sql) {
    const out = origExec.call(this, sql);
    if (armed && sql === "COMMIT") {
      armed = false;
      afterReal(fx);
      throw new Error("injected: COMMIT failed after taking effect");
    }
    return out;
  };
  let result;
  try { result = restoreLib.restoreTargetStagingFromBackup(fx.store); } finally { DatabaseSync.prototype.exec = origExec; }
  return { fx, result };
}

test("restore: COMMIT throwing after its effect still confirms (trusted store): ok, generation reported, journal confirmed", () => {
  const { fx, result } = restoreWithThrowAfterCommit();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(restoreLib.restoreExitCode(result), 0);
  assert.equal(generationOf(fx), result.restoreGeneration);
  const lines = journalLines(fx);
  const restoreN = lines.find(l => l.t === "intent" && l.k === "restore").n;
  assert.equal(lines.some(l => l.t === "confirm" && l.n === restoreN && l.g === result.restoreGeneration), true);
  useStore(fx, result.restoreGeneration);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
  assert.equal(titleWrite(fx, "t1", "after").ok, true);
});

test("restore: COMMIT throwing after its effect on an untrusted store: confirm_untrusted with the generation, exit 2, next writer confirms", () => {
  const { fx, result } = restoreWithThrowAfterCommit(f => {
    const copy = `${f.databasePath}.same`;
    copyFileSync(f.databasePath, copy);
    renameSync(copy, f.databasePath);
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "confirm_untrusted");
  assert.equal(result.restoreGeneration, generationOf(fx));
  assert.equal(result.previousGeneration, fx.stage.restoreGeneration);
  assert.equal(restoreLib.restoreExitCode(result), 2);
  useStore(fx, result.restoreGeneration);
  assert.equal(titleWrite(fx, "t1", "after").ok, true, "the gate accepts the committed store");
  const lines = journalLines(fx);
  const restoreN = lines.find(l => l.t === "intent" && l.k === "restore").n;
  assert.equal(lines.some(l => l.t === "confirm" && l.n === restoreN), true);
});

/** COMMIT throws WITHOUT taking effect and the first ROLLBACK throws too (transaction still open). */
function withCommitAndRollbackFailing(fn) {
  const origExec = DatabaseSync.prototype.exec;
  let commitArmed = true;
  let rollbackArmed = false;
  DatabaseSync.prototype.exec = function (sql) {
    if (commitArmed && sql === "COMMIT") {
      commitArmed = false;
      rollbackArmed = true;
      throw new Error("injected: COMMIT failed without effect");
    }
    if (rollbackArmed && sql === "ROLLBACK") {
      rollbackArmed = false;
      throw new Error("injected: ROLLBACK failed (IOERR/BUSY)");
    }
    return origExec.call(this, sql);
  };
  try { return fn(); } finally { DatabaseSync.prototype.exec = origExec; }
}

function taskTitleOf(fx, id) {
  const db = new DatabaseSync(fx.databasePath, { readOnly: true });
  try { return db.prepare("SELECT title FROM tasks WHERE id = ?").get(id)?.title; } finally { db.close(); }
}
function anchorValueOf(fx) {
  const db = new DatabaseSync(fx.databasePath, { readOnly: true });
  try { return db.prepare("SELECT value FROM metadata WHERE key='anchor_seq'").get().value; } finally { db.close(); }
}

test("normal writer: COMMIT fails without effect and ROLLBACK also fails (txn open): failed, nothing committed, next writer recovers", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const anchorBefore = anchorValueOf(fx);
  const titleBefore = taskTitleOf(fx, "t1");
  const res = withCommitAndRollbackFailing(() => titleWrite(fx, "t1", "never"));
  assert.notEqual(res.ok, true, "an uncommitted write must not be acknowledged");
  assert.equal(anchorValueOf(fx), anchorBefore);
  assert.equal(taskTitleOf(fx, "t1"), titleBefore);
  assert.equal(titleWrite(fx, "t1", "after").ok, true, "the next writer aborts the trailing intent and succeeds");
  assert.equal(taskTitleOf(fx, "t1"), "after");
  assert.equal(journalLines(fx).some(l => l.t === "abort"), true);
});

test("restore: COMMIT fails without effect and ROLLBACK also fails: write_failed, exit 1, generation unchanged, no restoreGeneration", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  copyBack(fx, backup);
  const genBefore = generationOf(fx);
  const result = withCommitAndRollbackFailing(() => restoreLib.restoreTargetStagingFromBackup(fx.store));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "write_failed", JSON.stringify(result));
  assert.equal(restoreLib.restoreExitCode(result), 1);
  assert.equal("restoreGeneration" in result, false);
  assert.equal(generationOf(fx), genBefore);
});

/** COMMIT fails and SQLite auto-rolled-back: the hook runs the real ROLLBACK, then throws (isTransaction === false, durable state = pre-txn). */
function withCommitAutoRollback(fn) {
  const origExec = DatabaseSync.prototype.exec;
  let armed = true;
  DatabaseSync.prototype.exec = function (sql) {
    if (armed && sql === "COMMIT") {
      armed = false;
      origExec.call(this, "ROLLBACK");
      throw new Error("injected: COMMIT failed, transaction rolled back automatically");
    }
    return origExec.call(this, sql);
  };
  try { return fn(); } finally { DatabaseSync.prototype.exec = origExec; }
}

test("normal writer: COMMIT throws and the transaction auto-rolled-back: failed, nothing committed, next writer recovers", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const anchorBefore = anchorValueOf(fx);
  const res = withCommitAutoRollback(() => titleWrite(fx, "t1", "never"));
  assert.notEqual(res.ok, true, "an uncommitted write must not be acknowledged");
  assert.equal(anchorValueOf(fx), anchorBefore);
  assert.equal(taskTitleOf(fx, "t1"), "one");
  assert.equal(titleWrite(fx, "t1", "after").ok, true);
  assert.equal(taskTitleOf(fx, "t1"), "after");
});

test("restore: COMMIT throws and the transaction auto-rolled-back: write_failed, nothing committed, generation unchanged", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t1", "two").ok, true);
  copyBack(fx, backup);
  const genBefore = generationOf(fx);
  const anchorBefore = anchorValueOf(fx);
  const result = withCommitAutoRollback(() => restoreLib.restoreTargetStagingFromBackup(fx.store));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "write_failed", JSON.stringify(result));
  assert.equal(restoreLib.restoreExitCode(result), 1);
  assert.equal("restoreGeneration" in result, false);
  assert.equal(generationOf(fx), genBefore);
  assert.equal(anchorValueOf(fx), anchorBefore);
});

// A non-boolean isTransaction is not simulated: it is a native non-configurable own accessor of each
// DatabaseSync instance (Object.getOwnPropertyDescriptor: configurable false), which neither a prototype
// hook nor Object.defineProperty can override without a production test hook.

test("normal writer: COMMIT throwing after its effect is acknowledged ok, confirm appended, gate ok", () => {
  const fx = makeFixture();
  const origExec = DatabaseSync.prototype.exec;
  let armed = true;
  DatabaseSync.prototype.exec = function (sql) {
    const out = origExec.call(this, sql);
    if (armed && sql === "COMMIT") { armed = false; throw new Error("injected: COMMIT failed after taking effect"); }
    return out;
  };
  let res;
  try { res = titleWrite(fx, "t1", "one"); } finally { DatabaseSync.prototype.exec = origExec; }
  assert.equal(res.ok, true);
  assert.equal(taskTitleOf(fx, "t1"), "one");
  const lines = journalLines(fx);
  const n = lines.filter(l => l.t === "intent").at(-1).n;
  assert.equal(lines.some(l => l.t === "confirm" && l.n === n), true);
  assert.equal(durable.checkTargetStagingAnchorLive(fx.store), "ok");
});

test("CLI: confirm_untrusted exits 2 and prints restoreGeneration (child process with a test-local exec hook)", () => {
  const fx = makeFixture();
  assert.equal(titleWrite(fx, "t1", "one").ok, true);
  const backup = backupOf(fx);
  assert.equal(titleWrite(fx, "t2", "two").ok, true);
  copyBack(fx, backup);
  fx.db.close();
  const hook = path.join(root, `${fx.name}.exec-hook.mjs`);
  writeFileSync(hook, `
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, renameSync } from "node:fs";
const DB = process.env.HOOK_DB;
const orig = DatabaseSync.prototype.exec;
let done = false;
DatabaseSync.prototype.exec = function (sql, ...rest) {
  const out = orig.call(this, sql, ...rest);
  if (!done && String(sql).trim() === "COMMIT") {
    done = true;
    copyFileSync(DB, DB + ".tmp"); renameSync(DB + ".tmp", DB);
  }
  return out;
};
`);
  const run = spawnSync(REAL_NODE, ["--no-warnings", "--import", `file://${hook}`, "--experimental-loader",
    "./tests/ts-loader.mjs", "scripts/target-staging-restore.mjs", "--directory", fx.stage.directory,
    "--generation", fx.stage.restoreGeneration], { encoding: "utf8", env: { ...process.env, HOOK_DB: fx.databasePath } });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.reason, "confirm_untrusted");
  assert.match(report.restoreGeneration, /^[0-9a-f-]{36}$/);
  assert.equal(report.previousGeneration, fx.stage.restoreGeneration);
  const db = new DatabaseSync(fx.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='restore_generation'").get().value, report.restoreGeneration);
  } finally { db.close(); }
  // A rerun is not a restore any more: unavailable, exit 1.
  const again = spawnSync(REAL_NODE, ["--experimental-loader", "./tests/ts-loader.mjs", "--no-warnings",
    "scripts/target-staging-restore.mjs", "--directory", fx.stage.directory, "--generation", report.restoreGeneration],
  { encoding: "utf8" });
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stdout).reason, "unavailable");
});
