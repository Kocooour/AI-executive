import assert from "node:assert/strict";
import test from "node:test";

const { isSessionEnd, watchSession } = await import("../lib/session-watch.ts");
const origin = "https://lumi.example";

test("a refused data request ends the session", () => {
  assert.equal(isSessionEnd("/api/store", 401, origin), true);
  assert.equal(isSessionEnd("/api/attention?workspaceId=personal", 401, origin), true);
  assert.equal(isSessionEnd(`${origin}/api/day-plan`, 401, origin), true);
});

test("sign-in endpoints, other statuses and other origins are not a signal", () => {
  assert.equal(isSessionEnd("/api/auth/login", 401, origin), false);
  assert.equal(isSessionEnd("/api/auth/passkeys/login/verify", 401, origin), false);
  assert.equal(isSessionEnd("/api/store", 403, origin), false);
  assert.equal(isSessionEnd("/api/store", 409, origin), false);
  assert.equal(isSessionEnd("/api/store", 500, origin), false);
  assert.equal(isSessionEnd("/manifest.webmanifest", 401, origin), false);
  assert.equal(isSessionEnd("https://elsewhere.example/api/store", 401, origin), false);
  assert.equal(isSessionEnd("/api/authentic", 401, origin), true);
});

test("the wrapper reports once per refused response and passes every response through unchanged", async () => {
  const responses = { "/api/store": 401, "/api/attention": 200, "/api/auth/login": 401 };
  let ended = 0;
  const pathOf = (input) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin).pathname;
  const watched = watchSession(async (input) => new Response("{}", { status: responses[pathOf(input)] }), origin, () => { ended += 1; });
  assert.equal((await watched("/api/attention")).status, 200);
  assert.equal(ended, 0);
  assert.equal((await watched("/api/auth/login")).status, 401);
  assert.equal(ended, 0);
  const refused = await watched("/api/store");
  assert.equal(refused.status, 401);
  assert.equal(await refused.text(), "{}");
  assert.equal(ended, 1);
  assert.equal((await watched(new URL("/api/store", origin))).status, 401);
  assert.equal((await watched(new Request(`${origin}/api/store`))).status, 401);
  assert.equal(ended, 3);
});

test("a network failure is not a session end", async () => {
  let ended = 0;
  const watched = watchSession(async () => { throw new TypeError("Failed to fetch"); }, origin, () => { ended += 1; });
  await assert.rejects(() => watched("/api/store"), TypeError);
  assert.equal(ended, 0);
});
