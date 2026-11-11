/**
 * HumanWiki H1-real.7 — READ-ONLY operator catch-up plan, never an ACK.
 *
 * A fresh, nonce-bound signed witness checkpoint is compared with the fully
 * HMAC-verified local append-only intent ledger. Only the next contiguous
 * opaque checkpoint can be proposed for the OFFLINE witness operator.
 *
 * This is not a consent, erasure, revocation, ACL, import or release authority.
 * In particular a valid prefix does not establish independent recovery domains.
 */
import { KeyObject, randomBytes, verify } from "node:crypto";
import { humanWikiConsentIntentLocalHead } from "./humanwiki-consent-intents.mjs";
import {
  HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA, humanWikiWitnessChallengePayload,
} from "./humanwiki-consent-witness-preflight.mjs";

export const HUMANWIKI_WITNESS_CATCHUP_SCHEMA = "humanwiki_witness_operator_catchup_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const B64_NONCE = /^[A-Za-z0-9_-]{43}$/;
const B64_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const ZERO = "0".repeat(64);
const RECEIPT_FIELDS = ["digest", "nonce", "registryId", "sequence", "signature", "version"];
const TIMEOUT_MS = 2000;

const blocked = () => ({
  ok: false, reason: "not_verified_blocked",
  importAuthorized: false, consentVerified: false,
  independentWitnessVerified: false, withdrawalComplete: false,
});
const plain = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype ||
  Object.getPrototypeOf(value) === null);
const validReceipt = r => plain(r) &&
  Object.keys(r).sort().join(",") === RECEIPT_FIELDS.join(",") &&
  r.version === HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA &&
  typeof r.registryId === "string" && UUID.test(r.registryId) &&
  typeof r.nonce === "string" && B64_NONCE.test(r.nonce) &&
  Buffer.from(r.nonce, "base64url").toString("base64url") === r.nonce &&
  Number.isSafeInteger(r.sequence) && r.sequence >= 0 &&
  typeof r.digest === "string" && HEX.test(r.digest) &&
  typeof r.signature === "string" && B64_SIGNATURE.test(r.signature) &&
  Buffer.from(r.signature, "base64url").toString("base64url") === r.signature;
const safeKey = k => k instanceof KeyObject &&
  KeyObject.prototype.equals.call(k, k) &&
  k.type === "public" && k.asymmetricKeyType === "ed25519";

/**
 * Operator-only, no HTTP route and no writes. The transport must obtain the
 * CURRENT signed high-water from the pinned external witness, not from an
 * uploaded receipt or caller-provided sequence. Its AbortSignal is mandatory.
 *
 * The verified witness must equal an exact local *prefix*. A witness ahead of
 * local, wrong prefix, corrupted ledger, stale nonce, or concurrent local
 * change is blocked. Catch-up advances ONE event at a time, never skips.
 * The resulting tuple is only an operator proposal, not a durable ACK.
 */
export async function planHumanWikiWitnessCatchup({
  db, ledgerKey, registryId, witnessPublicKey, getFreshReceipt,
} = {}) {
  try {
    if (typeof registryId !== "string" || !UUID.test(registryId) ||
        !safeKey(witnessPublicKey) || typeof getFreshReceipt !== "function" ||
        !db || typeof db.prepare !== "function") return blocked();
    const before = humanWikiConsentIntentLocalHead(db, ledgerKey);
    if (!before.ok || before.importAuthorized !== false ||
        before.independentWitnessVerified !== false) return blocked();

    const nonce = randomBytes(32).toString("base64url");
    const controller = new AbortController();
    let timer;
    let receipt;
    try {
      receipt = await Promise.race([
        Promise.resolve().then(() => getFreshReceipt({
          registryId, nonce, signal: controller.signal,
        })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(Error("witness_timeout"));
            reject(Error("witness_timeout"));
          }, TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
    if (!validReceipt(receipt) || receipt.registryId !== registryId ||
        receipt.nonce !== nonce || receipt.sequence > before.sequence ||
        !verify(null, humanWikiWitnessChallengePayload(
          registryId, nonce, receipt.sequence, receipt.digest),
        witnessPublicKey, Buffer.from(receipt.signature, "base64url")))
      return blocked();

    // Prefix membership is checked against the exact local HMAC-verified
    // sequence, not a mere matching last digest or caller-supplied tuple.
    const predecessor = receipt.sequence === 0
      ? ZERO
      : db.prepare("SELECT event_mac FROM humanwiki_consent_intent_events WHERE seq = ?")
        .get(receipt.sequence)?.event_mac;
    if (predecessor !== receipt.digest) return blocked();

    let checkpoint = null;
    if (receipt.sequence < before.sequence) {
      const row = db.prepare(`SELECT seq, previous_mac, event_mac
        FROM humanwiki_consent_intent_events WHERE seq = ?`)
        .get(receipt.sequence + 1);
      if (!row || row.seq !== receipt.sequence + 1 ||
          row.previous_mac !== receipt.digest ||
          typeof row.event_mac !== "string" || !HEX.test(row.event_mac))
        return blocked();
      checkpoint = {
        sequence: row.seq, previousDigest: receipt.digest, digest: row.event_mac,
      };
    }

    // Protect against another writer changing the head while remote I/O and
    // local prefix checks take place. A proposal still needs revalidation at
    // witness publish time: this function NEVER acknowledges its application.
    const after = humanWikiConsentIntentLocalHead(db, ledgerKey);
    if (!after.ok || after.sequence !== before.sequence ||
        after.digest !== before.digest) return blocked();

    return {
      ok: true, schema: HUMANWIKI_WITNESS_CATCHUP_SCHEMA,
      result: checkpoint
        ? "next_offline_witness_checkpoint_proposed_not_acknowledged"
        : "current_signed_witness_matches_local_head_for_operator_only",
      checkpoint,
      importAuthorized: false, consentVerified: false,
      independentWitnessVerified: false, withdrawalComplete: false,
    };
  } catch {
    return blocked();
  }
}
