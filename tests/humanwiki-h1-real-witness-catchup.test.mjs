import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

test("local HMAC tamper and missing witness data fail closed without writes", async () => {
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
