import assert from "node:assert/strict";
import test from "node:test";

const { otherOpenTexts, renewOpenTexts, setOpenTexts, openTextsMaxAgeMs } = await import("../lib/open-texts.ts");

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

test("open texts of other tabs are counted, the own and cleared ones are not", () => {
  const storage = memoryStorage();
  setOpenTexts(storage, "me", ["title"]);
  setOpenTexts(storage, "other", ["capture"]);
  assert.deepEqual(otherOpenTexts(storage, "me").map(([owner]) => owner), ["other"]);
  setOpenTexts(storage, "other", []);
  assert.deepEqual(otherOpenTexts(storage, "me"), []);
});

test("a note of a tab long gone is ignored and removed when a tab is shown", () => {
  const storage = memoryStorage();
  setOpenTexts(storage, "crashed", ["capture"]);
  const later = Date.now() + openTextsMaxAgeMs + 1;
  assert.deepEqual(otherOpenTexts(storage, "me", later), []);
  renewOpenTexts(storage, "me", later);
  assert.equal(storage.getItem("ai-executive-open-texts"), null);
});
