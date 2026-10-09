import assert from "node:assert/strict";
import test from "node:test";

const { attentionCacheKey, cachedAttention, saveAttention } = await import("../lib/attention-cache.ts");

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: (key) => data.delete(key), data };
}

test("the last evaluation is kept per workspace and only returned for that workspace", () => {
  const storage = memoryStorage();
  saveAttention(storage, { workspaceId: "personal", items: [{ title: "Osobní" }] }, 1);
  saveAttention(storage, { workspaceId: "shared-1", items: [] }, 2);
  assert.equal(cachedAttention(storage, "personal").items[0].title, "Osobní");
  assert.equal(cachedAttention(storage, "shared-1").items.length, 0);
  assert.equal(cachedAttention(storage, "all"), null);
  saveAttention(storage, { workspaceId: "personal", items: [] }, 3);
  assert.equal(cachedAttention(storage, "personal").items.length, 0);
});

test("an entry whose evaluation belongs to another workspace is not shown", () => {
  const storage = memoryStorage();
  storage.setItem(attentionCacheKey, JSON.stringify([{ workspaceId: "shared-1", savedAt: 1, evaluation: { workspaceId: "personal", items: [{ title: "Osobní" }] } }]));
  assert.equal(cachedAttention(storage, "shared-1"), null);
});

test("damaged or missing data is ignored, and old workspaces are dropped", () => {
  const storage = memoryStorage();
  storage.setItem(attentionCacheKey, "{not json");
  assert.equal(cachedAttention(storage, "personal"), null);
  for (let index = 0; index < 12; index += 1) saveAttention(storage, { workspaceId: `w${index}`, items: [] }, index);
  assert.equal(JSON.parse(storage.getItem(attentionCacheKey)).length, 8);
  assert.equal(cachedAttention(storage, "w0"), null);
  assert.ok(cachedAttention(storage, "w11"));
});

test("a full storage keeps at least the newest evaluation", () => {
  const storage = memoryStorage();
  let calls = 0;
  const setItem = storage.setItem;
  storage.setItem = (key, value) => { calls += 1; if (JSON.parse(value).length > 1) throw new Error("QuotaExceededError"); setItem(key, value); };
  saveAttention(storage, { workspaceId: "a", items: [] }, 1);
  saveAttention(storage, { workspaceId: "b", items: [] }, 2);
  assert.ok(cachedAttention(storage, "b"));
  assert.equal(cachedAttention(storage, "a"), null);
  assert.ok(calls >= 3);
});
