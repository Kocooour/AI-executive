import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTargetSyncStorage } from "../lib/target-sync/memory-storage.ts";
import { createStagingNotePersistentClient, noteMetadataNamespace } from "../lib/target-sync/note-persistent.ts";
import { decodeNoteSyncCheckpoint } from "../lib/target-sync/note-pages.ts";

const C = "A".repeat(4135), D = "B".repeat(4135);
const scope = (userId = "alice", areaId = "personal",
  restoreGeneration = "123e4567-e89b-42d3-a456-426614174000") =>
  ({ userId, areaId, restoreGeneration });
const note = (id, revision = 1) =>
  ({ id, revision, projectId: null, parentRevision: null });
const boot = (entries, more = false, cursor = C) =>
  ({ phase: "bootstrap", entries, changes: [], more, cursor });
const change = (changes = [], cursor = D) =>
  ({ phase: "changes", entries: [], changes, more: false, cursor });
const json = (v, status = 200) => Response.json(v, { status });
const scripted = (...answers) => {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw Error("unexpected request");
    return typeof answer === "function" ? answer(init) : answer;
  };
  return { transport, calls };
};
const client = (storage, transport) => createStagingNotePersistentClient({ storage, transport });
const names = async storage => storage.listNamespaces();
const applied = result => assert.equal(result.kind, "applied", JSON.stringify(result));

test("atomically checkpoints manifest and cursor, then requires live HTTP auth on restart", async () => {
  const storage = new MemoryTargetSyncStorage();
  const firstWire = scripted(json(boot([note("a")], true)), json(boot([note("b")], false, D)));
  const first = client(storage, firstWire.transport);
  assert.equal(await first.activate(scope()), "fresh");
  applied(await first.pull());
  assert.deepEqual(first.read(), [], "pending manifest is not published");
  const partition = noteMetadataNamespace(scope());
  const pending = storage.dump()[partition].checkpoint;
  assert.deepEqual(Object.keys(pending).sort(), ["scope", "state", "version"]);
  assert.equal(pending.version, 1);
  assert.deepEqual(pending.state.pending, [note("a")]);
  assert.equal(pending.state.cursor, C);
  applied(await first.pull());
  assert.deepEqual(first.read(), [note("a"), note("b")]);
  const saved = storage.dump()[partition].checkpoint.state;
  assert.deepEqual(saved.visible, [note("a"), note("b")]);
  assert.equal(saved.cursor, D);
  assert.equal(JSON.stringify(saved).includes("title"), false);

  const wire = scripted(() => { throw Error("offline"); }, json(change([{ kind: "edit", noteId: "a", projectId: null, revision: 2 }])));
  const resumed = client(storage, wire.transport);
  assert.equal(await resumed.activate(scope()), "restored_unverified");
  assert.deepEqual(resumed.read(), [], "disk cursor grants no right to read");
  assert.deepEqual(await resumed.pull(), { kind: "retry" });
  assert.deepEqual(resumed.read(), [], "offline refresh never exposes old metadata");
  applied(await resumed.pull());
  assert.deepEqual(resumed.read(), [note("a", 2), note("b")]);
  assert.equal(new URL(wire.calls[0].url, "https://localhost").searchParams.get("cursor"), D);
  assert.equal(new URL(wire.calls[1].url, "https://localhost").searchParams.get("cursor"), D);
  assert.equal(storage.dump()[partition].checkpoint.state.cursor, D);
});

test("a 401/404 wipes partition and locks client, including data from a previous session", async () => {
  for (const status of [401, 404]) {
    const storage = new MemoryTargetSyncStorage();
    const w = scripted(json(boot([note("secret")])), json({ error: "Denied" }, status));
    const first = client(storage, w.transport);
    await first.activate(scope());
    applied(await first.pull());
    assert.deepEqual(first.read(), [note("secret")]);
    assert.deepEqual(await first.pull(), { kind: "locked" });
    assert.deepEqual(first.read(), []);
    assert.equal(first.currentScope(), null);
    assert.deepEqual(await names(storage), []);
    const retry = client(storage, scripted(json(boot([]))).transport);
    assert.equal(await retry.activate(scope()), "fresh", "revoked disk cache cannot be restored");
  }
});

test("409 resync discards persistent cursor before next bootstrap or restart", async () => {
  const storage = new MemoryTargetSyncStorage();
  const wire = scripted(json(boot([note("old")])), json({ code: "resync_required" }, 409));
  const first = client(storage, wire.transport);
  await first.activate(scope());
  applied(await first.pull());
  assert.deepEqual(await first.pull(), { kind: "resync_required" });
  assert.deepEqual(first.read(), []);
  assert.equal(storage.dump()[noteMetadataNamespace(scope())].checkpoint, undefined);
  const after = scripted(json(boot([note("new")])));
  const restarted = client(storage, after.transport);
  assert.equal(await restarted.activate(scope()), "fresh");
  applied(await restarted.pull());
  assert.deepEqual(restarted.read(), [note("new")]);
  assert.equal(new URL(after.calls[0].url, "https://localhost").searchParams.has("cursor"), false);
});

test("actor, Area and restore-generation switches wipe earlier partitions", async () => {
  const storage = new MemoryTargetSyncStorage();
  const wire = scripted(json(boot([note("alice")])), json(boot([note("bob")])), json(boot([])));
  const p = client(storage, wire.transport);
  await p.activate(scope());
  applied(await p.pull());
  const alicePartition = noteMetadataNamespace(scope());
  assert.ok(storage.dump()[alicePartition]);
  await p.activate(scope("bob", "shared"));
  assert.equal(storage.dump()[alicePartition], undefined);
  assert.deepEqual(p.read(), []);
  applied(await p.pull());
  assert.deepEqual(p.read(), [note("bob")]);
  await p.activate(scope("bob", "shared", "123e4567-e89b-42d3-a456-426614174001"));
  assert.deepEqual(await names(storage), [noteMetadataNamespace(scope("bob", "shared",
    "123e4567-e89b-42d3-a456-426614174001"))]);
  assert.deepEqual(p.read(), []);
  applied(await p.pull());
  assert.deepEqual(p.read(), []);
  await p.clear();
  assert.deepEqual(await names(storage), []);
  assert.equal(p.currentScope(), null);
});

test("malformed, content-bearing, future-version or wrong-scope snapshots are erased", async () => {
  for (const bad of [
    { version: 2, scope: scope(), state: { phase: "bootstrap", visible: [], pending: [], cursor: null } },
    { version: 1, scope: scope("bob"), state: { phase: "bootstrap", visible: [], pending: [], cursor: null } },
    { version: 1, scope: scope(), state: { phase: "changes", visible: [{ ...note("n"), title: "secret" }], pending: [], cursor: C } },
    { version: 1, scope: scope(), state: { phase: "changes", visible: [note("n"), note("n")], pending: [], cursor: C } },
  ]) {
    const storage = new MemoryTargetSyncStorage();
    const key = noteMetadataNamespace(scope());
    const ns = await storage.openNamespace(key);
    await ns.transaction([{ kind: "put", key: "checkpoint", value: bad }]);
    const wire = scripted(json(boot([note("safe")])));
    const p = client(storage, wire.transport);
    assert.equal(await p.activate(scope()), "fresh");
    assert.deepEqual(p.read(), []);
    assert.deepEqual(storage.dump()[key], {});
    applied(await p.pull());
    assert.deepEqual(p.read(), [note("safe")]);
    assert.equal(new URL(wire.calls[0].url, "https://localhost").searchParams.has("cursor"), false);
  }
});

test("checkpoint decoder rejects content, wrong phase, duplicates and unbounded arrays", () => {
  const state = { phase: "changes", cursor: C, pending: [], visible: [note("a")] };
  assert.deepEqual(decodeNoteSyncCheckpoint(state), state);
  assert.equal(decodeNoteSyncCheckpoint({ ...state, visible: [{ ...note("a"), body: "private" }] }), null);
  assert.equal(decodeNoteSyncCheckpoint({ ...state, visible: [note("a"), note("a")] }), null);
  assert.equal(decodeNoteSyncCheckpoint({ ...state, cursor: "bad" }), null);
  assert.equal(decodeNoteSyncCheckpoint({ ...state, phase: "bootstrap" }), null);
  assert.equal(decodeNoteSyncCheckpoint({ ...state, visible: Array(4097).fill(note("x")) }), null);
  assert.equal(decodeNoteSyncCheckpoint({ ...state, extra: "private" }), null);
});

test("failure midway through atomic write never publishes an uncommitted cursor", async () => {
  const storage = new MemoryTargetSyncStorage();
  storage.injectFailure({ transaction: 1, afterOps: 0 });
  const w = scripted(json(boot([note("uncommitted")])));
  const p = client(storage, w.transport);
  await p.activate(scope());
  assert.deepEqual(await p.pull(), { kind: "storage_error" });
  assert.deepEqual(p.read(), []);
  assert.equal(p.currentScope(), null);
  const ns = storage.dump()[noteMetadataNamespace(scope())];
  assert.equal(ns?.checkpoint, undefined);
  const resumed = client(storage, scripted(json(boot([note("fresh")]))).transport);
  assert.equal(await resumed.activate(scope()), "fresh");
  applied(await resumed.pull());
  assert.deepEqual(resumed.read(), [note("fresh")]);
});

test("delayed HTTP completion after sign-out cannot recreate a wiped namespace", async () => {
  const storage = new MemoryTargetSyncStorage();
  let finish;
  const w = scripted(() => new Promise(resolve => { finish = resolve; }));
  const p = client(storage, w.transport);
  await p.activate(scope());
  const late = p.pull();
  await p.clear();
  finish(json(boot([note("secret")])));
  assert.deepEqual(await late, { kind: "superseded" });
  assert.deepEqual(await names(storage), []);
  assert.deepEqual(p.read(), []);
});

test("a second simultaneous pull is busy rather than duplicating a disk commit", async () => {
  const storage = new MemoryTargetSyncStorage();
  let finish;
  const w = scripted(() => new Promise(resolve => { finish = resolve; }));
  const p = client(storage, w.transport);
  await p.activate(scope());
  const first = p.pull();
  assert.deepEqual(await p.pull(), { kind: "busy" });
  finish(json(boot([note("one")])));
  applied(await first);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(p.read(), [note("one")]);
  assert.equal(storage.committed, 1);
});
