import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import https from "node:https";
import { DatabaseSync } from "node:sqlite";
import { createWitnessHttpsServer } from "../services/humanwiki-witness/server.mjs";
import {
  bootstrapHumanWikiConsentPrivateLedger, withHumanWikiConsentPrivateLedger,
  withHumanWikiConsentPrivateLedgerAsync,
} from "../lib/humanwiki-consent-private-store.mjs";
import {
  appendHumanWikiConsentIntent, humanWikiConsentIntentLocalHead,
} from "../lib/humanwiki-consent-intents.mjs";
import {
  planHumanWikiWitnessCatchup, HUMANWIKI_WITNESS_CATCHUP_SCHEMA,
} from "../lib/humanwiki-witness-catchup.mjs";
import {
  humanWikiWitnessChallengePayload, HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA,
} from "../lib/humanwiki-consent-witness-preflight.mjs";
import {
  bootstrapWitnessStore, witnessChallengeReceipt, publishWitnessCheckpoint,
  witnessCurrentHead,
} from "../services/humanwiki-witness/store.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-h1-real7-"));
after(() => rmSync(root, { recursive: true, force: true }));
const directory = () => mkdtempSync(path.join(root, "private-"));
const ZERO = "0".repeat(64);
const scope = { ownerUserId: "owner", privateAreaId: "private-area" };
const ledgerKey = Buffer.alloc(32, 0x56);
const fixture = () => {
  const local = directory();
  const remote = directory();
  const registryId = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  bootstrapHumanWikiConsentPrivateLedger(local);
  assert.equal(bootstrapWitnessStore(remote, registryId, privateKey).ok, true);
  const provider = async ({registryId: id, nonce, signal}) => {
    assert.equal(id, registryId);
    assert.equal(signal.aborted, false);
    return witnessChallengeReceipt(remote, id, privateKey, nonce);
  };
  const plan = (getFreshReceipt = provider, key = publicKey) =>
    withHumanWikiConsentPrivateLedgerAsync(local, db =>
      planHumanWikiWitnessCatchup({
        db, ledgerKey, registryId, witnessPublicKey: key, getFreshReceipt,
      }));
  const append = (expectedRevision, sourceType = "chatgpt_user_export") =>
    withHumanWikiConsentPrivateLedger(local, "write", db =>
      appendHumanWikiConsentIntent(db, ledgerKey, scope, {
        commandId: randomUUID(), sourceType,
        decision: "withdrawal_requested",
        purpose: "humanwiki_context_bootstrap",
        retentionDays: null, expectedRevision, explicitConfirmation: true,
      }));
  const head = () => withHumanWikiConsentPrivateLedger(local, "read", db =>
    humanWikiConsentIntentLocalHead(db, ledgerKey));
  return { local, remote, registryId, privateKey, publicKey, provider,
    plan, append, head };
};
const refused = result => {
  assert.equal(result.ok, false);
  assert.equal(result.importAuthorized, false);
  assert.equal(result.consentVerified, false);
  assert.equal(result.independentWitnessVerified, false);
  assert.equal(result.withdrawalComplete, false);
};

test("real HMAC ledger and signed witness yield only next contiguous offline step", async () => {
  const f = fixture();
  const genesis = await f.plan();
  assert.equal(genesis.ok, true);
  assert.equal(genesis.checkpoint, null);
  assert.equal(genesis.result, "current_signed_witness_matches_local_head_for_operator_only");
  assert.equal(f.append(0).ok, true);
  assert.equal(f.append(1).ok, true);
  const start = f.head();
  assert.equal(start.sequence, 2);
  const one = await f.plan();
  assert.equal(one.schema, HUMANWIKI_WITNESS_CATCHUP_SCHEMA);
  assert.equal(one.ok, true);
  assert.equal(one.result, "next_offline_witness_checkpoint_proposed_not_acknowledged");
  assert.equal(one.checkpoint.sequence, 1);
  assert.equal(one.checkpoint.previousDigest, ZERO);
  assert.match(one.checkpoint.digest, /^[0-9a-f]{64}$/);
  assert.equal(one.importAuthorized, false);
  assert.equal(one.consentVerified, false);
  assert.equal(one.independentWitnessVerified, false);
  assert.equal(one.withdrawalComplete, false);
  assert.equal(witnessCurrentHead(f.remote, f.registryId, f.privateKey).sequence, 0,
    "making a proposal cannot publish anything");

  const repeat = await f.plan();
  assert.deepEqual(repeat.checkpoint, one.checkpoint);
  const publishedOne = publishWitnessCheckpoint(
    f.remote, f.registryId, f.privateKey, one.checkpoint);
  assert.equal(publishedOne.ok, true);
  const two = await f.plan();
  assert.equal(two.ok, true);
  assert.equal(two.checkpoint.sequence, 2);
  assert.equal(two.checkpoint.previousDigest, one.checkpoint.digest);
  assert.equal(two.checkpoint.digest, start.digest);
  assert.equal(publishWitnessCheckpoint(
    f.remote, f.registryId, f.privateKey, two.checkpoint).ok, true);
  const done = await f.plan();
  assert.equal(done.ok, true);
  assert.equal(done.checkpoint, null);
  assert.equal(done.withdrawalComplete, false,
    "an equal signed head is not a completed source revocation");
  assert.deepEqual(witnessCurrentHead(f.remote, f.registryId, f.privateKey),
    { sequence: 2, digest: start.digest });
});

test("a witness ahead of local or signed for a different prefix fails closed", async () => {
  const f = fixture();
  assert.equal(f.append(0).ok, true);
  const one = await f.plan();
  assert.equal(publishWitnessCheckpoint(
    f.remote, f.registryId, f.privateKey, one.checkpoint).ok, true);
  // Advance the remote witness to a signed but *foreign* second checkpoint.
  assert.equal(publishWitnessCheckpoint(f.remote, f.registryId, f.privateKey, {
    sequence: 2, previousDigest: one.checkpoint.digest, digest: "a".repeat(64),
  }).ok, true);
  refused(await f.plan());

  const g = fixture();
  assert.equal(g.append(0).ok, true);
  const local = g.head();
  assert.equal(publishWitnessCheckpoint(g.remote, g.registryId, g.privateKey, {
    sequence: 1, previousDigest: ZERO, digest: "b".repeat(64),
  }).ok, true);
  assert.notEqual(local.digest, "b".repeat(64));
  refused(await g.plan());
});

test("forged signer, nonce, malformed receipt and key are rejected", async () => {
  const f = fixture();
  assert.equal(f.append(0).ok, true);
  const other = generateKeyPairSync("ed25519");
  refused(await f.plan(async ({registryId, nonce}) => ({
    version: HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA,
    registryId, nonce, sequence: 0, digest: ZERO,
    signature: sign(null,
      humanWikiWitnessChallengePayload(registryId, nonce, 0, ZERO),
      other.privateKey).toString("base64url"),
  })));
  refused(await f.plan(async ({registryId}) =>
    witnessChallengeReceipt(f.remote, registryId, f.privateKey,
      Buffer.alloc(32, 0x31).toString("base64url"))));
  refused(await f.plan(async args => ({
    ...(await f.provider(args)), extra: "not-allowed",
  })));
  refused(await f.plan(f.provider, other.publicKey));
  refused(await f.plan(f.provider, other.privateKey));
});

test("a local append while remote check is pending cannot leave a usable proposal", async () => {
  const f = fixture();
  assert.equal(f.append(0).ok, true);
  const result = await f.plan(async args => {
    const receipt = await f.provider(args);
    assert.equal(f.append(1).ok, true);
    return receipt;
  });
  refused(result);
  assert.equal(f.head().sequence, 2);
  assert.equal(witnessCurrentHead(f.remote, f.registryId, f.privateKey).sequence, 0);
});

test("wrong ledger key, missing witness and corrupted HMAC history fail closed", async () => {
  const f = fixture();
  assert.equal(f.append(0).ok, true);
  refused(await f.plan(async () => { throw Error("unavailable"); }));
  refused(await f.plan(async () => ({ no: "receipt" })));
  const badKey = Buffer.alloc(8);
  const local = await withHumanWikiConsentPrivateLedgerAsync(f.local, db =>
    planHumanWikiWitnessCatchup({
      db, ledgerKey: badKey, registryId: f.registryId,
      witnessPublicKey: f.publicKey, getFreshReceipt: f.provider,
    }));
  refused(local);
  // A short invalid key is not a corrupted ledger: actually modify the
  // on-disk signed row, then restore the canonical append-only trigger.
  const db = new DatabaseSync(path.join(f.local, "humanwiki-consent-intents.sqlite"));
  try {
    const trigger = db.prepare(`SELECT sql FROM sqlite_master
      WHERE name = 'humanwiki_consent_intent_no_update'`).get().sql;
    db.exec("DROP TRIGGER humanwiki_consent_intent_no_update");
    db.prepare("UPDATE humanwiki_consent_intent_events SET event_mac = ? WHERE seq = 1")
      .run("f".repeat(64));
    db.exec(trigger + ";");
  } finally { db.close(); }
  let remoteReads = 0;
  refused(await f.plan(async args => {
    remoteReads++;
    return f.provider(args);
  }));
  assert.equal(remoteReads, 0, "corrupt local HMAC chain must refuse before remote I/O");
});

test("planner enforces its own 2s deadline and aborts cooperative witness I/O", {
  timeout: 7000,
}, async () => {
  const f = fixture();
  assert.equal(f.append(0).ok, true);
  let abortCount = 0;
  let gotSignal = false;
  const result = await f.plan(({ signal }) => {
    gotSignal = signal instanceof AbortSignal && !signal.aborted;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        abortCount++;
        reject(Error("witness I/O aborted"));
      }, { once: true });
    });
  });
  refused(result);
  assert.equal(result.checkpoint, undefined, "no publish tuple may escape timeout");
  assert.equal(gotSignal, true);
  assert.equal(abortCount, 1);
  assert.equal(witnessCurrentHead(f.remote, f.registryId, f.privateKey).sequence, 0);
});

test("operator CLI is default-off and rejects export paths without reading data", () => {
  const cli = fileURLToPath(new URL(
    "../scripts/humanwiki/witness-catchup-operator.mjs", import.meta.url));
  const disabled = spawnSync(process.execPath, [cli], {
    env: { ...process.env,
      AI_EXECUTIVE_HUMANWIKI_WITNESS_CATCHUP_OPERATOR_ENABLED: "false" },
    encoding: "utf8",
  });
  assert.notEqual(disabled.status, 0);
  assert.equal(disabled.stdout, "");
  assert.match(disabled.stderr, /catch-up blocked/);

  const invalidArgument = spawnSync(process.execPath,
    [cli, "/nonexistent/private-export.json"], {
      env: { ...process.env,
        AI_EXECUTIVE_HUMANWIKI_WITNESS_CATCHUP_OPERATOR_ENABLED: "true" },
      encoding: "utf8",
    });
  assert.notEqual(invalidArgument.status, 0);
  assert.equal(invalidArgument.stdout, "");
  assert.match(invalidArgument.stderr, /catch-up blocked/);
});

/**
 * Synthetic test-only preload: preserve the production CLI's pinned HTTPS
 * URL validation and provider signature checks, while routing the request
 * over a REAL mutually verified TLS connection to a loopback witness.
 * This exists only as a child-process --import file in the isolated test.
 * No test override, custom port, or unverified TLS exception enters Lumi code.
 */
const bridgeSource = `
import https from "node:https";
import { readFileSync } from "node:fs";
const url = "https://witness.example.org/v1/humanwiki/high-water/challenge";
globalThis.fetch = async (target, init) => {
  if (target !== url || init?.method !== "POST" ||
      init?.redirect !== "error" || init?.cache !== "no-store" ||
      init?.credentials !== "omit" ||
      init?.headers?.["content-type"] !== "application/json")
    throw Error("unexpected witness request");
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "127.0.0.1",
      servername: "localhost",
      port: Number(process.env.LUMI_TEST_WITNESS_TLS_PORT),
      method: "POST",
      path: "/v1/humanwiki/high-water/challenge",
      ca: readFileSync(process.env.LUMI_TEST_WITNESS_TLS_CA),
      headers: init.headers,
      signal: init.signal,
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode, headers: res.headers,
      })));
    });
    req.on("error", reject);
    req.end(init.body);
  });
};
`;

// Node 24 currently warns when a child imports node:sqlite. Keep unexpected
// stderr fatal: do NOT globally hide warnings or mute the operator CLI.
const assertCleanOperatorStderr = stderr => {
  const onlySqliteWarning = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use \x60node --trace-warnings ...\x60 to show where the warning was created\)\n$/;
  assert.ok(stderr === "" || onlySqliteWarning.test(stderr),
    "unexpected operator CLI stderr: " + stderr);
};

async function executeOperatorCli(env) {
  const cli = fileURLToPath(new URL(
    "../scripts/humanwiki/witness-catchup-operator.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("operator CLI uses pinned real TLS witness and handles lag and sync", {
  timeout: 18000,
}, async () => {
  const f = fixture();
  const tlsDir = directory();
  const tlsKey = path.join(tlsDir, "tls-key.pem");
  const cert = path.join(tlsDir, "tls-cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", tlsKey, "-out", cert, "-days", "1",
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  chmodSync(tlsKey, 0o600);
  const bridge = path.join(tlsDir, "test-https-preload.mjs");
  writeFileSync(bridge, bridgeSource, { mode: 0o600 });
  const server = createWitnessHttpsServer({
    directory: f.remote, registryId: f.registryId, privateKey: f.privateKey,
    tlsKey: readFileSync(tlsKey), tlsCert: readFileSync(cert),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const env = {
      ...process.env,
      NODE_OPTIONS: "--import=" + pathToFileURL(bridge).href,
      LUMI_TEST_WITNESS_TLS_PORT: String(server.address().port),
      LUMI_TEST_WITNESS_TLS_CA: cert,
      AI_EXECUTIVE_HUMANWIKI_WITNESS_CATCHUP_OPERATOR_ENABLED: "true",
      AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY: f.local,
      AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY:
        ledgerKey.toString("base64url"),
      AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID: f.registryId,
      AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN:
        "https://witness.example.org",
      AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL:
        f.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    };
    const synced = await executeOperatorCli(env);
    assert.equal(synced.code, 0, synced.stderr);
    assertCleanOperatorStderr(synced.stderr);
    const initial = JSON.parse(synced.stdout);
    assert.equal(initial.ok, true);
    assert.equal(initial.checkpoint, null);
    assert.equal(initial.importAuthorized, false);
    assert.equal(initial.consentVerified, false);
    assert.equal(initial.independentWitnessVerified, false);
    assert.equal(initial.withdrawalComplete, false);

    assert.equal(f.append(0).ok, true);
    const lag = await executeOperatorCli(env);
    assert.equal(lag.code, 0, lag.stderr);
    assertCleanOperatorStderr(lag.stderr);
    const proposal = JSON.parse(lag.stdout);
    assert.equal(proposal.ok, true);
    assert.equal(proposal.checkpoint.sequence, 1);
    assert.equal(proposal.checkpoint.previousDigest, ZERO);
    assert.equal(proposal.checkpoint.digest, f.head().digest);
    assert.equal(proposal.importAuthorized, false);
    assert.equal(proposal.withdrawalComplete, false);
    assert.equal(witnessCurrentHead(f.remote, f.registryId, f.privateKey).sequence, 0,
      "read-only CLI must never publish its proposal");

    // Only the separate offline witness operator is allowed to publish.
    assert.equal(publishWitnessCheckpoint(f.remote, f.registryId, f.privateKey,
      proposal.checkpoint).ok, true);
    const caughtUp = await executeOperatorCli(env);
    assert.equal(caughtUp.code, 0, caughtUp.stderr);
    assertCleanOperatorStderr(caughtUp.stderr);
    assert.equal(JSON.parse(caughtUp.stdout).checkpoint, null);

    const wrong = generateKeyPairSync("ed25519").publicKey;
    const invalidPin = await executeOperatorCli({
      ...env,
      AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL:
        wrong.export({ format: "der", type: "spki" }).toString("base64url"),
    });
    assert.notEqual(invalidPin.code, 0);
    assert.equal(invalidPin.stdout, "");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
