import assert from "node:assert/strict";
import test from "node:test";

const { captureMarkers, clearAllMarkers, clearSentMarkers, markPending, pendingDeletedIds, pendingRevivedIds, recordDeleted, recordRevived, pendingKey, deletedKey, revivedKey } = await import("../lib/pending-markers.ts");

function memoryStorage() {
  const values = new Map();
  const writes = [];
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { writes.push({ key, existed: values.has(key) }); values.set(key, String(value)); },
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    values, writes,
  };
}

test("a save removes only the bookkeeping it sent", () => {
  const storage = memoryStorage();
  recordDeleted(storage, "sent-deletion");
  recordRevived(storage, "sent-revival");
  markPending(storage);
  const sent = captureMarkers(storage);
  // Another tab deletes and restores other records while this save is on its way.
  recordDeleted(storage, "later-deletion");
  recordRevived(storage, "later-revival");
  markPending(storage);
  clearSentMarkers(storage, sent);
  assert.deepEqual(pendingDeletedIds(storage), ["later-deletion"]);
  assert.deepEqual(pendingRevivedIds(storage), ["later-revival"]);
  assert.equal(storage.getItem(pendingKey), "1");
});

test("a record deleted, restored and deleted again during a save stays deleted", () => {
  const storage = memoryStorage();
  recordDeleted(storage, "x");
  markPending(storage);
  const sent = captureMarkers(storage);
  assert.deepEqual(sent.deleted, ["x"]);
  // Another tab restores it and deletes it again before the first save is answered.
  recordRevived(storage, "x");
  markPending(storage);
  recordDeleted(storage, "x");
  markPending(storage);
  clearSentMarkers(storage, sent);
  assert.deepEqual(pendingDeletedIds(storage), ["x"]);
  assert.deepEqual(pendingRevivedIds(storage), []);
  assert.equal(storage.getItem(pendingKey), "1");
});

test("a record deleted and then restored during a save is restored", () => {
  const storage = memoryStorage();
  recordDeleted(storage, "x");
  const sent = captureMarkers(storage);
  recordRevived(storage, "x");
  clearSentMarkers(storage, sent);
  assert.deepEqual(pendingDeletedIds(storage), []);
  assert.deepEqual(pendingRevivedIds(storage), ["x"]);
});

test("with nothing new since, everything sent is cleared; older shared lists are moved to keys of their own", () => {
  const storage = memoryStorage();
  storage.setItem(deletedKey, JSON.stringify(["old-format", { id: "old-op-format", op: "x" }]));
  markPending(storage);
  const sent = captureMarkers(storage);
  assert.deepEqual(sent.deleted.sort(), ["old-format", "old-op-format"]);
  assert.equal(storage.getItem(deletedKey), null);
  clearSentMarkers(storage, sent);
  assert.deepEqual([...storage.values.keys()].filter((key) => key.startsWith(deletedKey)), []);
  assert.equal(storage.getItem(pendingKey), null);
});

// Tabs write to the same storage independently. Recording never rewrites a value that is already
// there (which would lose another tab's write made in between), it only adds a key of its own.
test("recording a deletion or restoration only ever adds a new key", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 20; index += 1) {
    recordDeleted(storage, `d${index}`);
    recordRevived(storage, `r${index}`);
  }
  assert.equal(storage.writes.filter((write) => write.existed).length, 0);
  assert.equal(pendingDeletedIds(storage).length, 20);
  assert.equal(pendingRevivedIds(storage).length, 20);
});

test("two tabs deleting different records at the same moment keep both deletions", () => {
  const storage = memoryStorage();
  // What each tab writes does not depend on what it read, so the order does not matter.
  recordDeleted(storage, "from-tab-a");
  recordDeleted(storage, "from-tab-b");
  const sent = captureMarkers(storage);
  assert.deepEqual(sent.deleted.sort(), ["from-tab-a", "from-tab-b"]);
});

test("a deletion and a restoration of one record left side by side: the later decides, both are cleared", () => {
  const storage = memoryStorage();
  storage.setItem(`${deletedKey}:0000000001-a-000001`, "x");
  storage.setItem(`${revivedKey}:0000000002-b-000001`, "x");
  markPending(storage);
  const sent = captureMarkers(storage);
  assert.deepEqual(sent.deleted, []);
  assert.deepEqual(sent.revived, ["x"]);
  clearSentMarkers(storage, sent);
  assert.deepEqual(pendingDeletedIds(storage), []);
  assert.deepEqual(pendingRevivedIds(storage), []);
});

test("a request for a save made after the capture keeps the waiting mark", () => {
  const storage = memoryStorage();
  markPending(storage);
  const sent = captureMarkers(storage);
  markPending(storage);
  clearSentMarkers(storage, sent);
  assert.equal(storage.getItem(pendingKey), "1");
});

test("clearing all bookkeeping removes every entry", () => {
  const storage = memoryStorage();
  recordDeleted(storage, "a");
  recordRevived(storage, "b");
  markPending(storage);
  clearAllMarkers(storage);
  assert.deepEqual([...storage.values.keys()].filter((key) => key !== pendingKey), []);
});

test("a shared list written again by an old tab after it was moved loses nothing", () => {
  const storage = memoryStorage();
  storage.setItem(deletedKey, JSON.stringify(["a", "b"]));
  assert.deepEqual(pendingDeletedIds(storage).sort(), ["a", "b"]);
  storage.setItem(deletedKey, JSON.stringify(["c"]));
  assert.deepEqual(pendingDeletedIds(storage).sort(), ["a", "b", "c"]);
  // Entries moved from the shared list are older than any new one.
  recordDeleted(storage, "d");
  const sent = captureMarkers(storage);
  storage.setItem(deletedKey, JSON.stringify(["e"]));
  clearSentMarkers(storage, sent);
  assert.deepEqual(pendingDeletedIds(storage), ["e"]);
});

test("an operation is placed after an operation of the same record it has seen, even with a clock behind", () => {
  const storage = memoryStorage();
  // Another tab (its clock a little ahead) deleted the record.
  storage.setItem(`${deletedKey}:zzzzzzzzzzzz0-othertab-000001`, "x");
  recordRevived(storage, "x");
  assert.deepEqual(pendingRevivedIds(storage), ["x"]);
  assert.deepEqual(pendingDeletedIds(storage), []);
  // And the other way round.
  storage.setItem(`${revivedKey}:zzzzzzzzzzzz1-othertab-000002`, "y");
  recordDeleted(storage, "y");
  assert.deepEqual(pendingDeletedIds(storage), ["y"]);
});
