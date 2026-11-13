import assert from "node:assert/strict";
import test from "node:test";
import { createSessionToken, sessionCookieName } from "./support/owner-session-test-cookie.mjs";
import { GET } from "../app/api/humanwiki/readiness/route.ts";
import { POST } from "../app/api/humanwiki/import/route.ts";

const endpoint = "https://lumi.invalid/api/humanwiki/readiness";
const configuration = [
  "NODE_ENV", "AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_HUMANWIKI_READINESS_ENABLED",
  "AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED",
];
const validHash = "scrypt:" + Buffer.alloc(16, 7).toString("base64url") +
  ":" + Buffer.alloc(64, 8).toString("base64url");

async function withConfiguredOwner(callback) {
  const old = configuration.map(key => process.env[key]);
  try {
    process.env.NODE_ENV = "production";
    process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
    process.env.AI_EXECUTIVE_PASSWORD_HASH = validHash;
    process.env.AI_EXECUTIVE_SESSION_SECRET = "test-only-owner-cookie-secret-opaque-42-characters";
    process.env.AI_EXECUTIVE_HUMANWIKI_READINESS_ENABLED = "true";
    delete process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED;
    await callback();
  } finally {
    configuration.forEach((key, index) => {
      if (old[index] === undefined) delete process.env[key];
      else process.env[key] = old[index];
    });
  }
}

const request = (token, extras = {}) =>
  new Request(endpoint, {
    headers: { ...(token === undefined ? {} : {cookie: sessionCookieName + "=" + token}), ...extras },
  });
const assertHidden = async (response) => {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("set-cookie"), null);
};

test("H1-real.1 owner-only readiness stays default-off even with a signed owner cookie", async () => {
  await withConfiguredOwner(async () => {
    const cookie = createSessionToken();
    delete process.env.AI_EXECUTIVE_HUMANWIKI_READINESS_ENABLED;
    await assertHidden(await GET(request(cookie)));
    for (const flag of ["false", "1", "TRUE", "enabled", ""]) {
      process.env.AI_EXECUTIVE_HUMANWIKI_READINESS_ENABLED = flag;
      await assertHidden(await GET(request(cookie)));
    }
  });
});

test("H1-real.1 readiness uses a real configured owner cookie, not spoofed identity or development bypass", async () => {
  await withConfiguredOwner(async () => {
    const cookie = createSessionToken();
    await assertHidden(await GET(request()));
    await assertHidden(await GET(request("fake.owner.token")));
    await assertHidden(await GET(request(createSessionToken(-1))));
    await assertHidden(await GET(request(cookie + ".tampered")));
    await assertHidden(await GET(request(undefined, {
      authorization: "Bearer forged-integration-token",
      "x-actor-authenticated": "true",
      "x-owner-private": "true",
      "x-area-allowed": "true",
      "x-humanwiki-consent-verified": "true",
    })));

    // A signed cookie minted with the old secret becomes invalid immediately
    // after a secret rotation; neither the status nor gate metadata is released.
    process.env.AI_EXECUTIVE_SESSION_SECRET = "a-different-valid-owner-cookie-secret-at-least-32";
    await assertHidden(await GET(request(cookie)));
    process.env.AI_EXECUTIVE_SESSION_SECRET = "test-only-owner-cookie-secret-opaque-42-characters";

    delete process.env.AI_EXECUTIVE_PASSWORD_HASH;
    await assertHidden(await GET(request(cookie)));
    process.env.AI_EXECUTIVE_PASSWORD_HASH = validHash;

    process.env.NODE_ENV = "test";
    process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
    await assertHidden(await GET(request()));
    await assertHidden(await GET(request(cookie)));
    process.env.NODE_ENV = "production";
    process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  });
});

test("H1-real.1 verified owner sees only six unfinished gates, no real consent or import authority", async () => {
  await withConfiguredOwner(async () => {
    const cookie = createSessionToken();
    const response = await GET(request(cookie));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("set-cookie"), null);
    const data = await response.json();
    assert.equal(data.result, "blocked_not_enabled");
    assert.equal(data.enabled, false);
    assert.equal(data.real_actor_or_area_verified, false);
    assert.equal(data.explicit_owner_consent_received, false);
    assert.equal(data.independent_witness_verified, false);
    assert.equal(data.real_data_accepted, false);
    assert.equal(data.real_data_read, false);
    assert.equal(data.data_stored, false);
    assert.equal(data.external_model_egress, false);
    assert.equal(data.mail_content_import_in_scope, false);
    assert.equal(data.claims_created, 0);
    assert.equal(data.tasks_created, 0);
    assert.equal(data.prerequisites.length, 6);
    assert.ok(data.prerequisites.every(gate => gate.status === "not_verified_blocked"));
    const encoded = JSON.stringify(data);
    for (const privateMarker of ["test-only-owner-cookie", "fake.owner.token",
      "email_body", "session_secret", "actor_user_id", "area_id", "consent_token"]) {
      assert.ok(!encoded.includes(privateMarker), privateMarker);
    }
    assert.deepEqual(await (await GET(request(cookie, {
      "x-humanwiki-source": "claude",
      "x-owner-private": "true",
    }))).json(), data, "client hints cannot claim a completed gate");
  });
});

test("H1-real.1 signed owner readiness cannot unlock the deny-only import POST", async () => {
  await withConfiguredOwner(async () => {
    const cookie = createSessionToken();
    process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED = "true";
    assert.equal((await GET(request(cookie))).status, 200);
    const incoming = new Request("https://lumi.invalid/api/humanwiki/import", {
      method: "POST",
      headers: { cookie: sessionCookieName + "=" + cookie, "content-type": "application/json" },
      body: '{"private_data":"never parse"}',
    });
    const refused = await POST(incoming);
    await assertHidden(refused);
    assert.equal(incoming.bodyUsed, false, "the import endpoint still must never consume payload");
  });
});

test("H1-real.1 malformed GET request fails closed without leaking request or server details", async () => {
  await withConfiguredOwner(async () => {
    let probes = 0;
    const hostile = new Proxy({}, {
      get() { probes++; throw Error("intentional hostile request"); },
      getPrototypeOf() { probes++; throw Error("hostile prototype"); },
    });
    const reply = await GET(hostile);
    await assertHidden(reply);
    assert.ok(probes > 0, "route authenticates against the real incoming request");
  });
});
