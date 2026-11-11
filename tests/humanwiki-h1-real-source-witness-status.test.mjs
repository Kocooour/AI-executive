import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { createSessionToken, sessionCookieName } from "../lib/auth.ts";
import { bootstrapIsolatedTargetStore } from "../lib/target-store-bootstrap.ts";
import {
  bootstrapHumanWikiConsentPrivateLedger, withHumanWikiConsentPrivateLedger,
} from "../lib/humanwiki-consent-private-store.mjs";
import { humanWikiConsentIntentLocalHead, appendHumanWikiConsentIntent }
  from "../lib/humanwiki-consent-intents.mjs";
import {
  bootstrapWitnessStore, witnessCurrentHead, publishWitnessCheckpoint,
} from "../services/humanwiki-witness/store.mjs";
import { createWitnessHttpsServer } from "../services/humanwiki-witness/server.mjs";
import { GET } from "../app/api/humanwiki/source-witness-status/route.ts";
import { POST as withdrawalPost } from "../app/api/humanwiki/withdrawal-intent/route.ts";
import { POST as importPost } from "../app/api/humanwiki/import/route.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-real8-source-status-"));
const stage = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "staging"), ownerUserId: "owner-alice",
});
const ledgerDir = mkdtempSync(path.join(root, "ledger-"));
const witnessDir = mkdtempSync(path.join(root, "witness-"));
const tlsDir = mkdtempSync(path.join(root, "tls-"));
const ledgerKey = Buffer.alloc(32, 0x8e);
const registryId = randomUUID();
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const ZERO = "0".repeat(64);
const sourceNames = ["chatgpt_user_export", "claude_user_export"];
const publicSpki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const ownerSecret = "h1-real8-owner-test-secret-at-least-32-chars";
const passwordHash = "scrypt:" + Buffer.alloc(16, 3).toString("base64url") +
  ":" + Buffer.alloc(64, 4).toString("base64url");
const origin = "https://witness.example.org";
const endpoint = "https://lumi.invalid/api/humanwiki/source-witness-status";
const witnessPath = "/v1/humanwiki/high-water/challenge";
const envKeys = [
  "NODE_ENV", "AI_EXECUTIVE_AUTH_ENABLED", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
  "AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID",
  "AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY",
  "AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY",
  "AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID",
  "AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN",
  "AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL",
  "AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED",
  "AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED",
  "AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED",
];
const savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
let server, port, certFile, fetched = 0, fetchAdapter;
before(async () => {
  assert.equal(bootstrapHumanWikiConsentPrivateLedger(ledgerDir).ok, true);
  assert.equal(bootstrapWitnessStore(witnessDir, registryId, privateKey).ok, true);
  const keyFile = path.join(tlsDir, "key.pem");
  certFile = path.join(tlsDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  chmodSync(keyFile, 0o600);
  server = createWitnessHttpsServer({
    directory: witnessDir, registryId, privateKey,
    tlsKey: readFileSync(keyFile), tlsCert: readFileSync(certFile),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = server.address().port;
  // Test transport has real certificate-verified TLS and the production
  // listener. The production route keeps strict external-origin validation,
  // request size/nonce/signature checks, and all authorization guards.
  fetchAdapter = async (url, opts) => {
    fetched++;
    assert.equal(url, origin + witnessPath);
    assert.equal(opts.method, "POST");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.cache, "no-store");
    assert.equal(opts.credentials, "omit");
    assert.equal(opts.headers["content-type"], "application/json");
    assert.ok(opts.signal instanceof AbortSignal);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "127.0.0.1", servername: "localhost", port,
        method: "POST", path: witnessPath,
        ca: readFileSync(certFile), headers: opts.headers, signal: opts.signal,
      }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode, headers: res.headers,
        })));
      });
      req.on("error", reject);
      req.end(opts.body);
    });
  };
  globalThis.fetch = fetchAdapter;
});
after(async () => {
  globalThis.fetch = previousFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

let ip = 30;
function configure() {
  process.env.NODE_ENV = "production";
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  process.env.AI_EXECUTIVE_PASSWORD_HASH = passwordHash;
  process.env.AI_EXECUTIVE_SESSION_SECRET = ownerSecret;
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = stage.ownerUserId;
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID = stage.unassignedAreaId;
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY = ledgerDir;
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY =
    ledgerKey.toString("base64url");
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID = registryId;
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN = origin;
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL = publicSpki;
  process.env.AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED = "true";
  process.env.AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED = "true";
  delete process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED;
  globalThis.fetch = fetchAdapter;
}
function ownerReq(token, url = endpoint) {
  ip++;
  return new Request(url, { headers: {
    ...(token ? { cookie: sessionCookieName + "=" + token } : {}),
    "x-forwarded-for": "198.51.100." + ip,
  } });
}
function withdrawReq(token, sourceType, expectedRevision) {
  ip++;
  return new Request("https://lumi.invalid/api/humanwiki/withdrawal-intent", {
    method: "POST", headers: {
      cookie: sessionCookieName + "=" + token,
      "x-forwarded-for": "198.51.100." + ip,
      "content-type": "application/json", origin: "https://lumi.invalid",
    },
    body: JSON.stringify({
      commandId: randomUUID(), decision: "withdrawal_requested",
      sourceType, purpose: "humanwiki_context_bootstrap",
      retentionDays: null, expectedRevision, explicitConfirmation: true,
    }),
  });
}
async function denied(response) {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
}
const localHead = () => withHumanWikiConsentPrivateLedger(ledgerDir, "read", db => {
  const s = humanWikiConsentIntentLocalHead(db, ledgerKey);
  assert.equal(s.ok, true);
  return { sequence: s.sequence, digest: s.digest };
});
const witnessHead = () => witnessCurrentHead(witnessDir, registryId, privateKey);
function publishLocalTail() {
  const current = witnessHead(), local = localHead();
  assert.equal(local.sequence, current.sequence + 1);
  const tuple = {
    sequence: local.sequence, previousDigest: current.digest, digest: local.digest,
  };
  assert.equal(publishWitnessCheckpoint(witnessDir, registryId, privateKey, tuple).ok, true);
}
const assertNoPrivileges = status => {
  assert.equal(status.importAuthorized, false);
  assert.equal(status.consentVerified, false);
  assert.equal(status.independentWitnessVerified, false);
  assert.equal(status.withdrawalComplete, false);
  assert.equal(status.realImportEnabled, false);
  assert.equal(status.claimsCreated, 0);
};
const cleanSources = (chatgptRevision, claudeRevision) => ({
  chatgpt_user_export: {
    revision: chatgptRevision,
    latestIntent: chatgptRevision ? "withdrawal_requested" : null,
  },
  claude_user_export: {
    revision: claudeRevision,
    latestIntent: claudeRevision ? "withdrawal_requested" : null,
  },
});

test("owner HTTP observes real source-specific withdrawal intent and live signed TLS witness", async () => {
  configure();
  const token = createSessionToken();
  const empty = await GET(ownerReq(token));
  assert.equal(empty.status, 200);
  const e = await empty.json();
  assert.equal(e.witnessState, "signed_remote_head_matches_local");
  assert.deepEqual(e.sources, cleanSources(0, 0));
  assertNoPrivileges(e);
  assert.equal(empty.headers.get("cache-control"), "no-store");

  const write = await withdrawalPost(withdrawReq(token, sourceNames[0], 0));
  assert.equal(write.status, 200, "uses the live authenticated source-specific writer");
  assert.equal((await write.json()).withdrawalComplete, false);
  assert.equal(localHead().sequence, 1);
  const pending = await GET(ownerReq(token));
  assert.equal(pending.status, 200);
  const p = await pending.json();
  assert.equal(p.witnessState, "signed_remote_prefix_requires_catchup");
  assert.deepEqual(p.sources, cleanSources(1, 0));
  assertNoPrivileges(p);
  assert.equal(witnessHead().sequence, 0, "GET may not publish a checkpoint");

  publishLocalTail();
  const matched = await GET(ownerReq(token));
  assert.equal(matched.status, 200);
  const m = await matched.json();
  assert.equal(m.witnessState, "signed_remote_head_matches_local");
  assert.deepEqual(m.sources, cleanSources(1, 0));
  assertNoPrivileges(m);

  const claude = await withdrawalPost(withdrawReq(token, sourceNames[1], 0));
  assert.equal(claude.status, 200);
  const second = await GET(ownerReq(token));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).witnessState,
    "signed_remote_prefix_requires_catchup");
  publishLocalTail();
  const synced = await GET(ownerReq(token));
  assert.equal(synced.status, 200);
  assert.deepEqual((await synced.json()).sources, cleanSources(1, 1));
  const payload = JSON.stringify(await (await GET(ownerReq(token))).json());
  for (const sensitive of [stage.ownerUserId, stage.unassignedAreaId,
    ledgerDir, registryId, localHead().digest, ownerSecret]) {
    assert.equal(payload.includes(sensitive), false, "no raw keys or scoped evidence in HTTP");
  }

  process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED = "true";
  const upload = new Request("https://lumi.invalid/api/humanwiki/import", {
    method: "POST", body: "private user history must remain unread",
    headers: { "content-type": "application/json" },
  });
  await denied(await importPost(upload));
  assert.equal(upload.bodyUsed, false);
  configure();
});

test("auth, area, flags, params and key-pinning fail before protected observation", async () => {
  configure();
  const validToken = createSessionToken();
  const count = fetched;
  process.env.AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED = "false";
  await denied(await GET(ownerReq(validToken)));
  configure();
  await denied(await GET(ownerReq(null)));
  await denied(await GET(ownerReq("forged")));
  await denied(await GET(ownerReq(validToken, endpoint + "?source=chatgpt_user_export")));
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID = "shared-or-foreign";
  await denied(await GET(ownerReq(validToken)));
  configure();
  assert.equal(fetched, count, "untrusted callers cannot trigger external witness I/O");

  const otherKey = generateKeyPairSync("ed25519").publicKey;
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL =
    otherKey.export({ format: "der", type: "spki" }).toString("base64url");
  await denied(await GET(ownerReq(validToken)));
  configure();
});

test("a local append racing signed network observation is rejected", async () => {
  configure();
  const token = createSessionToken();
  let once = true;
  globalThis.fetch = async (url, options) => {
    const received = await fetchAdapter(url, options);
    if (once) {
      once = false;
      const status = withHumanWikiConsentPrivateLedger(ledgerDir, "write", db =>
        appendHumanWikiConsentIntent(db, ledgerKey, {
          ownerUserId: stage.ownerUserId, privateAreaId: stage.unassignedAreaId,
        }, {
          commandId: randomUUID(), decision: "withdrawal_requested",
          sourceType: sourceNames[0], purpose: "humanwiki_context_bootstrap",
          retentionDays: null, expectedRevision: 1, explicitConfirmation: true,
        }));
      assert.equal(status.ok, true);
    }
    return received;
  };
  await denied(await GET(ownerReq(token)));
  assert.equal(once, false);
  assert.equal(witnessHead().sequence, 2, "observer did not silently publish race event");
  configure();
  // Signed current remote state is a valid prefix, but its local successor
  // remains non-authorizing and cannot be reported as a completed withdrawal.
  const status = await GET(ownerReq(token));
  assert.equal(status.status, 200);
  assert.equal((await status.json()).witnessState,
    "signed_remote_prefix_requires_catchup");
});

test("foreign scoped events cannot leak, and config revocation during TLS fails closed", async () => {
  configure();
  const token = createSessionToken();
  // A physically shared HMAC chain can carry events from many actors; only
  // the authenticated owner's private scope may affect the JSON projection.
  const foreign = withHumanWikiConsentPrivateLedger(ledgerDir, "write", db =>
    appendHumanWikiConsentIntent(db, ledgerKey, {
      ownerUserId: "different-owner", privateAreaId: "other-private-area",
    }, {
      commandId: randomUUID(), decision: "withdrawal_requested",
      sourceType: sourceNames[0], purpose: "humanwiki_context_bootstrap",
      retentionDays: null, expectedRevision: 0, explicitConfirmation: true,
    }));
  assert.equal(foreign.ok, true);
  const observed = await GET(ownerReq(token));
  assert.equal(observed.status, 200);
  const data = await observed.json();
  assert.deepEqual(data.sources, cleanSources(2, 1));
  assert.equal(data.witnessState, "signed_remote_prefix_requires_catchup");
  assertNoPrivileges(data);
  assert.equal(JSON.stringify(data).includes("different-owner"), false);

  // The signed response can be perfectly valid but the operator may revoke
  // this endpoint while HTTPS is in flight; do not return the stale 200.
  globalThis.fetch = async (url, options) => {
    const signed = await fetchAdapter(url, options);
    process.env.AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED = "false";
    return signed;
  };
  await denied(await GET(ownerReq(token)));
  configure();
});

test("a signed foreign witness digest blocks even the read-only source projection", async () => {
  configure();
  const token = createSessionToken();
  // Witness sequence 2, local sequence >=3: publish a foreign-but-signed seq 3.
  const current = witnessHead();
  assert.equal(current.sequence, 2);
  assert.equal(publishWitnessCheckpoint(witnessDir, registryId, privateKey, {
    sequence: 3, previousDigest: current.digest, digest: "e".repeat(64),
  }).ok, true);
  await denied(await GET(ownerReq(token)));
});
