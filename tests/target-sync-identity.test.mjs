import assert from "node:assert/strict";
import { test } from "node:test";
import {
  G1, G2, MemoryTargetSyncStorage, TargetSyncClient, draftsOf, makeDevice, makeServer, titles, unwrap,
} from "./support/target-sync-harness.mjs";
const G3 = "33333333-3333-4333-8333-333333333333";

// R2c.5a identity binding, 401 handling and the backup-restore flow (acceptance scenarios 2, 3, 4 of R2c.5).

const idle = outcome => assert.equal(outcome.status, "idle", JSON.stringify(outcome));
const three = async device => {
  for (const id of ["t1", "t2", "t3"]) assert.equal((await device.client.editTitle(id, `${id} queued`)).ok, true);
};

// ---------------------------------------------------------------- 401 is not always a revocation
test("session_expired with 3 queued changes: locked, nothing exposed or lost; after re-login of the same identity they are sent and re-authorized", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await three(device);
  server.setSession(device.holder.token, "expired");
  const tick = await device.client.tick();
  assert.equal(tick.sync.status, "locked");
  assert.deepEqual(device.events.map(event => event.type), ["locked", "reauth_required"]);
  assert.ok(device.events.every(event => event.userId === "bob"));
  // Locked: every read and mutation refuses, but the data is still in storage.
  for (const read of [() => device.client.listItems(), () => device.client.listDrafts(), () => device.client.pendingCounts(), () => device.client.getItem("t1")]) {
    assert.deepEqual(await read(), { locked: true, reason: "session_expired" });
  }
  assert.equal((await device.client.editTitle("t1", "x")).reason, "locked");
  assert.equal((await device.client.pump()).status, "locked");
  const stored = Object.values(device.storage.dump())[0];
  assert.equal(Object.keys(stored).filter(key => key.startsWith("draft/")).length, 3);
  assert.equal(Object.keys(stored).filter(key => key.startsWith("cmd/")).length, 3);
  assert.equal(server.writes.length, 0);
  // Re-login of the SAME identity.
  device.relogin();
  await device.client.activate({ userId: "bob" });
  assert.equal(unwrap(await device.client.pendingCounts()).drafts, 3);
  const result = await device.client.tick();
  idle(result.sync);
  assert.equal(result.pump.done, 3);
  assert.equal(server.writes.length, 3);
  for (const id of ["t1", "t2", "t3"]) assert.equal(server.titleOf(id), `${id} queued`);
  assert.deepEqual(await draftsOf(device.client), {});
});

test("a 401 on a write leaves the command uncertain: after re-login the status endpoint is asked before anything is sent", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "maybe committed");
  server.script("sendTitle", { commitThenReturn: { kind: "unauthorized", code: null } }); // owner-cookie post-commit check
  await device.client.pump();
  assert.equal(server.writes.length, 1);
  assert.equal(device.eventsOf("reauth_required")[0].reason, "session_expired", "a 401 without code is treated as expiry");
  device.relogin();
  await device.client.activate({ userId: "bob" });
  await device.client.tick();
  const sends = server.calls.filter(call => call.method === "sendTitle");
  assert.equal(sends.length, 1, "no second send");
  assert.equal(server.calls.filter(call => call.method === "titleStatus").length, 1);
  assert.deepEqual(await draftsOf(device.client), {});
  assert.equal(server.writes.length, 1);
});

test("a 401 without code on the feed keeps the data (conservative), a 401 while editing keeps the edit", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  const good = device.holder.token;
  device.holder.token = "not-a-session"; // code-less 401
  assert.equal((await device.client.sync()).status, "locked");
  device.holder.token = good;
  await device.client.activate({ userId: "bob" });
  assert.equal(Object.keys(await titles(device.client)).length, 3, "data survived");
  server.setSession(good, "expired");
  const edit = await device.client.editTitle("t1", "typed while expired");
  assert.equal(edit.ok, true);
  assert.equal(device.eventsOf("reauth_required").length, 2);
  device.relogin();
  await device.client.activate({ userId: "bob" });
  assert.equal(unwrap(await device.client.pendingCounts()).queued, 1);
  await device.client.tick();
  assert.equal(server.titleOf("t1"), "typed while expired");
});

test("session_revoked wipes the namespace; the unsendable count goes to THIS identity first and never to another", async () => {
  const server = makeServer();
  const device = makeDevice(server, "carol");
  await device.start();
  idle(await device.client.sync());
  // carol is a viewer: queue by hand-made drafts through an editor? use bob's rights is not possible; give carol her own task.
  server.addTask("c1", "carol-private", "carol private");
  server.addTask("c2", "carol-private", "carol private 2");
  idle(await device.client.sync());
  await device.client.editTitle("c1", "mine 1");
  await device.client.editTitle("c2", "mine 2");
  let namespaceStillThereAtReport = null;
  device.client.on(event => { if (event.type === "report") device.storage.listNamespaces().then(names => { namespaceStillThereAtReport = names.length; }); });
  server.setSession(device.holder.token, "revoked");
  const outcome = await device.client.sync();
  assert.equal(outcome.status, "signed_out");
  const reports = device.eventsOf("report");
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0].userId, reports[0].report.kind, reports[0].report.count], ["carol", "session_revoked", 2]);
  assert.equal(namespaceStillThereAtReport, 1, "reported before the delete");
  assert.deepEqual(await device.storage.listNamespaces(), []);
  assert.deepEqual(await device.client.listDrafts(), { locked: false, value: [] });
  // Another identity afterwards learns nothing.
  const before = device.events.length;
  const dave = makeDevice(server, "dave", { storage: device.storage });
  await dave.start();
  assert.equal(device.events.length, before);
  assert.equal(dave.events.length, 0);
});

// ---------------------------------------------------------------- one identity per device
test("logout of A then login of B: B gets nothing from A, not even a count; A is told BEFORE the delete", async () => {
  const server = makeServer();
  const storage = new MemoryTargetSyncStorage();
  const alice = makeDevice(server, "alice", { storage });
  await alice.start();
  idle(await alice.client.sync());
  await alice.client.editTitle("t1", "alice 1");
  await alice.client.editTitle("t2", "alice 2");
  let seenAtReport = null;
  alice.client.on(event => { if (event.type === "report" && event.report.kind === "logout") storage.listNamespaces().then(names => { seenAtReport = names.length; }); });
  const result = await alice.client.logout();
  assert.deepEqual(result, { unsendable: 2, wiped: true });
  assert.equal(seenAtReport, 1);
  assert.equal(alice.eventsOf("report")[0].report.count, 2);
  assert.deepEqual(await storage.listNamespaces(), []);
  const bob = makeDevice(server, "bob", { storage });
  const aliceEventsBefore = alice.events.length;
  await bob.start();
  assert.equal(bob.events.length, 0, "B received nothing");
  assert.equal(alice.events.length, aliceEventsBefore);
  assert.deepEqual(unwrap(await bob.client.listDrafts()), []);
  assert.deepEqual(unwrap(await bob.client.listReports()), []);
  assert.doesNotMatch(JSON.stringify(storage.dump()), /alice/);
});

test("activating another identity without logout deletes every namespace of the previous one (including reports) and tells the new one nothing", async () => {
  const server = makeServer();
  const storage = new MemoryTargetSyncStorage();
  const alice = makeDevice(server, "alice", { storage });
  await alice.start();
  idle(await alice.client.sync());
  await alice.client.editTitle("t1", "alice pending");
  server.setSession(alice.holder.token, "expired");
  await alice.client.tick(); // locked, queue kept
  assert.equal((await storage.listNamespaces()).length, 1);
  const events = [];
  alice.client.on(event => events.push(event));
  await alice.client.activate({ userId: "bob" });
  assert.deepEqual(events, [], "no events, no counts for the new identity");
  const names = await storage.listNamespaces();
  assert.equal(names.every(name => !name.includes("alice")), true);
  assert.deepEqual(unwrap(await alice.client.listDrafts()), []);
  assert.deepEqual(unwrap(await alice.client.listReports()), []);
  // Old identity logging in again starts empty: its data is gone.
  alice.relogin();
  await alice.client.activate({ userId: "alice" });
  assert.deepEqual(unwrap(await alice.client.listItems()), []);
  assert.deepEqual(unwrap(await alice.client.listDrafts()), []);
  // A late answer for the previous identity is discarded.
  const server2 = makeServer();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = {
    fetchChanges: async cursor => { await gate; return server2.transport(token2).fetchChanges(cursor); },
  };
  const token2 = server2.login("alice");
  const client = new TargetSyncClient({ storage: new MemoryTargetSyncStorage(), transport: { ...server2.transport(token2), ...slow }, autoRun: false });
  await client.activate({ userId: "alice" });
  const pending = client.sync();
  await client.activate({ userId: "bob" });
  release();
  assert.equal((await pending).status, "signed_out");
  assert.deepEqual(unwrap(await client.listItems()), [], "nothing of alice's late response reached bob");
});

test("pending reports survive an app restart for the same identity until acknowledged", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "x");
  server.removeMember("team", "bob");
  await device.client.tick();
  assert.equal(device.eventsOf("report").length, 1);
  const restarted = makeDevice(server, "bob", { storage: device.storage, token: device.holder.token });
  await restarted.start();
  assert.equal(restarted.eventsOf("report").length, 1, "re-delivered to the same identity");
  const reportId = restarted.eventsOf("report")[0].report.id;
  await restarted.client.acknowledgeReport(reportId);
  const again = makeDevice(server, "bob", { storage: device.storage, token: device.holder.token });
  await again.start();
  assert.equal(again.eventsOf("report").length, 0);
});

// ---------------------------------------------------------------- scenario 2
test("B is removed from the Area with 3 queued changes: the server would refuse all, the client deletes data and queue and reports 3", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await three(device);
  server.removeMember("team", "bob");
  const tick = await device.client.tick();
  idle(tick.sync);
  assert.equal(server.writes.length, 0);
  const report = device.eventsOf("report").find(event => event.report.kind === "access_lost").report;
  assert.deepEqual([report.count, report.areaId], [3, "team"]);
  assert.deepEqual(await draftsOf(device.client), {});
  assert.deepEqual(unwrap(await device.client.listItems()), []);
  assert.equal(unwrap(await device.client.pendingCounts()).drafts, 0);
  assert.equal(tick.pump.status, "idle");
  // The server really would have refused (feed shows nothing of the Area either).
  assert.equal(server.canWrite("bob", "team"), false);
});

// ---------------------------------------------------------------- scenario 4: restore from backup
test("restore with 3 queued changes (resync_required): changes to still-accessible items become LOCAL drafts, the counts are reported, nothing is auto-sent", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await three(device);
  server.restore({ generation: G2, tasks: [["t1", "team", "t1 restored"], ["t2", "team", "t2 restored"]] });
  const tick = await device.client.tick();
  idle(tick.sync);
  assert.equal(server.writes.length, 0, "nothing written in either generation");
  assert.equal(server.calls.filter(call => /^send/.test(call.method)).length, 0, "nothing even attempted");
  const drafts = await draftsOf(device.client);
  assert.deepEqual(Object.keys(drafts).sort(), ["t1", "t2"]);
  assert.equal(drafts.t1.status, "local");
  assert.equal(drafts.t1.title, "t1 queued");
  assert.equal(drafts.t3, undefined, "t3 is missing in the new bootstrap: its change is removed");
  const counts = unwrap(await device.client.pendingCounts());
  assert.deepEqual([counts.queued, counts.local], [0, 2]);
  const report = device.eventsOf("report").find(event => event.report.kind === "restore").report;
  assert.deepEqual([report.keptAsDrafts, report.removed], [2, 1]);
  assert.deepEqual(Object.keys(await titles(device.client)).sort(), ["t1", "t2"]);
  assert.equal((await titles(device.client)).t1, "t1 restored");
  const names = await device.storage.listNamespaces();
  assert.equal(names.length, 1, "the old generation namespace was deleted");
  assert.ok(names[0].endsWith(G2));
  // Repeated passes still send nothing.
  await device.client.tick();
  assert.equal(server.calls.filter(call => /^send/.test(call.method)).length, 0);
  // Only an explicit action turns a local draft into a command of the NEW generation.
  assert.equal((await device.client.resubmitDraft("t1")).ok, true);
  await device.client.pump();
  assert.equal(server.titleOf("t1"), "t1 queued");
  assert.equal(server.writes.length, 1);
  assert.equal(server.writes[0].generation, G2);
});

test("restore via session_restored: queue frozen, cache cleared, locked; after re-login the restore flow runs and nothing is sent", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await three(device);
  server.restore({ generation: G2, tasks: [["t1", "team", "t1 restored"], ["t2", "team", "t2 restored"], ["t3", "team", "t3 restored"]], restoredSessions: [device.holder.token] });
  const tick = await device.client.tick();
  assert.equal(tick.sync.status, "locked");
  assert.deepEqual(device.eventsOf("reauth_required").map(event => event.reason), ["session_restored"]);
  const stored = Object.values(device.storage.dump())[0];
  assert.equal(Object.keys(stored).filter(key => key.startsWith("item/")).length, 0, "cache cleared");
  assert.equal(Object.keys(stored).filter(key => key.startsWith("cmd/")).length, 3, "queue kept");
  assert.ok(Object.entries(stored).filter(([key]) => key.startsWith("cmd/")).every(([, cmd]) => cmd.state === "frozen"));
  assert.equal((await device.client.pump()).status, "locked");
  device.relogin();
  await device.client.activate({ userId: "bob" });
  assert.equal((await device.client.pump()).status, "idle", "frozen commands are not sent, even though the session works again");
  assert.equal(server.writes.length, 0);
  const result = await device.client.tick();
  idle(result.sync);
  assert.equal(server.writes.length, 0);
  assert.equal(server.calls.filter(call => /^send/.test(call.method)).length, 0);
  const drafts = await draftsOf(device.client);
  assert.deepEqual(Object.keys(drafts).sort(), ["t1", "t2", "t3"]);
  assert.ok(Object.values(drafts).every(draft => draft.status === "local"));
  const report = device.eventsOf("report").find(event => event.report.kind === "restore").report;
  assert.deepEqual([report.keptAsDrafts, report.removed], [3, 0]);
  assert.equal((await device.storage.listNamespaces()).length, 1);
});

test("a write answered with resync_required freezes the command; the restore flow then keeps it as a local draft", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "queued in G1");
  server.restore({ generation: G2, tasks: [["t1", "team", "restored"]] });
  assert.equal((await device.client.pump()).status, "resync_requested");
  assert.equal(server.writes.length, 0);
  const tick = await device.client.tick();
  idle(tick.sync);
  assert.equal((await draftsOf(device.client)).t1.status, "local");
  assert.equal(server.writes.length, 0);
});

test("scenario 4 for B (removed after the backup), C (session revoked before) and the restore not bringing anything back", async () => {
  const server = makeServer();
  const bob = makeDevice(server, "bob");
  const carol = makeDevice(server, "carol");
  await bob.start();
  await carol.start();
  idle(await bob.client.sync());
  idle(await carol.client.sync());
  await three(bob);
  server.restore({ generation: G2, tasks: [["t1", "team", "r1"], ["t2", "team", "r2"], ["t3", "team", "r3"]], revokedSessions: [carol.holder.token] });
  server.removeMember("team", "bob"); // removed after the backup, the restore replays it
  const result = await bob.client.tick();
  idle(result.sync);
  const report = bob.eventsOf("report").find(event => event.report.kind === "restore").report;
  assert.deepEqual([report.keptAsDrafts, report.removed], [0, 3], "B lost the Area: data and queue are gone, 3 reported");
  assert.deepEqual(await draftsOf(bob.client), {});
  assert.deepEqual(unwrap(await bob.client.listItems()), []);
  assert.equal((await carol.client.sync()).status, "signed_out");
  assert.deepEqual(await carol.storage.listNamespaces(), []);
  assert.equal(server.writes.length, 0);
});

test("a restore that happens again while the restore bootstrap is incomplete still carries the original drafts over", async () => {
  const server = makeServer();
  server.pageSize = 1;
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await three(device);
  server.restore({ generation: G2, tasks: [["t1", "team", "a"], ["t2", "team", "b"], ["t3", "team", "c"]] });
  // Interrupt the restore bootstrap after its first page. Transactions: 1 resync flag, 2 begin bootstrap,
  // 3 freeze old, 4 new namespace meta, 5 page 1, 6 page 2 (fails).
  device.storage.injectFailure({ transaction: 6, afterOps: 1 });
  const first = await device.client.sync();
  assert.equal(first.status, "error");
  assert.deepEqual(await device.client.listDrafts(), { locked: true, reason: "resyncing" });
  assert.equal((await device.client.editTitle("t1", "no")).reason, "resyncing");
  assert.equal((await device.client.pump()).reason, "resyncing");
  // App restart and ANOTHER restore before the first one finished.
  server.restore({ generation: G3, tasks: [["t1", "team", "x"], ["t2", "team", "y"]] });
  const restarted = makeDevice(server, "bob", { storage: device.storage, token: device.holder.token });
  await restarted.start();
  idle(await restarted.client.sync());
  const drafts = await draftsOf(restarted.client);
  assert.deepEqual(Object.keys(drafts).sort(), ["t1", "t2"]);
  assert.ok(Object.values(drafts).every(draft => draft.status === "local"));
  const names = await device.storage.listNamespaces();
  assert.equal(names.length, 1);
  assert.ok(names[0].endsWith(G3));
  assert.equal(server.writes.length, 0);
});

test("crash recovery after the restore migration: the leftover old namespace is deleted on the next activation", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await three(device);
  server.restore({ generation: G2, tasks: [["t1", "team", "a"]] });
  // Deleting the old namespace fails once (crash right after the migration commit).
  const original = device.storage.deleteNamespaces.bind(device.storage);
  let failed = false;
  device.storage.deleteNamespaces = async names => { if (!failed) { failed = true; throw new Error("crash"); } return original(names); };
  idle((await device.client.tick()).sync);
  assert.equal((await device.storage.listNamespaces()).length, 2, "the source is still there");
  const restarted = makeDevice(server, "bob", { storage: device.storage, token: device.holder.token });
  await restarted.start();
  assert.equal((await device.storage.listNamespaces()).length, 1);
  assert.deepEqual(Object.keys(await draftsOf(restarted.client)), ["t1"]);
});

test("activate validates the user id; re-activating the same unlocked identity keeps the session", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await assert.rejects(() => device.client.activate({ userId: "a|b" }), /invalid_user_id/);
  await assert.rejects(() => device.client.activate({ userId: "" }), /invalid_user_id/);
  await device.start();
  idle(await device.client.sync());
  const again = await device.client.activate({ userId: "bob" });
  assert.equal(again.restoreGeneration, G1);
  assert.equal(Object.keys(await titles(device.client)).length, 3);
});
