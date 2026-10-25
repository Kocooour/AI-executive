import assert from "node:assert/strict";
import test from "node:test";
import { installRestoreFence } from "../lib/restore-fence-client.ts";
import {
  beginOfflineRecoveryHoldSafely, offlineRecoveryHoldKey, offlineRecoveryIsHeld,
  readOfflineRecoveryHold,
} from "../lib/d2b-recovery-hold.ts";

test("409 restored engages an immediate write fence using its generation, without a second GET", async () => {
  const savedWindow = globalThis.window;
  const savedStorage = globalThis.localStorage;
  const savedNavigator = globalThis.navigator;
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  let networkCalls = 0;
  const page = {
    location: { href: "https://lumi.test/", origin: "https://lumi.test" },
    fetch: async (input, init) => {
      networkCalls++;
      if ((init?.method ?? "GET").toUpperCase() === "GET") throw new Error("network unavailable");
      return new Response(JSON.stringify({ code: "restored", restoreGeneration: 3 }), {
        status: 409, headers: { "content-type": "application/json" },
      });
    },
  };
  let pending;
  let observed;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: page });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: async (_name, callback) => callback() } },
    });
    installRestoreFence({
      generation: () => 2,
      onRestored: (generation) => {
        observed = generation;
        // This hook runs directly in the 409 response handler, no extra fetch
        // or sync queue. The write barrier activates before its promise settles.
        pending = beginOfflineRecoveryHoldSafely(2, generation);
        assert.equal(offlineRecoveryIsHeld(), true);
      },
    });
    const response = await page.fetch("/api/context/claims", { method: "POST", body: "{}" });
    assert.equal(response.status, 409);
    assert.equal(observed, 3);
    assert.equal(networkCalls, 1, "the response itself carries the generation; never retry GET first");
    await pending;
    assert.equal(readOfflineRecoveryHold(storage).observedGeneration, 3);
    assert.ok(storage.getItem(offlineRecoveryHoldKey));
    await assert.rejects(page.fetch("/api/context/claims", { method: "POST", body: "{}" }), /OFFLINE_RECOVERY_HELD/);
    assert.equal(networkCalls, 1, "subsequent mutations are blocked locally");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: savedWindow });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: savedStorage });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: savedNavigator });
  }
});
