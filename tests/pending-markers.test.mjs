import assert from "node:assert/strict";
import test from "node:test";

const { captureMarkers, clearSentMarkers, markPending, pendingKey, deletedKey, revivedKey } = await import("../lib/pending-markers.ts");

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

test("a save removes only the bookkeeping it sent", () => {
  const storage = memoryStorage();
  storage.setItem(deletedKey, JSON.stringify(["sent-deletion"]));
  storage.setItem(revivedKey, JSON.stringify(["sent-revival"]));
  markPending(storage);
  const sent = captureMarkers(storage);
  // Another tab deletes and restores something while this save is on its way.
  storage.setItem(deletedKey, JSON.stringify(["sent-deletion", "later-deletion"]));
  storage.setItem(revivedKey, JSON.stringify(["sent-revival", "later-revival"]));
  markPending(storage);
  clearSentMarkers(storage, sent);
  assert.deepEqual(JSON.parse(storage.getItem(deletedKey)), ["later-deletion"]);
  assert.deepEqual(JSON.parse(storage.getItem(revivedKey)), ["later-revival"]);
  assert.equal(storage.getItem(pendingKey), "1");
});

test("with nothing new since, everything sent is cleared", () => {
  const storage = memoryStorage();
  storage.setItem(deletedKey, JSON.stringify(["a"]));
  markPending(storage);
  const sent = captureMarkers(storage);
  clearSentMarkers(storage, sent);
  assert.equal(storage.getItem(deletedKey), null);
  assert.equal(storage.getItem(revivedKey), null);
  assert.equal(storage.getItem(pendingKey), null);
});
