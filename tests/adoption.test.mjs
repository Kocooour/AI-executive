import assert from "node:assert/strict";
import test from "node:test";

const adoption = await import("../lib/adoption.ts");
const markers = await import("../lib/pending-markers.ts");
const drafts = await import("../lib/notes-drafts.ts");

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
