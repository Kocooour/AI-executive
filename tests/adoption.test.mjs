import assert from "node:assert/strict";
import test from "node:test";

const adoption = await import("../lib/adoption.ts");
const markers = await import("../lib/pending-markers.ts");
const drafts = await import("../lib/notes-drafts.ts");
const barrier = await import("../lib/owner-adoption-barrier.ts");

// A Dexie DBCore stand-in: records the writes that reach the database.
function fakeCore() {
  const written = [];
  const core = { stack: "dbcore", schema: {}, transaction: () => ({}), table: (name) => ({ name, schema: {}, mutate: async (request) => { written.push([name, request.type, request.trans]); return { numFailures: 0, failures: {} }; } }) };
  return { core, written };
}
function memoryStorage() {
  const store = new Map();
  return { store, getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key),
    key: (index) => [...store.keys()][index] ?? null, get length() { return store.size; } };
}

test("the notice flag is kept per tab, read once, and an explicit action's flag wins over a later notice", () => {
  const store = new Map();
  globalThis.sessionStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  assert.equal(adoption.takeAfterRestoreFlag(), null);
  adoption.setAfterRestoreFlag("restore", true);
  adoption.setAfterRestoreFlag("remote");
  assert.equal(adoption.takeAfterRestoreFlag(), "restore");
  assert.equal(adoption.takeAfterRestoreFlag(), null, "read once");
  adoption.setAfterRestoreFlag("sibling");
  assert.equal(adoption.takeAfterRestoreFlag(), "sibling");
  store.set(adoption.afterRestoreFlagKey, "garbage");
  assert.equal(adoption.takeAfterRestoreFlag(), null);
  delete globalThis.sessionStorage;
  assert.doesNotThrow(() => adoption.setAfterRestoreFlag("remote"));
});

test("once adoption has begun the flag stays set for the page's remaining life", () => {
  assert.equal(adoption.isAdopting(), false);
  adoption.beginAdoption();
  assert.equal(adoption.isAdopting(), true);
});

test("from the start of adoption the local database refuses every write except those of adoption's own transaction", async () => {
  // (The flag is set by the test above; it never goes back, so the write before adoption is checked through a fresh module.)
  const fresh = await import(`../lib/adoption.ts?before=${Date.now()}`);
  const before = fakeCore();
  await fresh.adoptionWriteGuard(before.core).table("entities").mutate({ trans: {}, type: "put", values: [{ id: "a" }] });
  assert.equal(before.written.length, 1, "before adoption every write passes");

  const { core, written } = fakeCore();
  const guarded = adoption.adoptionWriteGuard(core);
  const late = {}, own = {};
  adoption.allowAdoptionWrites(own);
  for (const type of ["add", "put", "delete", "deleteRange"]) {
    await assert.rejects(guarded.table("entities").mutate({ trans: late, type, values: [{ id: "a" }], keys: ["a"] }), (error) => error instanceof adoption.AdoptionWriteRefused && error.name === "AdoptionWriteRefused");
  }
  await assert.rejects(guarded.table("baseEntities").mutate({ trans: late, type: "put", values: [{ id: "a" }] }), adoption.AdoptionWriteRefused);
  assert.deepEqual(written, [], "a write queued by another save path never reaches the database");
  await guarded.table("entities").mutate({ trans: own, type: "deleteRange" });
  await guarded.table("entities").mutate({ trans: own, type: "add", values: [{ id: "a" }] });
  assert.deepEqual(written.map(([table, type]) => `${table}:${type}`), ["entities:deleteRange", "entities:add"], "adoption's own clear and bulkAdd pass");
});

test("after adoption has begun no pending mark, deletion, restoration or notes draft is recorded", () => {
  assert.equal(adoption.isAdopting(), true);
  const storage = memoryStorage();
  markers.markPending(storage);
  markers.recordDeleted(storage, "task-1");
  markers.recordRevived(storage, "task-2");
  drafts.keepNotesDraft(storage, "page", "task-3", "stale", "", 1);
  assert.deepEqual([...storage.store.keys()], []);
  assert.deepEqual(markers.pendingDeletedIds(storage), []);
  assert.deepEqual(drafts.keptNotesDrafts(storage), []);
});

test("a sibling cannot write while owner adoption is fenced or after another tab advances generation", () => {
  const state = memoryStorage();
  assert.equal(barrier.crossTabAdoptionBlocked(undefined, state), false);
  state.setItem(barrier.ownerAdoptionGenerationKey, "4");
  state.setItem("ai-executive-server-synced", "1");
  assert.equal(barrier.crossTabAdoptionBlocked(undefined, state), true, "legacy synced tab has no generation");
  assert.equal(barrier.crossTabAdoptionBlocked(4, state), false);
  barrier.startOwnerAdoptionFence(state, 5);
  assert.equal(barrier.crossTabAdoptionBlocked(4, state), true);
  assert.equal(barrier.crossTabAdoptionBlocked(5, state), true);
  barrier.finishOwnerAdoptionFence(state);
  state.setItem(barrier.ownerAdoptionGenerationKey, "5");
  assert.equal(barrier.crossTabAdoptionBlocked(4, state), true);
  assert.equal(barrier.crossTabAdoptionBlocked(5, state), false);
});
test("a single undeleted tombstone or context draft blocks owner adoption certification", () => {
  const state = memoryStorage();
  state.setItem("ai-executive-pending-deletions:e2e", "task-1");
  assert.throws(() => barrier.assertOwnerAdoptionCleanup(state), /OWNER_ADOPTION_LOCAL_CLEANUP_INCOMPLETE/);
  state.removeItem("ai-executive-pending-deletions:e2e");
  state.setItem("ai-executive-project-context-drafts:old", "unsent");
  assert.throws(() => barrier.assertOwnerAdoptionCleanup(state), /OWNER_ADOPTION_LOCAL_CLEANUP_INCOMPLETE/);
  state.removeItem("ai-executive-project-context-drafts:old");
  assert.doesNotThrow(() => barrier.assertOwnerAdoptionCleanup(state));
});

test("only a fully committed owner adoption can finish a stale fence", () => {
  const store = memoryStorage();
  store.setItem("ai-executive-server-synced", "1");
  barrier.startOwnerAdoptionFence(store, 7);
  assert.equal(barrier.ownerAdoptionReadyToFinish(store), false, "old generation still current");
  store.setItem(barrier.ownerAdoptionGenerationKey, "7");
  assert.equal(barrier.ownerAdoptionReadyToFinish(store), true);
  store.setItem("ai-executive-pending-deletions:e2e", "old-item");
  assert.throws(() => barrier.ownerAdoptionReadyToFinish(store), /OWNER_ADOPTION_LOCAL_CLEANUP_INCOMPLETE/);
  store.removeItem("ai-executive-pending-deletions:e2e");
  const originalRemove = store.removeItem;
  store.removeItem = key => {
    if (key === barrier.ownerAdoptionFenceKey) throw new Error("injected fence removal failure");
    originalRemove(key);
  };
  assert.throws(() => barrier.finishOwnerAdoptionFence(store), /injected fence removal failure/);
  assert.equal(barrier.ownerAdoptionReadyToFinish(store), true, "commit remains recoverable after failed fence removal");
  store.removeItem = originalRemove;
  barrier.finishOwnerAdoptionFence(store);
  assert.equal(store.getItem(barrier.ownerAdoptionFenceKey), null);
});


test("a late ordinary sync cannot roll back a certified owner-adopted generation", () => {
  const storage = memoryStorage();
  storage.setItem(barrier.ownerAdoptionGenerationKey, "4");
  assert.equal(barrier.persistOrdinaryGeneration(storage, 4, 4), true);
  barrier.startOwnerAdoptionFence(storage, 5, 4);
  assert.deepEqual(barrier.readOwnerAdoptionFence(storage), {
    version: 1, observedGeneration: 5, knownGeneration: 4,
  });
  assert.equal(barrier.persistOrdinaryGeneration(storage, 4, 4), false, "stale stamp is refused during adoption");
  storage.setItem(barrier.ownerAdoptionGenerationKey, "5");
  storage.setItem("ai-executive-server-synced", "1");
  barrier.finishOwnerAdoptionFence(storage);
  assert.equal(barrier.persistOrdinaryGeneration(storage, 4, 4), false, "late sync cannot roll generation back");
  assert.equal(storage.getItem(barrier.ownerAdoptionGenerationKey), "5");
  assert.equal(barrier.persistOrdinaryGeneration(storage, 5, 4), false, "ordinary sync cannot certify an earlier generation");
  assert.equal(barrier.persistOrdinaryGeneration(storage, 5, 5), true);
});

test("an unfinished owner restore cannot be mistaken for a completed adoption", () => {
  const storage = memoryStorage();
  storage.setItem("ai-executive-server-synced", "1");
  storage.setItem(barrier.ownerAdoptionGenerationKey, "3");
  barrier.startOwnerAdoptionFence(storage, 4, 3);
  assert.equal(barrier.ownerAdoptionReadyToFinish(storage), false);
  assert.equal(barrier.readOwnerAdoptionFence(storage).knownGeneration, 3);
  storage.setItem(barrier.ownerAdoptionGenerationKey, "4");
  storage.setItem("ai-executive-pending-deletions:stale", "id");
  assert.throws(() => barrier.ownerAdoptionReadyToFinish(storage), /LOCAL_CLEANUP_INCOMPLETE/);
  storage.removeItem("ai-executive-pending-deletions:stale");
  assert.equal(barrier.ownerAdoptionReadyToFinish(storage), true);
});
