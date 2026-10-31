import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// R2c.5a integration: the sync client (fetch transport + memory storage) against the REAL staging route handlers,
// real durable sessions, a real store and the real operator restore. Synthetic temp stores only.
const root = mkdtempSync(path.join(os.tmpdir(), "lumi-r2c5a-"));
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
process.env.AI_EXECUTIVE_PASSWORD_HASH = "scrypt:" + Buffer.alloc(16, 1).toString("base64url") + ":" + Buffer.alloc(64, 2).toString("base64url");
process.env.AI_EXECUTIVE_SESSION_SECRET = "synthetic-r2c5a-session-secret-2026-10-31";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = "true";
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = "true";

const { bootstrapIsolatedTargetStore } = await import("../lib/target-store-bootstrap.ts");
const durable = await import("../lib/target-staging-durable-session.ts");
const restoreLib = await import("../lib/target-staging-restore.ts");
const { TargetStagingSessionAuthority } = await import("../lib/target-staging-session-authority.ts");
const { GET: TITLE_GET, PATCH: TITLE_PATCH } = await import("../app/api/target-staging/tasks/[taskId]/title/route.ts");
const { POST: TITLE_STATUS } = await import("../app/api/target-staging/tasks/[taskId]/title/status/route.ts");
const { POST: DELETE_TASK } = await import("../app/api/target-staging/tasks/[taskId]/delete/route.ts");
const { POST: DELETE_STATUS } = await import("../app/api/target-staging/tasks/[taskId]/delete/status/route.ts");
const { GET: FEED } = await import("../app/api/target-staging/changes/route.ts");
const { createFetchTransport } = await import("../lib/target-sync/fetch-transport.ts");
const { TargetSyncClient } = await import("../lib/target-sync/client.ts");
const { MemoryTargetSyncStorage } = await import("../lib/target-sync/memory-storage.ts");
const { FakeScheduler } = await import("../lib/target-sync/fake.ts");

const authorities = [];
const raws = [];
after(() => {
  for (const authority of authorities) authority.close();
  for (const raw of raws) { try { raw.close(); } catch { /* closed */ } }
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const ORIGIN = "http://localhost:3001";
const BASE = `${ORIGIN}/api/target-staging`;
let counter = 0;
let ip = 0;
const addIdentity = (db, user) => {
  db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)").run(`${user}-personal`, user);
  db.prepare(`INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key)
    VALUES (?, ?, 'private', ?, ?, 'unassigned')`).run(`${user}-private`, `${user} private`, `${user}-personal`, user);
};
/** alice (owner, admin), bob + carol editors of team-area with tasks t1..t3. */
function makeFixture() {
  const name = `fx${++counter}`;
  const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, name), ownerUserId: "alice" });
  const db = new DatabaseSync(stage.databasePath);
  raws.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const user of ["bob", "carol"]) addIdentity(db, user);
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for (const [user, role] of [["alice", "admin"], ["bob", "editor"], ["carol", "editor"]]) {
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(user, role);
  }
  for (const id of ["t1", "t2", "t3"]) db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)").run(id, "team-area", `Task ${id}`);
  const fx = { name, stage, db, databasePath: stage.databasePath, store: null, authority: null };
  useStore(fx, stage.restoreGeneration);
  return fx;
}
function useStore(fx, generation) {
  fx.stage = { ...fx.stage, restoreGeneration: generation };
  fx.store = { stagingDirectory: fx.stage.directory, expectedRestoreGeneration: generation };
  if (fx.authority) fx.authority.close();
  fx.authority = new TargetStagingSessionAuthority(fx.store);
  authorities.push(fx.authority);
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = fx.stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = generation;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = "alice";
}
const issue = (fx, user) => {
  const result = durable.issueDurableTargetStagingSession(fx.store, user, 900);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const titleOf = (fx, id) => fx.db.prepare("SELECT title FROM tasks WHERE id=?").get(id)?.title;
const removeBob = fx => {
  const policy = fx.db.prepare("SELECT policy_revision AS r FROM areas WHERE id='team-area'").get().r;
  const result = fx.authority.applyMembershipCommand(fx.authority.issueWritable("alice").sessionToken, { commandId: randomUUID(),
    areaId: "team-area", expectedPolicyRevision: policy, writeAreaId: "team-area", restoreGeneration: fx.stage.restoreGeneration,
    action: "remove", targetUserId: "bob" });
  assert.equal(result.ok, true, JSON.stringify(result));
};

/** `fetch` which calls the route handlers in-process with the headers a browser would send. */
function routerFetch(holder, log) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    log.push(`${method} ${url.pathname}${url.search ? "?" : ""}`);
    const headers = { origin: ORIGIN, "x-forwarded-for": `10.9.${Math.floor(++ip / 250)}.${ip % 250 + 1}`, ...(init.headers ?? {}),
      ...(holder.cookie ? { cookie: holder.cookie } : {}) };
    const request = new Request(url, { method, headers, ...(init.body ? { body: init.body } : {}) });
    const rest = url.pathname.slice("/api/target-staging/".length);
    if (rest === "changes") return FEED(request);
    const match = /^tasks\/([^/]+)\/(title\/status|title|delete\/status|delete)$/.exec(rest);
    assert.ok(match, `unrouted ${rest}`);
    const context = { params: Promise.resolve({ taskId: decodeURIComponent(match[1]) }) };
    const handlers = { title: { GET: TITLE_GET, PATCH: TITLE_PATCH }, "title/status": { POST: TITLE_STATUS },
      delete: { POST: DELETE_TASK }, "delete/status": { POST: DELETE_STATUS } };
    const handler = handlers[match[2]][method];
    assert.ok(handler, `no handler for ${method} ${rest}`);
    return handler(request, context);
  };
}
function makeClient(fx, userId, options = {}) {
  const holder = { cookie: null };
  const session = options.session ?? issue(fx, userId);
  holder.cookie = `${durable.TARGET_STAGING_SESSION_COOKIE}=${session.sessionToken}`;
  const log = [];
  const storage = options.storage ?? new MemoryTargetSyncStorage();
  const scheduler = new FakeScheduler();
  const transport = createFetchTransport({ fetch: routerFetch(holder, log), baseUrl: BASE });
  const client = new TargetSyncClient({ storage, transport: options.wrap ? options.wrap(transport) : transport, scheduler, autoRun: false });
  const events = [];
  client.on(event => events.push(event));
  return { client, storage, scheduler, events, holder, log, userId,
    login() { holder.cookie = `${durable.TARGET_STAGING_SESSION_COOKIE}=${issue(fx, userId).sessionToken}`; } };
}
const unwrap = readable => { assert.equal(readable.locked, false, JSON.stringify(readable)); return readable.value; };
const drafts = async client => Object.fromEntries(unwrap(await client.listDrafts()).map(d => [d.taskId, d]));

test("real routes: two clients of one identity change the same task, exactly one write succeeds, the other gets 409 and keeps its draft", async () => {
  const fx = makeFixture();
  const a = makeClient(fx, "bob");
  const b = makeClient(fx, "bob");
  await a.client.activate({ userId: "bob" });
  await b.client.activate({ userId: "bob" });
  assert.equal((await a.client.sync()).status, "idle");
  assert.equal((await b.client.sync()).status, "idle");
  assert.deepEqual(unwrap(await a.client.listItems()).map(item => item.id).sort(), ["t1", "t2", "t3"]);
  assert.equal((await a.client.editTitle("t1", "from A")).ok, true);
  assert.equal((await b.client.editTitle("t1", "from B")).ok, true);
  const [ra, rb] = [await a.client.pump(), await b.client.pump()];
  assert.equal(ra.done + rb.done, 1);
  assert.equal(ra.conflicts + rb.conflicts, 1);
  const winner = ra.done === 1 ? "from A" : "from B";
  assert.equal(titleOf(fx, "t1"), winner);
  const loser = ra.conflicts === 1 ? a : b;
  const draft = (await drafts(loser.client)).t1;
  assert.equal(draft.status, "conflict");
  assert.notEqual(draft.title, winner);
  assert.equal(loser.events.filter(event => event.type === "conflict").length, 1);
  // Reload, then an explicit rebase wins on top of the new state.
  const reloaded = unwrap(await loser.client.reloadTask("t1"));
  assert.equal(reloaded.item.title, winner);
  assert.equal((await loser.client.resubmitDraft("t1")).ok, true);
  assert.equal((await loser.client.pump()).done, 1);
  assert.equal(titleOf(fx, "t1"), draft.title);
});

test("real routes: a lost response is resolved by the status endpoint (no second write); delete produces a tombstone the feed delivers", async () => {
  const fx = makeFixture();
  const lossy = transport => ({ ...transport, sendTitle: async request => { const real = await transport.sendTitle(request); void real; return { kind: "uncertain", reason: "timeout" }; } });
  const a = makeClient(fx, "bob", { wrap: lossy });
  await a.client.activate({ userId: "bob" });
  await a.client.sync();
  await a.client.editTitle("t2", "committed, answer lost");
  assert.equal((await a.client.pump()).status, "backoff");
  assert.equal(titleOf(fx, "t2"), "committed, answer lost");
  await a.scheduler.advance(120_000);
  const result = await a.client.pump();
  assert.equal(result.status, "idle");
  assert.equal(a.log.filter(line => line.startsWith("PATCH")).length, 1, "one PATCH only");
  assert.equal(a.log.filter(line => line.endsWith("/title/status")).length, 1);
  assert.deepEqual(await drafts(a.client), {});
  await a.client.deleteTask("t3");
  assert.equal((await a.client.pump()).done, 1);
  assert.equal(fx.db.prepare("SELECT 1 FROM tasks WHERE id='t3'").get(), undefined);
  assert.equal((await a.client.sync()).status, "idle");
  assert.equal(unwrap(await a.client.isTombstoned("t3")), true);
  assert.deepEqual(unwrap(await a.client.listItems()).map(item => item.id).sort(), ["t1", "t2"]);
});

test("real restore: the backup is restored, the old session gets session_restored, queued changes come back only as local drafts, nothing is sent", async () => {
  const fx = makeFixture();
  const backup = path.join(root, `${fx.name}.backup.sqlite`);
  copyFileSync(fx.databasePath, backup);
  const bob = makeClient(fx, "bob");
  const carol = makeClient(fx, "carol");
  await bob.client.activate({ userId: "bob" });
  await carol.client.activate({ userId: "carol" });
  await bob.client.sync();
  await carol.client.sync();
  for (const id of ["t1", "t2", "t3"]) assert.equal((await bob.client.editTitle(id, `${id} by bob offline`)).ok, true);
  assert.equal((await carol.client.editTitle("t1", "carol pending")).ok, true);
  const generationBefore = fx.stage.restoreGeneration;
  // After the backup: bob is removed from the Area (the restore replays it).
  removeBob(fx);
  // Restore from the backup (a plain file copy first: the store is gated until the operator tool ran).
  raws.splice(raws.indexOf(fx.db), 1);
  fx.db.close();
  copyFileSync(backup, fx.databasePath);
  fx.db = new DatabaseSync(fx.databasePath);
  raws.push(fx.db);
  fx.db.exec("PRAGMA foreign_keys=ON");
  const gated = await bob.client.sync();
  assert.equal(gated.status, "backoff", "503 restore_pending: nothing lost, back off");
  assert.equal(unwrap(await bob.client.pendingCounts()).queued, 3);
  const restored = restoreLib.restoreTargetStagingFromBackup(fx.store, { grantAdmin: [] });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  useStore(fx, restored.restoreGeneration);
  assert.notEqual(restored.restoreGeneration, generationBefore);
  // The restore tool replays the journal: bob's removal is part of the irreversible source.
  assert.equal(fx.db.prepare("SELECT 1 FROM area_members WHERE area_id='team-area' AND user_id='bob'").get(), undefined);
  await bob.scheduler.advance(10 * 60_000);
  const locked = await bob.client.sync();
  assert.equal(locked.status, "locked");
  assert.deepEqual(bob.events.filter(event => event.type === "reauth_required").map(event => event.reason), ["session_restored"]);
  assert.deepEqual(await bob.client.listDrafts(), { locked: true, reason: "restore_pending_reauth" });
  assert.equal(titleOf(fx, "t1"), "Task t1", "nothing was written");
  bob.login();
  await bob.client.activate({ userId: "bob" });
  const outcome = await bob.client.tick();
  assert.equal(outcome.sync.status, "idle", JSON.stringify(outcome));
  const report = bob.events.find(event => event.type === "report" && event.report.kind === "restore").report;
  assert.deepEqual([report.keptAsDrafts, report.removed], [0, 3], "B lost the Area: data and queue gone, 3 reported");
  assert.deepEqual(await drafts(bob.client), {});
  assert.deepEqual(unwrap(await bob.client.listItems()), []);
  for (const id of ["t1", "t2", "t3"]) assert.equal(titleOf(fx, id), `Task ${id}`);
  // Carol still has access: her change comes back as a local draft and nothing is sent automatically.
  assert.equal((await carol.client.tick()).sync.status, "locked", "her old session is session_restored");
  carol.login();
  await carol.client.activate({ userId: "carol" });
  const carolTick = await carol.client.tick();
  assert.equal(carolTick.sync.status, "idle", JSON.stringify(carolTick));
  const carolDrafts = await drafts(carol.client);
  assert.equal(carolDrafts.t1.status, "local");
  assert.equal(carolDrafts.t1.title, "carol pending");
  assert.equal(titleOf(fx, "t1"), "Task t1");
  assert.equal(carol.log.filter(line => line.startsWith("PATCH")).length, 0, "no write request was ever made");
  assert.equal((await carol.client.resubmitDraft("t1")).ok, true);
  assert.equal((await carol.client.pump()).done, 1);
  assert.equal(titleOf(fx, "t1"), "carol pending");
});

test("real routes: a revoked session wipes the namespace and reports the count to the same identity", async () => {
  const fx = makeFixture();
  const session = issue(fx, "carol");
  const carol = makeClient(fx, "carol", { session });
  await carol.client.activate({ userId: "carol" });
  await carol.client.sync();
  await carol.client.editTitle("t1", "pending");
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, session.sessionId).ok, true);
  assert.equal((await carol.client.sync()).status, "signed_out");
  const report = carol.events.find(event => event.type === "report").report;
  assert.deepEqual([report.kind, report.count], ["session_revoked", 1]);
  assert.deepEqual(await carol.storage.listNamespaces(), []);
});
