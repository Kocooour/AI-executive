import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/humanwiki/import/route.ts";

const endpoint = "https://lumi.invalid/api/humanwiki/import";

test("HumanWiki H1-real POST server entry denies a real Request before consuming its body", async () => {
  for (const source of [
    { type: "chatgpt", contentType: "application/json", body: '{"conversations":["secret-personal-export"]}' },
    { type: "claude", contentType: "multipart/form-data; boundary=boundary", body: "--boundary\r\nprivate conversation\r\n--boundary--" },
  ]) {
    const request = new Request(endpoint + "?consent=true&verified=true", {
      method: "POST",
      headers: {
        "content-type": source.contentType,
        "origin": "https://untrusted.invalid",
        "authorization": "Bearer forged-consent-token",
        "x-owner-private-area": "true",
        "x-humanwiki-import-consent": "true",
        "x-humanwiki-provider": source.type,
      },
      body: source.body,
    });
    assert.equal(request.bodyUsed, false);
    const response = await POST(request);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), { error: "Not found" });
    assert.equal(request.bodyUsed, false, "server handler must never parse or consume the request body");
    assert.equal(await request.text(), source.body, "full body must remain unread and unchanged");
  }
});

test("HumanWiki H1-real POST never reads even a hostile Request proxy", async () => {
  let propertyReads = 0;
  const poison = new Proxy({}, {
    get() { propertyReads++; throw Error("server handler touched untrusted request"); },
    getPrototypeOf() { propertyReads++; throw Error("server handler checked request prototype"); },
    ownKeys() { propertyReads++; throw Error("server handler enumerated request"); },
    getOwnPropertyDescriptor() { propertyReads++; throw Error("server handler inspected descriptor"); },
  });
  const response = await POST(poison);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
  assert.equal(propertyReads, 0, "entry route must not access headers, body, URL or request metadata");
});

test("HumanWiki H1-real POST denies forged consent and every importer feature-toggle value", async () => {
  const flags = [
    "AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED",
  ];
  const before = flags.map(flag => process.env[flag]);
  try {
    for (const value of ["true", "1", "enabled", "false", ""]) {
      flags.forEach(flag => { process.env[flag] = value; });
      const request = new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-authenticated": "true",
          "x-area-allowed": "true",
          "x-consent-verified": "true",
          "x-revocation-witness-verified": "true",
          "x-r4-approved": "true",
        },
        body: JSON.stringify({ source: "chatgpt", verified: true, consent: true, approved: true }),
      });
      const response = await POST(request);
      assert.equal(response.status, 404, value);
      assert.deepEqual(await response.json(), { error: "Not found" });
      assert.equal(request.bodyUsed, false);
    }
  } finally {
    flags.forEach((flag, i) => {
      if (before[i] === undefined) delete process.env[flag];
      else process.env[flag] = before[i];
    });
  }
});

test("HumanWiki H1-real server route exposes no approved upload method or content", async () => {
  const request = new Request(endpoint, { method: "POST", body: "sensitive material" });
  const response = await POST(request);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("location"), null);
  const content = await response.text();
  for (const forbidden of ["sensitive material", "consent_token", "source_id", "actor_id", "claims", "ChatGPT"]) {
    assert.ok(!content.includes(forbidden), forbidden);
  }
  assert.equal(request.bodyUsed, false);
});
