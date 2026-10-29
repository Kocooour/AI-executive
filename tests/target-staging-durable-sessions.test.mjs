import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2-ID.1: durable multi-process staging sessions. Synthetic data in temp dirs only.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2id1-"));
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
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-r2id1-session-secret-2026-10-29";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore, TARGET_STORE_SCHEMA_VERSION, TARGET_STAGING_RECEIPT_PREFIX } =
  await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const identityLib = await import("../lib/target-staging-http-identity.ts");
const { readStagingPersonalPageInChild } = await import("../lib/target-staging-read-process.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const { GET: LIST } = await import("../app/api/target-staging/tasks/route.ts");
const { GET: DETAIL } = await import("../app/api/target-staging/tasks/[taskId]/route.ts");
const { GET: AUDIT } = await import("../app/api/target-staging/tasks/[taskId]/audit/route.ts");
const { GET: PROJECTS } = await import("../app/api/target-staging/projects/route.ts");
const { GET: PREVIEW, PATCH } = await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const { POST: STATUS } = await import("../app/api/target-staging/tasks/[taskId]/title/status/route.ts");

const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
const store = {
  stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
};
const admin = new DatabaseSync(stage.databasePath);
admin.exec("PRAGMA foreign_keys=ON");
admin.prepare("INSERT INTO identities(id) VALUES ('bob')").run();
admin.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('bob-personal','personal','bob')").run();
admin.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES ('bob-private','Bob','private','bob-personal','bob','unassigned')").run();
const addTask = admin.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
addTask.run("alice-1", stage.unassignedAreaId, "Alice one");
addTask.run("alice-2", stage.unassignedAreaId, "Alice two");
addTask.run("alice-3", stage.unassignedAreaId, "Alice three");
addTask.run("bob-1", "bob-private", "Bob one");
addTask.run("bob-2", "bob-private", "Bob two");
addTask.run("bob-3", "bob-private", "Bob three");
admin.close();

const loader = path.resolve("scripts/target-staging-ts-loader.mjs");
/** Run the operator CLI in a SEPARATE Node process (a distinct "server"). */
function cli(command, ...args) {
  const run = spawnSync(process.execPath, [
    "--experimental-loader", loader, path.resolve("scripts/target-staging-session.mjs"), command,
    "--directory", stage.directory, "--generation", stage.restoreGeneration, ...args,
  ], { encoding: "utf8", cwd: path.resolve("."), env: { ...process.env } });
  return { status: run.status, body: JSON.parse(run.stdout || "{}") };
}
const issueCli = user => {
  const result = cli("issue", "--user", user, "--synthetic-test-identity");
  assert.equal(result.status, 0, JSON.stringify(result.body));
  return result.body;
};
const hash = token => createHash("sha256").update(token).digest("hex");
const rows = (sql, ...args) => {
  const db = new DatabaseSync(stage.databasePath, { readOnly: true });
  try { return db.prepare(sql).all(...args).map(row => ({ ...row })); } finally { db.close(); }
};
const sessionCookie = token => `${durable.TARGET_STAGING_SESSION_COOKIE}=${token}`;
const ownerCookie = `${sessionCookieName}=${createSessionToken()}`;
const base = "http://localhost:3001/api/target-staging/";
const ctx = key => value => ({ params: Promise.resolve({ [key]: value }) });
const taskCtx = ctx("taskId");
const get = (handler, pathname, cookie, context) =>
  handler(new Request(base + pathname, { headers: cookie ? { cookie } : {} }), context);
const write = (taskId, cookie, body, handler = PATCH, suffix = "") =>
  handler(new Request(base + `tasks/${taskId}/title${suffix}`, {
    method: handler === PATCH ? "PATCH" : "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3001", cookie },
    body: JSON.stringify(body),
  }), taskCtx(taskId));
const titles = body => body.tasks.map(task => task.title).sort();

after(() => {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("schema v5 stores only a token hash and enforces issuance limits", () => {
  assert.equal(TARGET_STORE_SCHEMA_VERSION, 5);
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).ok, true);
  const issued = issueCli("alice");
  assert.equal(issued.ok, true);
  assert.match(issued.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  const [row] = rows("SELECT * FROM staging_sessions WHERE id=?", issued.sessionId);
  assert.equal(row.token_hash, hash(issued.sessionToken));
  assert.equal(row.user_id, "alice");
  assert.equal(row.revoked_at_ms, null);
  assert.ok(row.expires_at_ms - row.created_at_ms <= 15 * 60 * 1000);
  // The raw token is never persisted anywhere in the database file.
  assert.equal(readFileSync(stage.databasePath).includes(Buffer.from(issued.sessionToken)), false);
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).ok, true);

  assert.equal(durable.issueDurableTargetStagingSession(store, "alice", 901).reason, "invalid_request");
  assert.equal(durable.issueDurableTargetStagingSession(store, "alice", 0).reason, "invalid_request");
  assert.equal(durable.issueDurableTargetStagingSession(store, "nobody").reason, "unknown_user");
  assert.equal(durable.issueDurableTargetStagingSession(store, "../etc").reason, "invalid_request");
  assert.equal(durable.issueDurableTargetStagingSession(
    { ...store, expectedRestoreGeneration: randomUUID() }, "alice").ok, false);
  assert.equal(cli("issue", "--user", "alice").status, 1, "CLI demands the synthetic-identity acknowledgement");
  assert.equal(cli("issue", "--user", "alice", "--lifetime-seconds", "901", "--synthetic-test-identity").status, 1);
});

test("revocation is durable across processes and applies immediately", () => {
  const issued = issueCli("bob");
  const tokenHash = hash(issued.sessionToken);
  const live = durable.verifyDurableTargetStagingSessionLive(store, tokenHash);
  assert.deepEqual(live, { ok: true, sessionId: issued.sessionId, userId: "bob" });
  // Revoke from a different process; a freshly started process observes it.
  const revoked = cli("revoke", "--session-id", issued.sessionId);
  assert.deepEqual(revoked.body, { ok: true, changed: true });
  assert.deepEqual(durable.verifyDurableTargetStagingSessionLive(store, tokenHash), { ok: false, reason: "invalid" });
  assert.deepEqual(cli("revoke", "--session-id", issued.sessionId).body, { ok: true, changed: false });
  assert.equal(cli("revoke", "--session-id", randomUUID()).body.reason, "not_found");
  // Unknown, malformed and wrong-length tokens never resolve.
  assert.equal(durable.verifyDurableTargetStagingSessionLive(store, hash("x")).ok, false);
  assert.equal(durable.verifyDurableTargetStagingSessionLive(store, "not-a-hash").ok, false);
});

test("revoke-user bumps the epoch, kills older sessions and permits a fresh login", () => {
  const first = issueCli("bob");
  const second = issueCli("bob");
  const before = rows("SELECT revocation_epoch FROM identities WHERE id='bob'")[0].revocation_epoch;
  const result = cli("revoke-user", "--user", "bob");
  assert.equal(result.body.ok, true);
  assert.equal(result.body.revocationEpoch, before + 1);
  for (const session of [first, second]) {
    assert.equal(durable.verifyDurableTargetStagingSessionLive(store, hash(session.sessionToken)).ok, false);
  }
  const fresh = issueCli("bob");
  assert.equal(durable.verifyDurableTargetStagingSessionLive(store, hash(fresh.sessionToken)).ok, true);
  assert.equal(rows("SELECT revocation_epoch FROM staging_sessions WHERE id=?", fresh.sessionId)[0].revocation_epoch, before + 1);
  assert.equal(cli("revoke-user", "--user", "nobody").body.reason, "not_found");
  // An epoch bump alone (even without stamping rows) invalidates: forge a stale-epoch row via SQL.
  const direct = new DatabaseSync(stage.databasePath);
  direct.prepare("UPDATE identities SET revocation_epoch=revocation_epoch+1 WHERE id='bob'").run();
  direct.close();
  assert.equal(durable.verifyDurableTargetStagingSessionLive(store, hash(fresh.sessionToken)).ok, false);
});

test("an expired session is rejected by the live check", () => {
  const issued = issueCli("alice");
  const tokenHash = hash(issued.sessionToken);
  const expires = rows("SELECT expires_at_ms FROM staging_sessions WHERE id=?", issued.sessionId)[0].expires_at_ms;
  assert.equal(durable.verifyDurableTargetStagingSessionLive(store, tokenHash, expires - 1).ok, true);
  assert.equal(durable.verifyDurableTargetStagingSessionLive(store, tokenHash, expires).ok, false);
});

test("database triggers: no un-revoke, monotonic epoch, immutable rows, capacity, no replacement", () => {
  const issued = issueCli("alice");
  const db = new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  try {
    const sid = issued.sessionId;
    db.prepare("UPDATE staging_sessions SET revoked_at_ms=? WHERE id=?").run(Date.now(), sid);
    assert.throws(() => db.prepare("UPDATE staging_sessions SET revoked_at_ms=NULL WHERE id=?").run(sid), /irreversible/);
    assert.throws(() => db.prepare("UPDATE staging_sessions SET revoked_at_ms=revoked_at_ms+1 WHERE id=?").run(sid), /irreversible/);
    assert.throws(() => db.prepare("UPDATE staging_sessions SET user_id='bob' WHERE id=?").run(sid), /immutable/);
    assert.throws(() => db.prepare("UPDATE staging_sessions SET expires_at_ms=expires_at_ms+1 WHERE id=?").run(sid), /immutable/);
    assert.throws(() => db.prepare("UPDATE staging_sessions SET token_hash=? WHERE id=?").run(hash("other"), sid), /immutable/);
    assert.throws(() => db.prepare("UPDATE staging_sessions SET revocation_epoch=99 WHERE id=?").run(sid), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM staging_sessions WHERE id=?").run(sid), /retention/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO staging_sessions VALUES (?,?,?,?,?,NULL,0)")
      .run(sid, "alice", hash("replace"), 1, 2), /replacement|stale|CHECK|constraint/i);
    // A pre-revoked or stale-epoch row cannot be inserted either.
    const insert = (id, tokenHashValue, revoked, epoch) => db.prepare(
      "INSERT INTO staging_sessions VALUES (?,?,?,?,?,?,?)",
    ).run(id, "alice", tokenHashValue, 1000, 2000, revoked, epoch);
    assert.throws(() => insert(randomUUID(), hash("a"), 1500, 0), /replacement|stale/);
    assert.throws(() => insert(randomUUID(), hash("b"), null, 7), /replacement|stale/);
    assert.throws(() => insert(randomUUID(), "A".repeat(64), null, 0), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO staging_sessions VALUES (?,?,?,?,?,NULL,0)")
      .run(randomUUID(), "alice", hash("long"), 1000, 1000 + 15 * 60 * 1000 + 1), /CHECK/);
    // Epochs only ever move up by one; identities cannot be replaced or renamed.
    const epoch = db.prepare("SELECT revocation_epoch AS e FROM identities WHERE id='alice'").get().e;
    assert.throws(() => db.prepare("UPDATE identities SET revocation_epoch=? WHERE id='alice'").run(epoch), /increment/);
    assert.throws(() => db.prepare("UPDATE identities SET revocation_epoch=? WHERE id='alice'").run(epoch + 2), /increment/);
    assert.throws(() => db.prepare("UPDATE identities SET revocation_epoch=? WHERE id='alice'").run(epoch - 1), /increment/);
    assert.throws(() => db.prepare("INSERT OR REPLACE INTO identities(id) VALUES ('alice')").run(), /replacement/);
    assert.throws(() => db.prepare("INSERT INTO identities(id,revocation_epoch) VALUES ('mallory',5)").run(), /replacement/);
    assert.throws(() => db.prepare("UPDATE identities SET id='alicia' WHERE id='alice'").run());
    // Capacity cap fails closed.
    db.exec("CREATE TEMP TABLE n(i INTEGER)");
    db.exec("BEGIN");
    const count = db.prepare("SELECT COUNT(*) AS c FROM staging_sessions").get().c;
    const fill = db.prepare("INSERT INTO staging_sessions VALUES (?,?,?,?,?,NULL,?)");
    const currentEpoch = db.prepare("SELECT revocation_epoch AS e FROM identities WHERE id='bob'").get().e;
    for (let index = count; index < 4096; index++) {
      fill.run(randomUUID(), "bob", hash("fill" + index), 1000, 2000, currentEpoch);
    }
    assert.throws(() => fill.run(randomUUID(), "bob", hash("overflow"), 1000, 2000, currentEpoch), /capacity/);
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).ok, true);
});

test("a tampered session row (epoch ahead of identity) fails preflight", () => {
  const copy = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "tampered"), ownerUserId: "alice",
  });
  const db = new DatabaseSync(copy.databasePath);
  db.exec("PRAGMA foreign_keys=ON; DROP TRIGGER staging_session_conflict_guard");
  db.prepare("INSERT INTO staging_sessions VALUES (?,?,?,?,?,NULL,?)")
    .run(randomUUID(), "alice", hash("t"), 1000, 2000, 3);
  db.close();
  const result = inspectIsolatedTargetStore({ stagingDirectory: copy.directory, mode: "r2-model" });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes("schema_invalid") || result.issues.includes("session_invalid"));
});

test("older v4 stores are rejected and never migrated", () => {
  const v4 = bootstrapIsolatedTargetStore({
    stagingDirectory: path.join(root, "v4"), ownerUserId: "alice",
  });
  const db = new DatabaseSync(v4.databasePath);
  db.exec(`DROP TABLE staging_sessions; UPDATE metadata SET value='4' WHERE key='schema_version';`);
  db.close();
  const preflight = inspectIsolatedTargetStore({ stagingDirectory: v4.directory, mode: "r2-model" });
  assert.equal(preflight.ok, false);
  assert.ok(preflight.issues.includes("schema_invalid") && preflight.issues.includes("metadata_invalid"));
  const v4Store = { stagingDirectory: v4.directory, expectedRestoreGeneration: v4.restoreGeneration };
  assert.equal(durable.issueDurableTargetStagingSession(v4Store, "alice").ok, false);
  assert.equal(durable.verifyDurableTargetStagingSessionLive(v4Store, hash("x")).ok, false);
  // No schema change was applied by the failed attempts.
  const check = new DatabaseSync(v4.databasePath, { readOnly: true });
  try {
    assert.equal(check.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, "4");
    assert.equal(check.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE name='staging_sessions'").get().c, 0);
  } finally { check.close(); }
});

test("HTTP: session cookie maps to its own user; identity B never sees A's private data", async () => {
  const alice = issueCli("alice");
  const bob = issueCli("bob");
  const aliceCookie = sessionCookie(alice.sessionToken);
  const bobCookie = sessionCookie(bob.sessionToken);

  const asBob = await get(LIST, "tasks", bobCookie);
  assert.equal(asBob.status, 200);
  assert.equal(asBob.headers.get("cache-control"), "no-store");
  assert.deepEqual(titles(await asBob.json()), ["Bob one", "Bob three", "Bob two"]);
  const asAlice = await get(LIST, "tasks", aliceCookie);
  assert.deepEqual(titles(await asAlice.json()), ["Alice one", "Alice three", "Alice two"]);
  // The legacy owner cookie keeps working and maps to the configured owner (alice).
  const asOwner = await get(LIST, "tasks", ownerCookie);
  assert.deepEqual(titles(await asOwner.json()), ["Alice one", "Alice three", "Alice two"]);

  // Direct access to the other identity's task is indistinguishable from absence.
  assert.equal((await get(DETAIL, "tasks/alice-1", bobCookie, taskCtx("alice-1"))).status, 404);
  assert.equal((await get(DETAIL, "tasks/bob-1", aliceCookie, taskCtx("bob-1"))).status, 404);
  assert.equal((await get(DETAIL, "tasks/bob-1", bobCookie, taskCtx("bob-1"))).status, 200);
  assert.equal((await get(AUDIT, "tasks/alice-1/audit", bobCookie, taskCtx("alice-1"))).status, 404);
  assert.equal((await get(PREVIEW, "tasks/alice-1/title", bobCookie, taskCtx("alice-1"))).status, 404);
  assert.equal((await get(PROJECTS, "projects", bobCookie)).status, 200);

  // Cursors are bound to the session: they cannot move to another identity or the owner path.
  const page = await (await get(LIST, "tasks?limit=1", bobCookie)).json();
  assert.equal(page.tasks.length, 1);
  assert.ok(page.nextCursor);
  const next = await get(LIST, "tasks?limit=1&cursor=" + page.nextCursor, bobCookie);
  assert.equal(next.status, 200);
  for (const stolen of [aliceCookie, ownerCookie]) {
    const rejected = await get(LIST, "tasks?limit=1&cursor=" + page.nextCursor, stolen);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers.get("cache-control"), "no-store");
  }
  // Even another session of the SAME user cannot reuse it.
  const bobAgain = issueCli("bob");
  assert.equal((await get(LIST, "tasks?limit=1&cursor=" + page.nextCursor, sessionCookie(bobAgain.sessionToken))).status, 400);

  // Garbage or missing session cookies never fall back to the owner cookie.
  assert.equal((await get(LIST, "tasks", `${sessionCookie("x".repeat(43))}; ${ownerCookie}`)).status, 401);
  assert.equal((await get(LIST, "tasks", `${sessionCookie("short")}; ${ownerCookie}`)).status, 401);
  assert.equal((await get(LIST, "tasks", undefined)).status, 401);
});

test("HTTP: a revoked session gets 401 with no data on every read route, even without a restart", async () => {
  const bob = issueCli("bob");
  const cookie = sessionCookie(bob.sessionToken);
  assert.equal((await get(LIST, "tasks", cookie)).status, 200);
  assert.equal(cli("revoke", "--session-id", bob.sessionId).body.ok, true);
  for (const response of [
    await get(LIST, "tasks", cookie),
    await get(DETAIL, "tasks/bob-1", cookie, taskCtx("bob-1")),
    await get(AUDIT, "tasks/bob-1/audit", cookie, taskCtx("bob-1")),
    await get(PROJECTS, "projects", cookie),
    await get(PREVIEW, "tasks/bob-1/title", cookie, taskCtx("bob-1")),
  ]) {
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Authentication required" });
  }
});

test("read barrier: read finished -> revoke on another process -> release check returns 401 without data", async () => {
  const bob = issueCli("bob");
  const cookie = sessionCookie(bob.sessionToken);
  const request = new Request(base + "tasks", { headers: { cookie } });
  const identity = identityLib.resolveStagingHttpIdentity(request);
  assert.deepEqual(identity, { kind: "session", tokenHash: hash(bob.sessionToken) });
  const config = { ...store, ownerUserId: "alice", ...identityLib.stagingChildSessionConfig(identity) };

  // 1. The snapshot read (a separate child process) completes and returns data.
  const page = await readStagingPersonalPageInChild(config, 50, 0);
  assert.deepEqual(page.tasks.map(task => task.title).sort(), ["Bob one", "Bob three", "Bob two"]);
  assert.equal(identityLib.verifyStagingIdentityBeforeRelease(request, identity, store), "ok");
  // 2. Another process revokes after the read finished but before release.
  assert.equal(cli("revoke", "--session-id", bob.sessionId).body.ok, true);
  // 3. The release check observes the revocation: the route must answer 401, no body.
  assert.equal(identityLib.verifyStagingIdentityBeforeRelease(request, identity, store), "unauthorized");
  const refusal = identityLib.stagingIdentityRefusal("unauthorized");
  assert.equal(refusal.status, 401);
  assert.equal(refusal.headers.get("cache-control"), "no-store");
  assert.deepEqual(await refusal.json(), { error: "Authentication required" });
  // A child started for a revoked session reads nothing at all.
  assert.equal(await readStagingPersonalPageInChild(config, 50, 0), null);
  // Expiry is enforced at the same linearization point; owner path is unaffected.
  const ownerRequest = new Request(base + "tasks", { headers: { cookie: ownerCookie } });
  assert.equal(identityLib.verifyStagingIdentityBeforeRelease(
    ownerRequest, identityLib.resolveStagingHttpIdentity(ownerRequest), store), "ok");
});

test("write barrier: session revoked after resolution but before commit writes nothing", async () => {
  const bob = issueCli("bob");
  const tokenHash = hash(bob.sessionToken);
  const authority = new TargetStagingSessionAuthority(store);
  try {
    // Preview as bob (live), obtain the CAS revision and a write credential.
    const reader = authority.issue("bob");
    const preview = authority.previewTaskTitleEdit(reader.sessionToken, { taskId: "bob-1" }, true);
    assert.equal(preview.ok, true);
    const writer = authority.issueWritable("bob");
    const input = { commandId: randomUUID(), taskId: "bob-1", title: "Bob edited",
      expectedRevision: preview.snapshotRevision };
    const auditBefore = rows("SELECT COUNT(*) AS c FROM task_title_audit")[0].c;
    const receiptsBefore = rows("SELECT COUNT(*) AS c FROM metadata WHERE key LIKE ?", TARGET_STAGING_RECEIPT_PREFIX + "%")[0].c;
    const revisionBefore = rows("SELECT revision FROM tasks WHERE id='bob-1'")[0].revision;

    // The writer was authorised while the session was live; another process revokes.
    assert.equal(durable.verifyDurableTargetStagingSessionLive(store, tokenHash).ok, true);
    assert.equal(cli("revoke", "--session-id", bob.sessionId).body.ok, true);
    const result = authority.updateTaskTitle(writer.sessionToken, input, true, tokenHash);
    assert.deepEqual(result, { ok: false, reason: "session_revoked" });
    assert.deepEqual(rows("SELECT title, revision FROM tasks WHERE id='bob-1'"), [{ title: "Bob one", revision: revisionBefore }]);
    assert.equal(rows("SELECT COUNT(*) AS c FROM task_title_audit")[0].c, auditBefore);
    assert.equal(rows("SELECT COUNT(*) AS c FROM metadata WHERE key LIKE ?", TARGET_STAGING_RECEIPT_PREFIX + "%")[0].c, receiptsBefore);

    // Control: a live session of the same user commits through the same path.
    const live = issueCli("bob");
    const ok = authority.updateTaskTitle(writer.sessionToken, input, true, hash(live.sessionToken));
    assert.deepEqual(ok, { ok: true });
    assert.equal(rows("SELECT title FROM tasks WHERE id='bob-1'")[0].title, "Bob edited");
    assert.equal(rows("SELECT COUNT(*) AS c FROM task_title_audit")[0].c, auditBefore + 1);
    // A live session of a DIFFERENT user cannot authorise bob's write.
    const alice = issueCli("alice");
    const second = authority.previewTaskTitleEdit(reader.sessionToken, { taskId: "bob-2" }, true);
    const mismatch = authority.updateTaskTitle(writer.sessionToken, {
      commandId: randomUUID(), taskId: "bob-2", title: "Hijack", expectedRevision: second.snapshotRevision,
    }, true, hash(alice.sessionToken));
    assert.deepEqual(mismatch, { ok: false, reason: "session_revoked" });
    assert.equal(rows("SELECT title FROM tasks WHERE id='bob-2'")[0].title, "Bob two");
  } finally {
    authority.close();
  }
});

test("HTTP writes: B edits only B's task; a revoked session cannot write or reconcile", async () => {
  const bob = issueCli("bob");
  const cookie = sessionCookie(bob.sessionToken);
  const preview = await get(PREVIEW, "tasks/bob-3/title", cookie, taskCtx("bob-3"));
  assert.equal(preview.status, 200);
  const { snapshotRevision } = await preview.json();
  const command = { commandId: randomUUID(), title: "Bob three edited", expectedRevision: snapshotRevision };

  // B cannot target A's task, with or without a valid revision.
  const foreignPreview = await (await get(PREVIEW, "tasks/alice-1/title", ownerCookie, taskCtx("alice-1"))).json();
  const foreign = await write("alice-1", cookie, { ...command, expectedRevision: foreignPreview.snapshotRevision });
  assert.equal(foreign.status, 404);
  assert.equal(rows("SELECT title FROM tasks WHERE id='alice-1'")[0].title, "Alice one");

  const saved = await write("bob-3", cookie, command);
  assert.equal(saved.status, 200);
  assert.equal(rows("SELECT title FROM tasks WHERE id='bob-3'")[0].title, "Bob three edited");
  const audit = rows("SELECT actor_user_id FROM task_title_audit WHERE task_id='bob-3'");
  assert.deepEqual(audit, [{ actor_user_id: "bob" }]);
  const status = await write("bob-3", cookie, command, STATUS, "/status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { status: "committed" });

  // Revoke, then neither write nor reconciliation is possible and nothing changes.
  assert.equal(cli("revoke", "--session-id", bob.sessionId).body.ok, true);
  const next = await (await get(PREVIEW, "tasks/bob-2/title", sessionCookie(issueCli("bob").sessionToken), taskCtx("bob-2"))).json();
  const refused = await write("bob-2", cookie, { commandId: randomUUID(), title: "Too late", expectedRevision: next.snapshotRevision });
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("cache-control"), "no-store");
  assert.equal(rows("SELECT title FROM tasks WHERE id='bob-2'")[0].title, "Bob two");
  assert.equal((await write("bob-3", cookie, command, STATUS, "/status")).status, 401);
  assert.equal(rows("SELECT COUNT(*) AS c FROM task_title_audit WHERE task_id='bob-2'")[0].c, 0);
});

test("the legacy store and unrelated state are untouched", () => {
  assert.deepEqual(rows("SELECT id FROM identities ORDER BY id"), [{ id: "alice" }, { id: "bob" }]);
  assert.equal(rows("SELECT value FROM metadata WHERE key='activated'")[0].value, "false");
});
