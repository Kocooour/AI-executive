import assert from "node:assert/strict";
import test from "node:test";

const { failWhileOffline, isDataRequest, isSessionEnd, needsAccess, watchSession } = await import("../lib/session-watch.ts");
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

test("while offline, data requests fail at once; sign-in, access checks and other origins go out", async () => {
  let offline = true;
  const sent = [];
  const guarded = failWhileOffline(async (input) => { sent.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); return new Response("{}"); },
    origin, () => offline, () => "Offline.");
  await assert.rejects(() => guarded("/api/work-sessions", { method: "POST" }), (error) => error instanceof TypeError && error.message === "Offline.");
  await assert.rejects(() => guarded(new Request(`${origin}/api/store`)), TypeError);
  await assert.rejects(() => guarded(new URL("/api/day-plan", origin)), TypeError);
  await assert.rejects(() => guarded("/api/auth/passkeys/register/options", { method: "POST" }), TypeError);
  await assert.rejects(() => guarded("/api/auth/passkeys", { method: "DELETE" }), TypeError);
  await guarded("/api/auth/status");
  await guarded("/api/auth/logout", { method: "POST" });
  await guarded("https://elsewhere.example/api/store");
  await guarded("/manifest.webmanifest");
  offline = false;
  await guarded("/api/work-sessions", { method: "POST" });
  assert.deepEqual(sent, ["/api/auth/status", "/api/auth/logout", "https://elsewhere.example/api/store", "/manifest.webmanifest", "/api/work-sessions"]);
});

test("a data request is an API of this origin other than sign-in", () => {
  assert.equal(isDataRequest("/api/store", origin), true);
  assert.equal(isDataRequest("/api/auth/status", origin), false);
  assert.equal(isDataRequest("https://elsewhere.example/api/store", origin), false);
  assert.equal(isDataRequest("/offline", origin), false);
});

test("what goes out without confirmed access: the access check, signing in and signing out", () => {
  for (const path of ["/api/auth/status", "/api/auth/login", "/api/auth/logout", "/api/auth/passkeys/login/options", "/api/auth/passkeys/login/verify"]) assert.equal(needsAccess(path, origin), false, path);
  for (const path of ["/api/store", "/api/auth/passkeys", "/api/auth/passkeys/register/options", "/api/auth/passkeys/register/verify"]) assert.equal(needsAccess(path, origin), true, path);
  assert.equal(needsAccess("https://elsewhere.example/api/store", origin), false);
});
