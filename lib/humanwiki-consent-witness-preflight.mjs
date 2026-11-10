/**
 * H1-real.3b — challenge-bound remote high-water receipt verifier.
 *
 * No network/client route, upload, grant, revocation or release capability.
 * The external witness callback is supplied by trusted server code only.
 * Physical independence, monotonic witness updates, key custody and backup
 * separation CANNOT be established by this library: no production provider is
 * configured and a matched test receipt does not satisfy the H1-real gate.
 */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { humanWikiConsentIntentLocalHead } from "./humanwiki-consent-intents.mjs";

export const HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA =
  "humanwiki_h1_real_fresh_high_water_preflight_v1";

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64_NONCE = /^[A-Za-z0-9_-]{43}$/;
const B64_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const RECEIPT_KEYS = ["digest", "nonce", "registryId", "sequence", "signature", "version"];
const MAX_WITNESS_LATENCY_MS = 2000;

const refusal = () => ({
  ok: false, reason: "not_verified_blocked",
  importAuthorized: false, independentWitnessVerified: false,
  withdrawalComplete: false,
});
const isPlainRecord = value =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
   Object.getPrototypeOf(value) === null);

function validReceipt(receipt) {
  return isPlainRecord(receipt) &&
    Object.keys(receipt).sort().join(",") === RECEIPT_KEYS.join(",") &&
    receipt.version === HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA &&
    typeof receipt.registryId === "string" && UUID.test(receipt.registryId) &&
    typeof receipt.nonce === "string" && B64_NONCE.test(receipt.nonce) &&
    Number.isSafeInteger(receipt.sequence) && receipt.sequence >= 0 &&
    typeof receipt.digest === "string" && HEX.test(receipt.digest) &&
    typeof receipt.signature === "string" && B64_SIGNATURE.test(receipt.signature) &&
    Buffer.from(receipt.signature, "base64url").toString("base64url") === receipt.signature;
}

/**
 * Canonical Ed25519 signed payload for the independently hosted witness.
 * The signed data contains ONLY the opaque registry ID, a server-generated
 * challenge nonce, and global sequence/digest. It contains no content, actor,
 * Area, filename, source identifier, consent or claim.
 */
export function humanWikiWitnessChallengePayload(registryId, nonce, sequence, digest) {
  return Buffer.from([
    HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA,
    registryId, nonce, String(sequence), digest, "",
  ].join("\n"), "utf8");
}

/**
 * Read one fresh external checkpoint and compare with a locally verified
 * full-chain head. The nonce is generated inside this function and must not
 * originate in an HTTP request or local rollbackable state.
 *
 * getFreshReceipt({registryId,nonce}) MUST fetch the CURRENT checkpoint from
 * a different recovery domain with independent signer custody, and MUST sign
 * this exact fresh challenge. This is an integration contract only: a caller
 * can supply an insecure fake, so success is PRE-FLIGHT CONSISTENCY ONLY.
 * No path ever sets independentWitnessVerified/importAuthorized to true.
 */
export async function verifyHumanWikiFreshWitnessPreflight({
  db, ledgerKey, registryId, witnessPublicKey, getFreshReceipt,
} = {}) {
  try {
    if (typeof registryId !== "string" || !UUID.test(registryId) ||
        typeof getFreshReceipt !== "function" ||
        !witnessPublicKey || typeof witnessPublicKey !== "object" ||
        witnessPublicKey.type !== "public") return refusal();

    const publicKey = createPublicKey(witnessPublicKey);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
      return refusal();

    const before = humanWikiConsentIntentLocalHead(db, ledgerKey);
    if (!before.ok || before.importAuthorized !== false ||
        before.independentWitnessVerified !== false) return refusal();

    const nonce = randomBytes(32).toString("base64url");
    let timeout;
    let receipt;
    try {
      receipt = await Promise.race([
        Promise.resolve().then(() => getFreshReceipt({ registryId, nonce })),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error("witness_timeout")), MAX_WITNESS_LATENCY_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (!validReceipt(receipt) ||
        receipt.registryId !== registryId || receipt.nonce !== nonce ||
        receipt.sequence !== before.sequence || receipt.digest !== before.digest)
      return refusal();

    const signature = Buffer.from(receipt.signature, "base64url");
    const verified = verify(null,
      humanWikiWitnessChallengePayload(registryId, nonce, receipt.sequence, receipt.digest),
      publicKey, signature);
    if (!verified) return refusal();

    // Detect a local append, restore, key change or tamper during remote I/O.
    // It is STILL not a use-time graph authorization or independent proof that
    // the remote signer truly sits outside the server's recovery domain.
    const after = humanWikiConsentIntentLocalHead(db, ledgerKey);
    if (!after.ok || after.sequence !== before.sequence ||
        after.digest !== before.digest) return refusal();

    return {
      ok: true, schema: HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA,
      result: "fresh_signed_high_water_matches_local_head_for_preflight_only",
      importAuthorized: false, independentWitnessVerified: false,
      withdrawalComplete: false, claimsCreated: 0,
    };
  } catch {
    return refusal();
  }
}
