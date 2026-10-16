import assert from "node:assert/strict";
import test from "node:test";

const adoption = await import("../lib/adoption.ts");

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
