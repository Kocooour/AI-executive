import assert from "node:assert/strict";
import test from "node:test";

import { fetchClientAuthStatus } from "../lib/client-auth-status.ts";

test("authentication check resolves a valid server status", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal);
      return new Response(JSON.stringify({ enabled: true, configured: true, authenticated: false }), { status: 200 });
    };
    assert.deepEqual(await fetchClientAuthStatus(100), {
      enabled: true, configured: true, authenticated: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authentication check rejects a hanging request and aborts it", async () => {
  const originalFetch = globalThis.fetch;
  let signal;
  try {
    globalThis.fetch = (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    };
    await assert.rejects(fetchClientAuthStatus(20), /timed out/);
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authentication check rejects errors and malformed responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("Server error", { status: 503 });
    await assert.rejects(fetchClientAuthStatus(100), /unavailable/);
    globalThis.fetch = async () => new Response(JSON.stringify({ authenticated: true }), { status: 200 });
    await assert.rejects(fetchClientAuthStatus(100), /Invalid authentication status/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
