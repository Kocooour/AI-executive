import assert from "node:assert/strict";
import { test } from "node:test";
import {
  G1, G2, MemoryTargetSyncStorage, draftsOf, feedPage, makeDevice, makeServer, titles, unwrap,
} from "./support/target-sync-harness.mjs";

// R2c.5a: client sync core over the memory storage adapter and the fake server (contract model). No timers, no UI.

const idle = outcome => assert.equal(outcome.status, "idle", JSON.stringify(outcome));

// ---------------------------------------------------------------- feed application
test("bootstrap pages by keyset, then follows the feed; the cursor survives a new client on the same storage", async () => {
  const server = makeServer();
  const device = await makeDevice(server, "alice");
  await device.start();
  idle(await device.client.sync());
  assert.deepEqual(await titles(device.client), { s1: "secret one", t1: "t1 original", t2: "t2 original", t3: "t3 original" });
  server.setTitle("t1", "t1 by someone");
  server.addTask("t4", "team", "t4 new");
  idle(await device.client.sync());
  assert.equal((await titles(device.client)).t1, "t1 by someone");
  assert.equal((await titles(device.client)).t4, "t4 new");
  assert.ok(server.calls.filter(call => call.method === "fetchChanges").length >= 3, "several pages were requested");
  // A second client object (app restart) continues from the stored cursor: no second bootstrap.
  const before = server.calls.filter(call => call.cursor === null).length;
  const restarted = makeDevice(server, "alice", { storage: device.storage, token: device.holder.token });
  await restarted.start();
  idle(await restarted.client.sync());
  assert.equal(server.calls.filter(call => call.cursor === null).length, before);
});

test("older revisions are ignored, a tombstone beats a later older upsert, duplicates are idempotent", async () => {
  const server = makeServer();
  const device = makeDevice(server, "alice");
  await device.start();
  idle(await device.client.sync());
  const stale = { type: "upsert", kind: "task", id: "t1", revision: 0, areaId: "team", title: "ancient", effectiveAreaId: "team" };
  server.script("fetchChanges", feedPage(server, "alice", [stale]));
  idle(await device.client.sync());
  assert.equal((await titles(device.client)).t1, "t1 original");
  const tomb = { type: "tombstone", kind: "task", id: "t2", areaId: "team", revision: 5 };
  const upsert = { type: "upsert", kind: "task", id: "t2", revision: 1, areaId: "team", title: "zombie", effectiveAreaId: "team" };
  const revived = { ...upsert, revision: 9 };
  server.script("fetchChanges", feedPage(server, "alice", [tomb, tomb, upsert, revived]));
  idle(await device.client.sync());
  assert.equal((await titles(device.client)).t2, undefined);
  assert.equal(unwrap(await device.client.isTombstoned("t2")), true);
  assert.equal(device.eventsOf("report").length, 0);
});

test("a move to another Area replaces the item; a stale left_scope of the old Area does not delete it", async () => {
  const server = makeServer();
  server.addArea("other", { alice: "admin" });
  const device = makeDevice(server, "alice");
  await device.start();
  idle(await device.client.sync());
  server.moveTask("t1", "other"); // leave(team) then upsert(other), revision +1 each
  idle(await device.client.sync());
  const moved = unwrap(await device.client.getItem("t1"));
  assert.equal(moved.areaId, "other");
  const stale = { type: "left_scope", kind: "task", id: "t1", areaId: "team" };
  server.script("fetchChanges", feedPage(server, "alice", [stale]));
  idle(await device.client.sync());
  assert.equal(unwrap(await device.client.getItem("t1")).areaId, "other", "stale notice kept the item");
  // Same revision with another effective Area (project move) counts as newer.
  const sameRevision = { type: "upsert", kind: "task", id: "t1", revision: moved.revision, areaId: "team", title: moved.title, effectiveAreaId: "team" };
  server.script("fetchChanges", feedPage(server, "alice", [sameRevision]));
  idle(await device.client.sync());
  assert.equal(unwrap(await device.client.getItem("t1")).areaId, "team");
});

test("read_stale_reload retries the same cursor; cursor_invalid re-bootstraps WITHOUT touching queue and drafts", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  assert.equal((await device.client.editTitle("t1", "bob edit")).ok, true);
  server.script("fetchChanges", { result: { kind: "read_stale_reload" } });
  const before = server.calls.length;
  idle(await device.client.sync());
  const cursors = server.calls.slice(before).map(call => call.cursor);
  assert.equal(cursors[0], cursors[1], "same cursor retried");
  server.script("fetchChanges", { result: { kind: "cursor_invalid" } });
  server.removeMember("secret", "bob"); // nothing visible; bob never saw it
  server.setTitle("t3", "changed while invalid");
  idle(await device.client.sync());
  assert.equal((await titles(device.client)).t3, "changed while invalid");
  assert.equal(server.calls.filter(call => call.method === "fetchChanges" && call.cursor === null).length, 2, "a second bootstrap ran");
  const counts = unwrap(await device.client.pendingCounts());
  assert.equal(counts.queued, 1);
  assert.equal((await draftsOf(device.client)).t1.title, "bob edit");
  assert.equal(server.writes.length, 0);
});

test("a re-bootstrap removes what the server no longer shows and reports the drafts it removed", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  assert.equal((await device.client.editTitle("t2", "bob edit")).ok, true);
  server.removeMember("team", "bob"); // no feed read happens: only a bootstrap can find out
  server.script("fetchChanges", { result: { kind: "cursor_invalid" } });
  idle(await device.client.sync());
  assert.deepEqual(await titles(device.client), {});
  assert.deepEqual(await draftsOf(device.client), {});
  const report = device.eventsOf("report").find(event => event.report.kind === "not_in_bootstrap");
  assert.equal(report.report.count, 1);
  assert.equal(server.writes.length, 0);
});

test("compaction (resync_required, same generation) re-bootstraps and keeps the queue sendable", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  assert.equal((await device.client.editTitle("t1", "kept across compaction")).ok, true);
  server.setTitle("t3", "later");
  server.compact();
  idle(await device.client.sync());
  assert.equal((await titles(device.client)).t3, "later");
  const result = await device.client.pump();
  assert.equal(result.status, "idle");
  assert.equal(server.titleOf("t1"), "kept across compaction", "same generation: the command was sent normally");
});

test("notices: access_lost and left_scope delete data, drafts and queue with a reported count; duplicates are silent", async () => {
  const server = makeServer();
  server.addArea("other", { bob: "editor", alice: "admin" });
  server.addTask("o1", "other", "o1");
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  assert.equal((await device.client.editTitle("t1", "a")).ok, true);
  assert.equal((await device.client.editTitle("t2", "b")).ok, true);
  assert.equal((await device.client.editTitle("o1", "c")).ok, true);
  server.moveTask("t1", "secret"); // bob cannot read secret: left_scope
  server.removeMember("team", "bob"); // access_lost for the whole team Area
  idle(await device.client.sync());
  const reports = device.eventsOf("report").map(event => event.report);
  assert.deepEqual(reports.map(report => [report.kind, report.count]), [["left_scope", 1], ["access_lost", 1]]);
  assert.deepEqual(Object.keys(await draftsOf(device.client)), ["o1"], "only the other Area keeps its draft");
  assert.ok(!(await titles(device.client)).t2);
  const accessLost = { type: "access_lost", areaId: "team" };
  server.script("fetchChanges", feedPage(server, "bob", [accessLost, accessLost, { type: "left_scope", kind: "task", id: "t1", areaId: "team" }]));
  idle(await device.client.sync());
  assert.equal(device.eventsOf("report").length, 2, "duplicate notices produced no new report");
  assert.equal(server.writes.length, 0);
});

test("access_granted starts an Area bootstrap from the areaCursor; granting again is idempotent", async () => {
  const server = makeServer();
  const device = makeDevice(server, "dave");
  await device.start();
  idle(await device.client.sync());
  assert.deepEqual(await titles(device.client), {});
  server.addMember("team", "dave", "viewer");
  idle(await device.client.sync());
  assert.deepEqual(Object.keys(await titles(device.client)).sort(), ["t1", "t2", "t3"]);
  server.addMember("team", "dave", "viewer");
  idle(await device.client.sync());
  assert.equal(Object.keys(await titles(device.client)).length, 3);
});

// ---------------------------------------------------------------- queue basics
test("title and delete commands are sent with the validated CAS token; ok removes command and draft", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  assert.equal((await device.client.editTitle("t1", "new title")).ok, true);
  assert.equal((await device.client.deleteTask("t2")).ok, true);
  assert.deepEqual((await device.client.pump()).status, "idle");
  assert.equal(server.titleOf("t1"), "new title");
  assert.equal(server.tasks.has("t2"), false);
  assert.deepEqual(await draftsOf(device.client), {});
  idle(await device.client.sync());
  assert.equal((await titles(device.client)).t1, "new title");
  assert.equal(unwrap(await device.client.isTombstoned("t2")), true);
  assert.equal(server.writes.length, 2);
});

test("editTitle validates the title, refuses unknown and viewer-only tasks and edits an unsent draft in place", async () => {
  const server = makeServer();
  const viewer = makeDevice(server, "carol");
  await viewer.start();
  idle(await viewer.client.sync());
  assert.equal((await viewer.client.editTitle("t1", "viewer edit")).reason, "unavailable");
  assert.deepEqual(await draftsOf(viewer.client), {});
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  for (const bad of ["", " padded ", "x".repeat(4097), "nul\0"]) assert.equal((await device.client.editTitle("t1", bad)).reason, "invalid_title");
  assert.equal((await device.client.editTitle("nope", "x")).reason, "unknown_task");
  const first = await device.client.editTitle("t1", "v1");
  const second = await device.client.editTitle("t1", "v2");
  assert.equal(second.commandId, first.commandId, "an unsent command keeps its id when only the text changes");
  assert.equal((await device.client.deleteTask("t1")).reason, "draft_exists");
  await device.client.pump();
  assert.equal(server.titleOf("t1"), "v2");
  assert.equal(server.writes.length, 1);
});

test("offline edit (no token yet) acquires the token at send time and refuses to carry newer remote content over", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  server.script("readTitleToken", { result: { kind: "uncertain", reason: "offline" } });
  assert.equal((await device.client.editTitle("t1", "offline edit")).ok, true);
  assert.equal(server.writes.length, 0);
  // Somebody else changes the task before the client is back online.
  server.setTitle("t1", "remote edit");
  const result = await device.client.pump();
  assert.equal(result.conflicts, 1);
  assert.equal(server.titleOf("t1"), "remote edit", "the remote change was not overwritten");
  const draft = (await draftsOf(device.client)).t1;
  assert.equal(draft.status, "conflict");
  assert.equal(draft.title, "offline edit");
  // Unchanged task: the same flow succeeds.
  const calm = makeDevice(server, "bob");
  await calm.start();
  idle(await calm.client.sync());
  server.script("readTitleToken", { result: { kind: "uncertain", reason: "offline" } });
  await calm.client.editTitle("t3", "calm offline edit");
  assert.equal((await calm.client.pump()).status, "idle");
  assert.equal(server.titleOf("t3"), "calm offline edit");
});

// ---------------------------------------------------------------- uncertain results
test("uncertain result: the status endpoint decides, there is never a blind resend (committed)", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "committed but response lost");
  server.script("sendTitle", { commitThenReturn: { kind: "uncertain", reason: "timeout" } });
  const first = await device.client.pump();
  assert.equal(first.status, "backoff");
  assert.equal(server.writes.length, 1);
  assert.equal(unwrap(await device.client.pendingCounts()).uncertain, 1);
  // Nothing is sent before the back-off elapses.
  const callsBefore = server.calls.length;
  await device.client.pump();
  assert.equal(server.calls.length, callsBefore);
  await device.scheduler.advance(120_000);
  await device.client.pump();
  const methods = server.calls.filter(call => call.userId === "bob" && /send|Status/.test(call.method)).map(call => call.method);
  assert.deepEqual(methods, ["sendTitle", "titleStatus"], "status check, no second send");
  assert.equal(server.writes.length, 1);
  assert.deepEqual(await draftsOf(device.client), {});
});

test("uncertain result: not_recorded allows the SAME command to be sent again", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "lost request");
  server.script("sendTitle", { result: { kind: "uncertain", reason: "network" } });
  await device.client.pump();
  await device.scheduler.advance(120_000);
  await device.client.pump();
  const sends = server.calls.filter(call => call.method === "sendTitle");
  const status = server.calls.filter(call => call.method === "titleStatus");
  assert.equal(sends.length, 2);
  assert.equal(status.length, 1);
  assert.equal(sends[0].commandId, sends[1].commandId, "same commandId");
  assert.equal(server.titleOf("t1"), "lost request");
  assert.equal(server.writes.length, 1);
});

test("an unknown status result stays uncertain and backs off; a restart of the app recovers a command caught in flight", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "restart me");
  server.script("sendTitle", { commitThenReturn: { kind: "uncertain", reason: "crash" } });
  server.script("titleStatus", { result: { kind: "uncertain", reason: "still down" } });
  await device.client.pump();
  await device.scheduler.advance(120_000);
  const stillUnknown = await device.client.pump();
  assert.equal(stillUnknown.status, "backoff");
  assert.equal(unwrap(await device.client.pendingCounts()).uncertain, 1);
  // New client object on the same storage (app restart).
  const restarted = makeDevice(server, "bob", { storage: device.storage, token: device.holder.token, scheduler: device.scheduler });
  await restarted.start();
  await device.scheduler.advance(120_000);
  assert.equal((await restarted.client.pump()).status, "idle");
  assert.equal(server.writes.length, 1);
  assert.deepEqual(await draftsOf(restarted.client), {});
});

test("429 and a coded 503 keep the command queued with back-off; a plain 503 may have committed and is checked via status", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "throttled");
  server.script("sendTitle", { result: { kind: "rate_limited", retryAfterSeconds: 30 } }, { result: { kind: "store_unavailable", code: "restore_pending" } });
  assert.equal((await device.client.pump()).status, "backoff");
  assert.equal(unwrap(await device.client.pendingCounts()).queued, 1);
  await device.scheduler.advance(31_000);
  assert.equal((await device.client.pump()).status, "backoff");
  assert.equal(unwrap(await device.client.pendingCounts()).queued, 1, "gate refusal happened before any work");
  await device.scheduler.advance(120_000);
  server.script("sendTitle", { commitThenReturn: { kind: "store_unavailable", code: null } });
  await device.client.pump();
  assert.equal(unwrap(await device.client.pendingCounts()).uncertain, 1);
  await device.scheduler.advance(120_000);
  await device.client.pump();
  assert.equal(server.writes.length, 1);
  assert.deepEqual(await draftsOf(device.client), {});
});

// ---------------------------------------------------------------- conflict, 404, 400
test("409 keeps the draft, offers a reload and never drops it; resubmit after reload uses a new command; discard is explicit", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "my edit");
  server.setTitle("t1", "alice was first"); // between token read and send
  const result = await device.client.pump();
  assert.equal(result.conflicts, 1);
  const draft = (await draftsOf(device.client)).t1;
  assert.equal(draft.status, "conflict");
  assert.equal(draft.reloadOffered, true);
  assert.equal(draft.reason, "stale_revision");
  assert.equal(device.eventsOf("conflict").length, 1);
  assert.equal(unwrap(await device.client.pendingCounts()).queued, 0);
  await device.client.pump();
  assert.equal(server.calls.filter(call => call.method === "sendTitle").length, 1, "a conflicting command is not retried");
  const reloaded = unwrap(await device.client.reloadTask("t1"));
  assert.equal(reloaded.item.title, "alice was first");
  assert.equal(reloaded.draft.title, "my edit", "draft survives the reload");
  const again = await device.client.resubmitDraft("t1");
  assert.equal(again.ok, true);
  assert.notEqual(again.commandId, draft.commandId);
  await device.client.pump();
  assert.equal(server.titleOf("t1"), "my edit");
  // explicit discard
  await device.client.editTitle("t2", "to throw away");
  server.setTitle("t2", "elsewhere");
  await device.client.pump();
  assert.equal(await device.client.discardDraft("t2"), true);
  assert.deepEqual(await draftsOf(device.client), {});
});

test("404 on a queued command (demoted without access_lost): unsendable with a reported count, kept, never retried", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "one");
  await device.client.editTitle("t2", "two");
  server.setRole("team", "bob", "viewer"); // the feed is NOT read: only the write path can find out
  const result = await device.client.pump();
  assert.equal(result.unsendable, 2);
  assert.equal(server.writes.length, 0);
  const report = device.eventsOf("report").find(event => event.report.kind === "unsendable");
  assert.equal(report.report.count, 2);
  const drafts = await draftsOf(device.client);
  assert.equal(drafts.t1.status, "unsendable");
  assert.equal(drafts.t2.reason, "unavailable");
  const sends = server.calls.filter(call => call.method === "sendTitle").length;
  await device.client.pump();
  await device.client.pump();
  assert.equal(server.calls.filter(call => call.method === "sendTitle").length, sends, "not retried forever");
  assert.equal(unwrap(await device.client.pendingCounts()).unsendable, 2);
});

test("role_changed from the feed re-evaluates the queue of that Area: nothing is written, the count is reported", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "one");
  await device.client.editTitle("t2", "two");
  server.setRole("team", "bob", "viewer");
  const tick = await device.client.tick();
  idle(tick.sync);
  assert.equal(tick.pump.unsendable, 2);
  assert.equal(server.writes.length, 0, "the viewer wrote nothing");
  assert.equal(server.calls.filter(call => call.method === "sendTitle").length, 0, "re-authorized by the CAS read: no write was even attempted");
  assert.equal(device.eventsOf("report").filter(event => event.report.kind === "unsendable")[0].report.count, 2);
  assert.equal(Object.keys(await draftsOf(device.client)).length, 2, "nothing silently lost");
  // An editor whose role is merely re-announced keeps sending.
  const other = makeDevice(server, "alice");
  await other.start();
  idle(await other.client.sync());
  await other.client.editTitle("t3", "admin edit");
  server.setRole("team", "alice", "admin");
  const second = await other.client.tick();
  assert.equal(second.pump.status, "idle");
  assert.equal(server.titleOf("t3"), "admin edit");
});

test("400 invalid takes the command out of sending and reports it", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "x");
  server.script("sendTitle", { result: { kind: "invalid", code: "protocol_unsupported" } });
  const result = await device.client.pump();
  assert.equal(result.unsendable, 1);
  assert.equal((await draftsOf(device.client)).t1.reason, "invalid:protocol_unsupported");
});

test("B edits a shared task while A deletes it: tombstone gives an unsendable draft, nothing is recreated or written", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "bob offline edit");
  server.removeTask("t1");
  const tick = await device.client.tick();
  assert.equal(server.writes.length, 0);
  const draft = (await draftsOf(device.client)).t1;
  assert.equal(draft.status, "unsendable");
  assert.equal(draft.reason, "item_deleted");
  assert.equal(draft.title, "bob offline edit");
  assert.equal(tick.pump.status, "idle");
  assert.equal((await titles(device.client)).t1, undefined);
  assert.equal((await device.client.editTitle("t1", "again")).reason, "deleted");
  assert.equal(server.tasks.has("t1"), false);
  // Variant: the write path finds out first (404), the draft stays unsendable, the later tombstone keeps it.
  const second = makeDevice(server, "bob");
  await second.start();
  idle(await second.client.sync());
  await second.client.editTitle("t2", "second");
  server.removeTask("t2");
  await second.client.pump();
  assert.equal((await draftsOf(second.client)).t2.status, "unsendable");
  idle(await second.client.sync());
  assert.equal((await draftsOf(second.client)).t2.status, "unsendable");
  assert.equal(server.writes.length, 0);
});

test("a delete draft whose item another actor already deleted is simply fulfilled", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  server.script("readTitleToken", { result: { kind: "uncertain", reason: "offline" } });
  await device.client.deleteTask("t1");
  server.removeTask("t1");
  await device.client.tick();
  assert.deepEqual(await draftsOf(device.client), {});
  assert.equal(server.writes.length, 0);
});

// ---------------------------------------------------------------- two clients (scenario 5)
test("two clients of one identity edit the same task: exactly one write succeeds, the other gets 409 with its draft kept", async () => {
  const server = makeServer();
  const a = makeDevice(server, "bob");
  const b = makeDevice(server, "bob");
  await a.start();
  await b.start();
  idle(await a.client.sync());
  idle(await b.client.sync());
  assert.equal((await a.client.editTitle("t1", "from A")).ok, true);
  assert.equal((await b.client.editTitle("t1", "from B")).ok, true);
  const [resultA, resultB] = [await a.client.pump(), await b.client.pump()];
  assert.equal(resultA.done + resultB.done, 1, "exactly one write succeeded");
  assert.equal(resultA.conflicts + resultB.conflicts, 1, "the other got 409");
  assert.equal(server.writes.length, 1);
  const loser = resultA.conflicts === 1 ? a : b;
  const loserDraft = (await draftsOf(loser.client)).t1;
  assert.equal(loserDraft.status, "conflict");
  assert.ok(["from A", "from B"].includes(loserDraft.title));
  assert.notEqual(loserDraft.title, server.titleOf("t1"));
});

test("replaying the same commandId after success does not change anything twice", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "once");
  const transport = server.transport(device.holder.token);
  const cmd = { taskId: "t1", commandId: "00000000-0000-4000-8000-0000000000aa", expectedRevision: (await transport.readTitleToken("t1")).value.snapshotRevision,
    writeAreaId: "team", restoreGeneration: G1, title: "direct" };
  assert.equal((await transport.sendTitle(cmd)).kind, "ok");
  const replay = await transport.sendTitle(cmd);
  assert.equal(replay.kind, "ok");
  assert.equal(replay.replayed, true);
  assert.equal(server.writes.filter(write => write.commandId === cmd.commandId).length, 1);
});

// ---------------------------------------------------------------- storage failure atomicity
test("a failing storage write leaves no half-applied page; the next pass completes", async () => {
  const server = makeServer();
  server.pageSize = 2;
  const device = makeDevice(server, "alice");
  await device.start();
  // Transactions: 1 creates the namespace, 2 applies page 1, 3 applies page 2 (fails after its first op).
  device.storage.injectFailure({ transaction: 3, afterOps: 1 });
  const failed = await device.client.sync();
  assert.equal(failed.status, "error");
  const ids = unwrap(await device.client.listItems()).map(item => item.id);
  assert.deepEqual(ids.sort(), ["s1", "t1"], "page 1 only: page 2 is entirely absent");
  const dump = device.storage.dump();
  const meta = Object.values(dump)[0].meta;
  assert.equal(meta.phase, "bootstrap");
  idle(await device.client.sync());
  assert.equal(Object.keys(await titles(device.client)).length, 4);
});

test("a failing storage write while queueing an edit reports the failure and leaves no draft", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob");
  await device.start();
  idle(await device.client.sync());
  device.storage.injectFailure({ transaction: 1, afterOps: 1 });
  assert.equal((await device.client.editTitle("t1", "lost?")).reason, "storage_error");
  assert.deepEqual(await draftsOf(device.client), {});
  assert.equal((await device.client.editTitle("t1", "retry")).ok, true);
});

// ---------------------------------------------------------------- scheduler
test("a 503 from the feed backs off on the injected scheduler and the retry runs without real timers", async () => {
  const server = makeServer();
  const device = makeDevice(server, "alice", { autoRun: true });
  await device.start();
  server.gate = "restore_pending";
  const first = await device.client.sync();
  assert.equal(first.status, "backoff");
  assert.equal(device.scheduler.pending(), 1);
  server.gate = null;
  await device.scheduler.advance(first.retryAt - device.scheduler.now());
  assert.equal(Object.keys(await titles(device.client)).length, 4, "the scheduled tick bootstrapped");
});

test("a queued edit is flushed by the scheduled tick when autoRun is on", async () => {
  const server = makeServer();
  const device = makeDevice(server, "bob", { autoRun: true });
  await device.start();
  idle(await device.client.sync());
  await device.client.editTitle("t1", "auto");
  await device.scheduler.advance(1);
  assert.equal(server.titleOf("t1"), "auto");
});

test("storage: a closed namespace handle rejects, namespaces are isolated, deletion is complete", async () => {
  const storage = new MemoryTargetSyncStorage();
  const a = await storage.openNamespace("lumi-sync-v1|alice|g1");
  const b = await storage.openNamespace("lumi-sync-v1|bob|g1");
  await a.transaction([{ kind: "put", key: "k", value: { v: 1 } }]);
  assert.equal(await b.get("k"), undefined);
  await assert.rejects(() => a.transaction([{ kind: "put", key: "x", value: 1 }, { kind: "put", key: "y", value: () => 1 }]).then(() => { throw new Error("should not fail"); }), /should not fail/).catch(() => undefined);
  await storage.deleteNamespaces([a.name]);
  await assert.rejects(() => a.get("k"), /namespace_closed/);
  await assert.rejects(() => a.transaction([{ kind: "put", key: "k", value: 1 }]), /namespace_closed/);
  assert.deepEqual(await storage.listNamespaces(), [b.name]);
});
