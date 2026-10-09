import assert from "node:assert/strict";
import test from "node:test";

const { captureMarkers, clearSentMarkers, markPending, pendingDeletedIds, pendingRevivedIds, recordDeleted, recordRevived, pendingKey, deletedKey } = await import("../lib/pending-markers.ts");

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
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

test("with nothing new since, everything sent is cleared; older plain lists are read", () => {
  const storage = memoryStorage();
  storage.setItem(deletedKey, JSON.stringify(["old-format"]));
  markPending(storage);
  const sent = captureMarkers(storage);
  assert.deepEqual(sent.deleted, ["old-format"]);
  clearSentMarkers(storage, sent);
  assert.equal(storage.getItem(deletedKey), null);
  assert.equal(storage.getItem(pendingKey), null);
});
