import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceRateLimit, trustedClientIdentity } from "../lib/http-security.ts";

let bucketSerial = 0;
const freshBucket = () => `test-rate-limit-${process.pid}-${++bucketSerial}`;
const request = (headers = {}) => new Request("http://127.0.0.1:3000/api/x", { headers });

test("identity uses the last proxy-controlled X-Forwarded-For hop", () => {
  // Tailscale Serve replaces the header with exactly one tailnet address.
  assert.equal(trustedClientIdentity(request({ "x-forwarded-for": "100.101.102.103" })), "100.101.102.103");
  // An appending proxy keeps the client's spoofed prefix; only the last hop counts.
  assert.equal(
    trustedClientIdentity(request({ "x-forwarded-for": "203.0.113.9, 198.51.100.7, 100.64.0.5" })),
    "100.64.0.5",
  );
  assert.equal(trustedClientIdentity(request({ "x-forwarded-for": " 100.64.0.5 " })), "100.64.0.5");
});

test("client-only headers and malformed hops never create private buckets", () => {
  assert.equal(trustedClientIdentity(request()), "proxy-unknown");
  assert.equal(trustedClientIdentity(request({ "x-real-ip": "100.64.0.9" })), "proxy-unknown");
  for (const value of ["100.64.0.5, ", "100.64.0.5, abc", "1", "999.1.1.1", "01.2.3.4",
    "fd7a:115c::1:2:3:4:5:6:7", "a".repeat(80), "evil, ::ffff:zz", "100.64.0.5, unknown"]) {
    assert.equal(trustedClientIdentity(request({ "x-forwarded-for": value })), "proxy-unknown", value);
  }
});

test("equivalent IPv6 and IPv4-mapped spellings share one canonical bucket", () => {
  const ids = ["fd7a:115c:a1e0::1", "FD7A:115C:A1E0:0:0:0:0:1", "fd7a:115c:a1e0:0000::0001"]
    .map((value) => trustedClientIdentity(request({ "x-forwarded-for": value })));
  assert.deepEqual(new Set(ids), new Set(["fd7a:115c:a1e0::1"]));
  assert.equal(trustedClientIdentity(request({ "x-forwarded-for": "::ffff:100.64.0.5" })), "100.64.0.5");
});

test("spoofed distinct first X-Forwarded-For values still hit the per-client limit", () => {
  const bucket = freshBucket();
  const limit = 5;
  const results = [];
  for (let i = 0; i < 40; i++) {
    results.push(enforceRateLimit(request({
      "x-forwarded-for": `198.18.${i >> 8}.${i & 255}, 100.64.0.5`,
      "x-real-ip": `198.19.0.${i}`,
    }), bucket, limit, 60_000));
  }
  assert.equal(results.filter((value) => value === null).length, limit);
  assert.deepEqual(results[limit], { error: "Too many requests", status: 429, retryAfter: 60 });
  assert.ok(results.slice(limit).every((value) => value?.status === 429));
});

test("legitimate proxied clients remain distinguishable", () => {
  const bucket = freshBucket();
  const limit = 3;
  const send = (ip) => enforceRateLimit(request({ "x-forwarded-for": ip }), bucket, limit, 60_000);
  for (let i = 0; i < limit; i++) assert.equal(send("100.64.0.5"), null);
  assert.equal(send("100.64.0.5")?.status, 429);
  // Another tailnet device is not locked out by the noisy one.
  for (let i = 0; i < limit; i++) assert.equal(send("100.64.0.6"), null);
  assert.equal(send("fd7a:115c:a1e0::6"), null);
});

test("unparsable forwarding collapses into one shared limited bucket", () => {
  const bucket = freshBucket();
  const results = Array.from({ length: 10 }, (_, i) =>
    enforceRateLimit(request({ "x-forwarded-for": `100.64.0.${i}, junk-${i}` }), bucket, 4, 60_000));
  assert.equal(results.filter((value) => value === null).length, 4);
});
