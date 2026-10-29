import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2-ID.2a: shared-Area membership command. Synthetic temp stores only.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2id2a-"));
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
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-r2id2a-session-secret-2026-10-29";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore, TARGET_STORE_SCHEMA_VERSION } =
  await import("../lib/target-store-bootstrap.ts");
const { inspectIsolatedTargetStore } = await import("../lib/target-store-preflight.ts");
const { createSessionToken, sessionCookieName } = await import("../lib/auth.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const { POST } = await import("../app/api/target-staging/areas/[areaId]/members/route.ts");

const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "alice",
});
process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
const store = {
  stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration,
};
const db = new DatabaseSync(stage.databasePath);
db.exec("PRAGMA foreign_keys=ON");
for (const user of ["bob", "carol", "dave", "erin"]) {
  db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)")
    .run(`personal-${user}`, user);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?, 'Nezařazeno', 'private', ?, ?, 'unassigned')")
    .run(`private-${user}`, `personal-${user}`, user);
}
// Note: preflight already rejects any identity without a personal workspace, so a
// target without one can never reach the command; the in-command check is defense in depth.

let counter = 0;
/** Fresh shared Area. Alice is admin; members is {user: role}. */
function makeArea(members = { bob: "editor", carol: "viewer" }) {
  const n = ++counter;
  const area = `area-${n}`;
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'shared', 'alice')").run(`ws-${n}`);
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?, 'Team', 'shared', ?, 'alice')")
    .run(area, `ws-${n}`);
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?, 'alice', 'admin')").run(area);
  for (const [user, role] of Object.entries(members)) {
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)").run(area, user, role);
  }
  return area;
}
const revision = area => db.prepare("SELECT policy_revision AS r FROM areas WHERE id=?").get(area).r;
const role = (area, user) => db.prepare("SELECT role FROM area_members WHERE area_id=? AND user_id=?")
  .get(area, user)?.role ?? null;
const counts = () => ({
  receipts: db.prepare("SELECT COUNT(*) AS n FROM area_membership_receipts").get().n,
  audit: db.prepare("SELECT COUNT(*) AS n FROM area_membership_audit").get().n,
});
const assign = (id, area, user, projectId = null) => {
  if (projectId) db.prepare("INSERT INTO tasks(id,project_id,title,assignee_user_id) VALUES (?,?,?,?)").run(id, projectId, id, user);
  else db.prepare("INSERT INTO tasks(id,area_id,title,assignee_user_id) VALUES (?,?,?,?)").run(id, area, id, user);
};
const assignee = id => db.prepare("SELECT assignee_user_id AS a FROM tasks WHERE id=?").get(id).a;
const taskRevision = id => db.prepare("SELECT revision AS r FROM tasks WHERE id=?").get(id).r;

const authority = new TargetStagingSessionAuthority(store);
const command = (area, action, targetUserId, extra = {}) => ({
  commandId: randomUUID(), areaId: area, expectedPolicyRevision: revision(area),
  action, targetUserId, ...(action === "remove" ? {} : { role: "editor" }), ...extra,
});
const apply = (actor, cmd, hash) => {
  const issued = authority.issueWritable(actor);
  assert.ok(issued);
  return authority.applyMembershipCommand(issued.sessionToken, cmd, hash);
};

after(() => {
  authority.close();
  db.close();
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("schema v6 passes preflight; a v5 store without the membership ledger is rejected", () => {
  assert.equal(TARGET_STORE_SCHEMA_VERSION, 6);
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).ok, true);
  const v5 = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, "v5"), ownerUserId: "alice" });
  const old5 = new DatabaseSync(v5.databasePath);
  old5.exec(`DROP TABLE area_membership_audit; DROP TABLE area_membership_receipts;
    UPDATE metadata SET value='5' WHERE key='schema_version'`);
  old5.close();
  const check = inspectIsolatedTargetStore({ stagingDirectory: v5.directory, mode: "r2-model" });
  assert.equal(check.ok, false);
  assert.ok(check.issues.includes("metadata_invalid") || check.issues.includes("schema_invalid"));
});

test("add, set_role and remove commit with exactly one policy revision each, a receipt and an audit row", () => {
  const area = makeArea();
  const start = revision(area);
  const before = counts();
  const added = apply("alice", command(area, "add", "dave", { role: "viewer" }));
  assert.deepEqual(added, { ok: true, outcome: "applied", policyRevision: start + 1, unassignedTasks: 0 });
  assert.equal(role(area, "dave"), "viewer");
  const changed = apply("alice", command(area, "set_role", "dave", { role: "editor" }));
  assert.equal(changed.policyRevision, start + 2);
  assert.equal(role(area, "dave"), "editor");
  const removed = apply("alice", command(area, "remove", "dave"));
  assert.equal(removed.policyRevision, start + 3);
  assert.equal(role(area, "dave"), null);
  assert.equal(revision(area), start + 3);
  assert.deepEqual(counts(), { receipts: before.receipts + 3, audit: before.audit + 3 });
  const audit = db.prepare(`SELECT actor_user_id,target_user_id,action,role_before,role_after,
    policy_revision_before,policy_revision_after,restore_generation,receipt_key
    FROM area_membership_audit WHERE area_id=? ORDER BY id`).all(area).map(row => ({ ...row }));
  assert.deepEqual(audit.map(row => [row.action, row.role_before, row.role_after,
    row.policy_revision_before, row.policy_revision_after]), [
    ["add", null, "viewer", start, start + 1],
    ["set_role", "viewer", "editor", start + 1, start + 2],
    ["remove", "editor", null, start + 2, start + 3],
  ]);
  assert.ok(audit.every(row => row.actor_user_id === "alice" && row.target_user_id === "dave" &&
    row.restore_generation === stage.restoreGeneration && /^[0-9a-f]{64}$/.test(row.receipt_key)));
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).ok, true);
});

test("exact replay returns the stored result without a second change, audit row or revision bump", () => {
  const area = makeArea();
  const cmd = command(area, "add", "dave", { role: "editor" });
  const first = apply("alice", cmd);
  const rev = revision(area);
  const state = counts();
  const replay = apply("alice", cmd);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(revision(area), rev);
  assert.deepEqual(counts(), state);
  // The replay is served even though expectedPolicyRevision is now stale.
  assert.equal(apply("alice", cmd).replayed, true);
});

test("a different payload under the same actor, Area and commandId is an idempotency conflict", () => {
  const area = makeArea();
  const cmd = command(area, "add", "dave", { role: "editor" });
  assert.equal(apply("alice", cmd).ok, true);
  const state = counts();
  const rev = revision(area);
  for (const other of [{ role: "viewer" }, { targetUserId: "erin" }, { action: "remove", role: undefined },
    { expectedPolicyRevision: cmd.expectedPolicyRevision + 1 }]) {
    const changed = { ...cmd, ...other };
    if (changed.role === undefined) delete changed.role;
    assert.deepEqual(apply("alice", changed), { ok: false, reason: "idempotency_conflict" });
  }
  assert.equal(revision(area), rev);
  assert.deepEqual(counts(), state);
  assert.equal(role(area, "dave"), "editor");
  assert.equal(role(area, "erin"), null);
});

test("a stale expectedPolicyRevision writes nothing", () => {
  const area = makeArea();
  const state = counts();
  const stale = command(area, "add", "dave", { role: "editor", expectedPolicyRevision: revision(area) - 1 });
  assert.deepEqual(apply("alice", stale), { ok: false, reason: "stale_policy_revision" });
  const future = command(area, "add", "dave", { role: "editor", expectedPolicyRevision: revision(area) + 1 });
  assert.deepEqual(apply("alice", future), { ok: false, reason: "stale_policy_revision" });
  assert.equal(role(area, "dave"), null);
  assert.deepEqual(counts(), state);
  // A refused command is not receipted: the same commandId may be retried with a fresh revision.
  assert.equal(apply("alice", { ...stale, expectedPolicyRevision: revision(area) }).ok, true);
});

test("same-role set_role is a receipted no-op: no audit row and no revision bump", () => {
  const area = makeArea();
  const rev = revision(area);
  const state = counts();
  const cmd = command(area, "set_role", "bob", { role: "editor" });
  assert.deepEqual(apply("alice", cmd), { ok: true, outcome: "noop", policyRevision: rev, unassignedTasks: 0 });
  assert.equal(revision(area), rev);
  assert.deepEqual(counts(), { receipts: state.receipts + 1, audit: state.audit });
  assert.deepEqual(apply("alice", cmd), { ok: true, outcome: "noop", policyRevision: rev, unassignedTasks: 0, replayed: true });
  // A no-op still honours the revision CAS.
  assert.equal(apply("alice", { ...cmd, commandId: randomUUID(), expectedPolicyRevision: rev + 5 }).reason, "stale_policy_revision");
});

test("non-admins, unknown Areas and private Areas receive the same indistinguishable denial", () => {
  const area = makeArea({ bob: "editor", carol: "viewer", erin: "admin" });
  const state = counts();
  const rev = revision(area);
  const denial = { ok: false, reason: "unavailable" };
  assert.deepEqual(apply("bob", command(area, "add", "dave")), denial);
  assert.deepEqual(apply("carol", command(area, "add", "dave")), denial);
  assert.deepEqual(apply("dave", command(area, "add", "dave")), denial);
  assert.deepEqual(apply("alice", { ...command(area, "add", "dave"), areaId: "no-such-area" }), denial);
  assert.deepEqual(apply("alice", { ...command(area, "add", "dave"), areaId: stage.unassignedAreaId }), denial);
  assert.deepEqual(apply("alice", { ...command(area, "add", "dave"), areaId: "private-bob" }), denial);
  assert.deepEqual(apply("bob", { ...command(area, "add", "dave"), areaId: "private-bob" }), denial);
  assert.equal(role(area, "dave"), null);
  assert.equal(revision(area), rev);
  assert.deepEqual(counts(), state);
  // Another current admin of this Area is authorized.
  assert.equal(apply("erin", command(area, "add", "dave", { role: "viewer" })).ok, true);
});

test("an admin who loses admin cannot replay a stored receipt", () => {
  const area = makeArea({ erin: "admin" });
  const cmd = command(area, "add", "dave", { role: "viewer" });
  assert.equal(apply("erin", cmd).ok, true);
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id=? AND user_id='erin'").run(area);
  assert.deepEqual(apply("erin", cmd), { ok: false, reason: "unavailable" });
});

test("target identity must exist, have a personal workspace and fit the action", () => {
  const area = makeArea();
  const state = counts();
  assert.equal(apply("alice", command(area, "add", "nobody")).reason, "unavailable");
  assert.equal(apply("alice", command(area, "add", "bob")).reason, "already_member");
  assert.equal(apply("alice", command(area, "remove", "dave")).reason, "unavailable");
  assert.equal(apply("alice", command(area, "set_role", "dave")).reason, "unavailable");
  assert.deepEqual(counts(), state);
});

test("invalid commands are rejected before any store access", () => {
  const area = makeArea();
  const good = command(area, "add", "dave");
  for (const bad of [
    { ...good, commandId: "nope" }, { ...good, action: "promote" }, { ...good, role: "owner" },
    { ...good, role: undefined }, { ...command(area, "remove", "bob"), role: "viewer" },
    { ...good, expectedPolicyRevision: -1 }, { ...good, expectedPolicyRevision: 1.5 },
    { ...good, expectedPolicyRevision: "0" }, { ...good, targetUserId: "" },
    { ...good, actorUserId: "alice" }, { ...good, areaId: "a b" },
  ]) assert.deepEqual(apply("alice", bad), { ok: false, reason: "invalid_request" });
});

test("the last admin cannot be removed or demoted; with a second admin it can", () => {
  const area = makeArea({ bob: "admin" });
  // Alice is one of two admins: demote alice (allowed), then bob is the last admin.
  assert.equal(apply("alice", command(area, "set_role", "alice", { role: "editor" })).ok, true);
  const state = counts();
  const rev = revision(area);
  // Alice is no longer admin; bob is the only one.
  assert.equal(apply("bob", command(area, "remove", "bob")).reason, "last_admin");
  assert.equal(apply("bob", command(area, "set_role", "bob", { role: "viewer" })).reason, "last_admin");
  assert.equal(apply("bob", command(area, "set_role", "bob", { role: "editor" })).reason, "last_admin");
  assert.equal(role(area, "bob"), "admin");
  assert.equal(revision(area), rev);
  assert.deepEqual(counts(), state);
  // Handover first, then the former last admin may leave.
  assert.equal(apply("bob", command(area, "set_role", "alice", { role: "admin" })).ok, true);
  assert.equal(apply("bob", command(area, "remove", "bob")).ok, true);
  assert.equal(role(area, "bob"), null);
  assert.equal(inspectIsolatedTargetStore({ stagingDirectory: stage.directory, mode: "r2-model" }).ok, true);
});

test("raw SQL cannot leave a shared Area without an admin", () => {
  const area = makeArea({ bob: "editor" });
  const rev = revision(area);
  assert.throws(() => db.prepare("DELETE FROM area_members WHERE area_id=? AND user_id='alice'").run(area),
    /at least one admin/);
  assert.throws(() => db.prepare("UPDATE area_members SET role='editor' WHERE area_id=? AND user_id='alice'").run(area),
    /at least one admin/);
  assert.throws(() => db.prepare("UPDATE area_members SET role='viewer' WHERE area_id=? AND user_id='alice'").run(area),
    /at least one admin|unassign/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO area_members(area_id,user_id,role) VALUES (?, 'alice', 'viewer')").run(area),
    /at least one admin/);
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO area_members(area_id,user_id,role) VALUES (?, 'alice', 'editor')").run(area),
    /at least one admin/);
  assert.equal(role(area, "alice"), "admin");
  assert.equal(revision(area), rev);
  // A replacement that keeps the admin role is harmless.
  db.prepare("INSERT OR REPLACE INTO area_members(area_id,user_id,role) VALUES (?, 'alice', 'admin')").run(area);
  assert.equal(role(area, "alice"), "admin");
});

test("remove and demotion to viewer unassign the user's tasks atomically; policy bumps exactly once", () => {
  const area = makeArea({ bob: "editor", carol: "editor", erin: "admin" });
  const other = makeArea({ bob: "editor" });
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES (?,?,'Project')").run(`proj-${area}`, area);
  assign(`${area}-t1`, area, "bob");
  assign(`${area}-t2`, area, "bob");
  assign(`${area}-t3`, area, "bob", `proj-${area}`);
  assign(`${area}-c1`, area, "carol");
  assign(`${other}-t1`, other, "bob");
  const rev = revision(area);
  const t1 = taskRevision(`${area}-t1`);

  // Reassignment alone never touches policy_revision.
  db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id=?").run(`${area}-c1`);
  db.prepare("UPDATE tasks SET assignee_user_id='carol' WHERE id=?").run(`${area}-c1`);
  assert.equal(revision(area), rev);

  // Editor -> viewer demotion.
  const demoted = apply("alice", command(area, "set_role", "bob", { role: "viewer" }));
  assert.deepEqual(demoted, { ok: true, outcome: "applied", policyRevision: rev + 1, unassignedTasks: 3 });
  for (const id of ["t1", "t2", "t3"]) assert.equal(assignee(`${area}-${id}`), null);
  assert.equal(taskRevision(`${area}-t1`), t1 + 1);
  assert.equal(assignee(`${area}-c1`), "carol");
  assert.equal(assignee(`${other}-t1`), "bob", "tasks in other Areas keep their assignee");
  assert.equal(revision(area), rev + 1);
  assert.equal(role(area, "bob"), "viewer");

  // Removal.
  const t4 = `${area}-c2`;
  assign(t4, area, "carol");
  const removed = apply("erin", command(area, "remove", "carol"));
  assert.equal(removed.unassignedTasks, 2);
  assert.equal(assignee(`${area}-c1`), null);
  assert.equal(assignee(t4), null);
  assert.equal(role(area, "carol"), null);
  assert.equal(revision(area), rev + 2);
});

test("admin to editor keeps assignments; admin to viewer unassigns them", () => {
  const area = makeArea({ bob: "admin" });
  assign(`${area}-b1`, area, "bob");
  const rev = revision(area);
  const keep = apply("alice", command(area, "set_role", "bob", { role: "editor" }));
  assert.equal(keep.unassignedTasks, 0);
  assert.equal(assignee(`${area}-b1`), "bob");
  const drop = apply("alice", command(area, "set_role", "bob", { role: "viewer" }));
  assert.equal(drop.unassignedTasks, 1);
  assert.equal(assignee(`${area}-b1`), null);
  assert.equal(revision(area), rev + 2);
});

test("a failure after unassignment rolls back tasks, membership, receipt and audit together", () => {
  const area = makeArea({ bob: "editor" });
  assign(`${area}-r1`, area, "bob");
  // Exhaust the AUTOINCREMENT sequence so the audit INSERT (the last write) fails
  // after tasks, membership and receipt were already written in the transaction.
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='area_membership_audit'").get().seq;
  db.exec("UPDATE sqlite_sequence SET seq=9223372036854775807 WHERE name='area_membership_audit'");
  try {
    const state = counts();
    const rev = revision(area);
    assert.deepEqual(apply("alice", command(area, "remove", "bob")), { ok: false, reason: "write_failed" });
    assert.equal(assignee(`${area}-r1`), "bob");
    assert.equal(role(area, "bob"), "editor");
    assert.equal(revision(area), rev);
    assert.deepEqual(counts(), state);
  } finally { db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='area_membership_audit'").run(seq); }
  assert.equal(apply("alice", command(area, "remove", "bob")).unassignedTasks, 1);
});

test("receipts and audit are append-only inside the retention window", () => {
  const area = makeArea();
  assert.equal(apply("alice", command(area, "add", "dave", { role: "viewer" })).ok, true);
  assert.throws(() => db.exec("UPDATE area_membership_audit SET role_after='admin'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM area_membership_audit"), /retention/);
  assert.throws(() => db.exec("UPDATE area_membership_receipts SET outcome='noop'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM area_membership_receipts"), /retention/);
  const key = db.prepare("SELECT receipt_key FROM area_membership_receipts LIMIT 1").get().receipt_key;
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO area_membership_receipts(
    receipt_key,payload_digest,outcome,policy_revision,unassigned_tasks,committed_at_ms)
    VALUES (?, ?, 'noop', 0, 0, 1)`).run(key, "a".repeat(64)), /replacement/);
});

test("two processes racing with the same expected revision cannot both succeed", async () => {
  const area = makeArea({});
  const expected = revision(area);
  const loader = path.resolve("scripts/target-staging-ts-loader.mjs");
  const run = target => new Promise(resolve => {
    const child = spawn(process.execPath, ["--experimental-loader", loader,
      path.resolve("scripts/target-staging-membership-write-child.mjs")], {
      cwd: path.resolve("."), stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, AI_EXECUTIVE_TARGET_STAGING_SESSION_HASH: "" },
    });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("close", () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    child.stdin.end(JSON.stringify({ commandId: randomUUID(), areaId: area,
      expectedPolicyRevision: expected, action: "add", targetUserId: target, role: "editor" }));
  });
  const results = await Promise.all([run("bob"), run("carol")]);
  const wins = results.filter(result => result?.ok === true);
  assert.equal(wins.length, 1, JSON.stringify(results));
  const loser = results.find(result => result?.ok !== true);
  assert.ok(loser === null || ["stale_policy_revision", "write_failed"].includes(loser.reason), JSON.stringify(loser));
  assert.equal(revision(area), expected + 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM area_members WHERE area_id=? AND user_id IN ('bob','carol')").get(area).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM area_membership_audit WHERE area_id=?").get(area).n, 1);
});

test("a revoked durable session cannot apply a command and nothing is written", () => {
  const area = makeArea({ bob: "admin" });
  const issued = durable.issueDurableTargetStagingSession(store, "bob", 600);
  assert.equal(issued.ok, true);
  const hash = durable.hashTargetStagingSessionToken(issued.sessionToken);
  assert.equal(apply("bob", command(area, "add", "dave", { role: "viewer" }), hash).ok, true);
  assert.equal(durable.revokeDurableTargetStagingSession(store, issued.sessionId).ok, true);
  const state = counts();
  const rev = revision(area);
  assert.deepEqual(apply("bob", command(area, "add", "erin", { role: "viewer" }), hash),
    { ok: false, reason: "session_revoked" });
  assert.equal(role(area, "erin"), null);
  assert.equal(revision(area), rev);
  assert.deepEqual(counts(), state);
  // A session belonging to a different user cannot be borrowed.
  const other = durable.issueDurableTargetStagingSession(store, "carol", 600);
  const otherHash = durable.hashTargetStagingSessionToken(other.sessionToken);
  assert.deepEqual(apply("bob", command(area, "add", "erin", { role: "viewer" }), otherHash),
    { ok: false, reason: "session_revoked" });
  assert.deepEqual(apply("bob", command(area, "add", "erin", { role: "viewer" }), "not-a-hash"),
    { ok: false, reason: "unauthenticated" });
  assert.deepEqual(authority.applyMembershipCommand("garbage", command(area, "add", "erin")),
    { ok: false, reason: "unauthenticated" });
});

// ---------------------------------------------------------------- HTTP
const ownerCookie = `${sessionCookieName}=${createSessionToken()}`;
const sessionCookie = token => `${durable.TARGET_STAGING_SESSION_COOKIE}=${token}`;
let client = 0;
const post = (areaId, body, options = {}) => POST(new Request(
  `http://localhost:3001/api/target-staging/areas/${areaId}/members${options.query || ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": options.client || `10.7.${Math.floor(client / 250)}.${client % 250 + 1}`,
      ...(options.origin === null ? {} : { origin: options.origin || "http://localhost:3001" }),
      ...(options.cookie === null ? {} : { cookie: options.cookie || ownerCookie }),
    },
    body: options.raw ?? JSON.stringify(body),
  }), { params: Promise.resolve({ areaId }) });
const body = (area, action, targetUserId, extra = {}) => {
  const { areaId, ...rest } = command(area, action, targetUserId, extra);
  return rest;
};

test("HTTP: owner cookie maps to the configured owner; success, replay and status codes", async () => {
  client++;
  const area = makeArea();
  const rev = revision(area);
  const input = body(area, "add", "dave", { role: "viewer" });
  const ok = await post(area, input);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.deepEqual(await ok.json(), { ok: true, outcome: "applied", policyRevision: rev + 1, unassignedTasks: 0 });
  assert.equal(role(area, "dave"), "viewer");
  const replay = await post(area, input);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ok: true, outcome: "applied", policyRevision: rev + 1, unassignedTasks: 0, replayed: true });
  assert.equal(revision(area), rev + 1);

  const conflict = await post(area, { ...input, role: "editor" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "idempotency_conflict");
  const stale = await post(area, { ...body(area, "set_role", "dave", { role: "editor" }), expectedPolicyRevision: rev });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "stale_policy_revision");
  const noop = await post(area, body(area, "set_role", "dave", { role: "viewer" }));
  assert.equal(noop.status, 200);
  assert.equal((await noop.json()).outcome, "noop");
  const already = await post(area, body(area, "add", "bob"));
  assert.equal(already.status, 409);
  assert.equal((await already.json()).code, "already_member");
  assert.equal(role(area, "dave"), "viewer");
});

test("HTTP: last admin refusal is 422 last_admin; denials are indistinguishable 404", async () => {
  client++;
  const area = makeArea({ bob: "editor" });
  const refused = await post(area, body(area, "remove", "alice"));
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { error: "A shared Area needs at least one admin", code: "last_admin" });
  assert.equal(role(area, "alice"), "admin");
  const bob = durable.issueDurableTargetStagingSession(store, "bob", 600);
  const bobCookie = sessionCookie(bob.sessionToken);
  const denials = [];
  for (const [id, cookie, target] of [
    [area, bobCookie, "dave"], ["missing-area", ownerCookie, "dave"],
    [stage.unassignedAreaId, ownerCookie, "dave"], [area, ownerCookie, "nobody"],
  ]) {
    const response = await post(id, body(area, "add", target), { cookie });
    denials.push([response.status, await response.json()]);
  }
  assert.deepEqual(denials, Array(4).fill([404, { error: "Not found" }]));
  assert.equal(role(area, "dave"), null);
});

test("HTTP: a durable session admin acts as itself; a revoked session gets 401 with no write", async () => {
  client++;
  const area = makeArea({ bob: "admin" });
  const bob = durable.issueDurableTargetStagingSession(store, "bob", 600);
  const cookie = sessionCookie(bob.sessionToken);
  assert.equal((await post(area, body(area, "add", "dave", { role: "viewer" }), { cookie })).status, 200);
  assert.equal(db.prepare("SELECT actor_user_id AS a FROM area_membership_audit WHERE area_id=?").get(area).a, "bob");
  durable.revokeDurableTargetStagingSession(store, bob.sessionId);
  const state = counts();
  const rev = revision(area);
  const refused = await post(area, body(area, "add", "erin", { role: "viewer" }), { cookie });
  assert.equal(refused.status, 401);
  assert.equal(role(area, "erin"), null);
  assert.equal(revision(area), rev);
  assert.deepEqual(counts(), state);
});

test("HTTP: flag, auth, Origin, query and body gates refuse before any write", async () => {
  client++;
  const area = makeArea();
  const input = body(area, "add", "dave", { role: "viewer" });
  const state = counts();
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "false";
  assert.equal((await post(area, input)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";
  assert.equal((await post(area, input, { cookie: null })).status, 401);
  assert.equal((await post(area, input, { origin: null })).status, 403);
  assert.equal((await post(area, input, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(area, input, { query: "?role=admin" })).status, 400);
  assert.equal((await post(area, { ...input, actorUserId: "alice" })).status, 400);
  assert.equal((await post(area, { ...input, areaId: area })).status, 400);
  assert.equal((await post(area, { ...input, role: undefined })).status, 400);
  assert.equal((await post(area, { ...body(area, "remove", "bob"), role: "viewer" })).status, 400);
  assert.equal((await post(area, { ...input, expectedPolicyRevision: "1" })).status, 400);
  assert.equal((await post(area, [input])).status, 400);
  assert.equal((await post(area, null, { raw: Buffer.alloc(8 * 1024 + 1, 0x20) })).status, 413);
  assert.equal((await post("bad id", input)).status, 400);
  assert.equal(role(area, "dave"), null);
  assert.deepEqual(counts(), state);
});

test("HTTP: a forged-cookie flood gets 401, never 429, and does not drain the route budget", async () => {
  client++;
  const flooder = "10.8.0.1";
  const area = makeArea();
  const forged = sessionCookie("C".repeat(43));
  const input = body(area, "add", "dave", { role: "viewer" });
  for (let index = 0; index < 40; index++) {
    const response = await post(area, input, { cookie: forged, client: flooder });
    assert.equal(response.status, 401);
  }
  const legit = await post(area, input, { cookie: ownerCookie, client: flooder });
  assert.equal(legit.status, 200);
  assert.equal(role(area, "dave"), "viewer");
});

test("audit CHECK constraints tie action to role_before / role_after", () => {
  const area = makeArea();
  const insert = (action, before, after, n) => db.prepare(`INSERT INTO area_membership_receipts(
    receipt_key,payload_digest,outcome,policy_revision,unassigned_tasks,committed_at_ms)
    VALUES (?,?, 'applied', 1, 0, ?)`).run(String(n).padStart(64, "0"), "b".repeat(64), Date.now()) &&
    db.prepare(`INSERT INTO area_membership_audit(receipt_key,actor_user_id,area_id,target_user_id,action,
      role_before,role_after,policy_revision_before,policy_revision_after,restore_generation,committed_at_ms)
      VALUES (?, 'alice', ?, 'bob', ?, ?, ?, 0, 1, ?, ?)`)
      .run(String(n).padStart(64, "0"), area, action, before, after, stage.restoreGeneration, Date.now());
  const bad = [["add", "viewer", "editor"], ["add", null, null], ["remove", null, null],
    ["remove", "viewer", "editor"], ["set_role", null, "editor"], ["set_role", "editor", null],
    ["set_role", "editor", "editor"]];
  // Each rejected insert rolls back its receipt in a savepoint-free way: use a transaction.
  bad.forEach(([action, before, after], index) => {
    db.exec("BEGIN");
    try { assert.throws(() => insert(action, before, after, 9000 + index), /CHECK/); }
    finally { db.exec("ROLLBACK"); }
  });
  db.exec("BEGIN");
  try { insert("set_role", "viewer", "editor", 9100); } finally { db.exec("ROLLBACK"); }
});

test("HTTP: an admin who lost admin gets the same denial on exact replay as the command level", async () => {
  client++;
  const area = makeArea({ erin: "admin" });
  const erin = durable.issueDurableTargetStagingSession(store, "erin", 600);
  const cookie = sessionCookie(erin.sessionToken);
  const input = body(area, "add", "dave", { role: "viewer" });
  assert.equal((await post(area, input, { cookie })).status, 200);
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id=? AND user_id='erin'").run(area);
  const state = counts();
  const replay = await post(area, input, { cookie });
  assert.equal(replay.status, 404);
  assert.deepEqual(await replay.json(), { error: "Not found" });
  assert.deepEqual(counts(), state);
});

test("HTTP: store integrity loss maps to 503 (not 401)", async () => {
  client++;
  const area = makeArea();
  const state = counts();
  db.exec("CREATE TRIGGER integrity_probe BEFORE DELETE ON identities BEGIN SELECT 1; END");
  try {
    const response = await post(area, body(area, "add", "dave", { role: "viewer" }));
    assert.equal(response.status, 503);
  } finally { db.exec("DROP TRIGGER integrity_probe"); }
  assert.deepEqual(counts(), state);
  assert.equal(role(area, "dave"), null);
});

test("explicit-rowid REPLACE cannot delete a row behind the DELETE/immutability triggers", () => {
  const area = makeArea({ bob: "editor" });
  const rev = revision(area);
  // Rowid-less tables expose no rowid at all, so the bypass cannot even be expressed.
  for (const sql of [
    "INSERT OR REPLACE INTO area_members(rowid,area_id,user_id,role) VALUES (1,?, 'bob', 'editor')",
    "INSERT OR REPLACE INTO identities(rowid,id) VALUES (1, 'rowid-x')",
    "INSERT OR REPLACE INTO workspaces(rowid,id,kind,owner_user_id) VALUES (1, 'rowid-w', 'shared', 'alice')",
    "INSERT OR REPLACE INTO areas(rowid,id,title,kind,workspace_id,owner_user_id) VALUES (1,'rowid-a','T','shared','rowid-w','alice')",
    "INSERT OR REPLACE INTO metadata(rowid,key,value) VALUES (1, 'rowid-k', 'v')",
  ]) {
    assert.throws(() => db.prepare(sql).run(...(sql.includes("?") ? [area] : [])), /rowid/i, sql);
  }
  assert.equal(role(area, "alice"), "admin");
  assert.equal(role(area, "bob"), "editor");
  assert.equal(revision(area), rev);
  // tasks keeps a rowid for the read model's tie-break: an explicit colliding rowid is rejected.
  const first = `${area}-rw1`;
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,'one')").run(first, area);
  const rowid = db.prepare("SELECT rowid AS r FROM tasks WHERE id=?").get(first).r;
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO tasks(rowid,id,area_id,title) VALUES (?,?,?,'two')")
    .run(rowid, `${area}-rw2`, area), /task replacement is not allowed/);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(first).title, "one");
  // Same-ID REPLACE through the primary key is still rejected.
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO tasks(id,area_id,title) VALUES (?,?,'again')")
    .run(first, area), /task replacement is not allowed/);
  // The rowid cannot be rewritten to evict another task (UPDATE OR REPLACE / plain UPDATE).
  const second = `${area}-rw3`;
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,'three')").run(second, area);
  for (const verb of ["UPDATE OR REPLACE", "UPDATE"]) {
    assert.throws(() => db.prepare(`${verb} tasks SET rowid=? WHERE id=?`).run(rowid, second), /rowid is immutable/);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id IN (?,?)").get(first, second).n, 2);
  // Explicit rowid <= 0 is rejected and does not poison later automatic inserts.
  for (const bad of [-1, 0]) {
    assert.throws(() => db.prepare("INSERT INTO tasks(rowid,id,area_id,title) VALUES (?,?,?,'neg')")
      .run(bad, `${area}-neg${bad}`, area), /rowid must be positive/);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE ?").get(`${area}-neg%`).n, 0);
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,'after')").run(`${area}-after1`, area);
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,'after')").run(`${area}-after2`, area);
  // The membership audit is INTEGER PRIMARY KEY (rowid alias) with an id/key replace guard.
  assert.equal(apply("alice", command(area, "add", "dave", { role: "viewer" })).ok, true);
  const audit = db.prepare("SELECT id, receipt_key FROM area_membership_audit ORDER BY id DESC LIMIT 1").get();
  assert.throws(() => db.prepare(`INSERT OR REPLACE INTO area_membership_audit(id,receipt_key,actor_user_id,area_id,
    target_user_id,action,role_before,role_after,policy_revision_before,policy_revision_after,restore_generation,committed_at_ms)
    VALUES (?, ?, 'alice', ?, 'bob', 'add', NULL, 'viewer', 0, 1, ?, 1)`)
    .run(audit.id, audit.receipt_key, area, stage.restoreGeneration), /replacement/);
  assert.equal(role(area, "alice"), "admin");
});

test("task rowid guards: transactional, multi-row and upsert inserts, and ordinary updates", () => {
  const area = makeArea({ bob: "editor" });
  const ids = prefix => db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE ?").get(`${area}-${prefix}%`).n;
  const insert = "INSERT INTO tasks(rowid,id,area_id,title) VALUES (?,?,?,'x')";
  // (a) a valid task earlier in the transaction still commits; the -1 row never exists.
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,'ok')").run(`${area}-a-ok`, area);
    assert.throws(() => db.prepare(insert).run(-1, `${area}-a-neg`, area), /rowid must be positive/);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  assert.equal(ids("a-ok"), 1);
  assert.equal(ids("a-neg"), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE rowid <= 0").get().n, 0);
  // (b) one bad row rejects the whole multi-row statement.
  assert.throws(() => db.prepare(`INSERT INTO tasks(rowid,id,area_id,title) VALUES
    (NULL,?,?, 'm1'), (0,?,?, 'm2')`).run(`${area}-b1`, area, `${area}-b2`, area), /rowid must be positive/);
  assert.equal(ids("b"), 0);
  // (c) upsert forms with a negative rowid are rejected too.
  for (const tail of ["ON CONFLICT DO NOTHING", "ON CONFLICT(id) DO UPDATE SET title='u'"]) {
    assert.throws(() => db.prepare(`${insert} ${tail}`).run(-5, `${area}-c`, area), /rowid must be positive/);
  }
  assert.equal(ids("c"), 0);
  // (d) an ordinary update that does not touch the rowid succeeds and bumps the revision once.
  const before = taskRevision(`${area}-a-ok`);
  db.prepare("UPDATE tasks SET title='renamed' WHERE id=?").run(`${area}-a-ok`);
  assert.equal(taskRevision(`${area}-a-ok`), before + 1);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id=?").get(`${area}-a-ok`).title, "renamed");
});
