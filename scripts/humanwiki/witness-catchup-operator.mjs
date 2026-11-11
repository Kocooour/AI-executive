#!/usr/bin/env node
/**
 * H1-real.7: privileged read-only operator plan; no CLI arguments, no imports.
 * Outputs ONLY one opaque next checkpoint tuple for manual offline witness
 * publication. Neither a valid tuple nor a matching witness is authorization.
 */
import { createPublicKey } from "node:crypto";
import { humanWikiConsentLedgerKey, withHumanWikiConsentPrivateLedgerAsync }
  from "../../lib/humanwiki-consent-private-store.mjs";
import { createHumanWikiWitnessHttpsReceiptProvider, humanWikiWitnessHttpsOrigin }
  from "../../lib/humanwiki-witness-https-client.mjs";
import { planHumanWikiWitnessCatchup }
  from "../../lib/humanwiki-witness-catchup.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cfg = process.env;
async function main() {
  if (process.argv.length !== 2 ||
      cfg.AI_EXECUTIVE_HUMANWIKI_WITNESS_CATCHUP_OPERATOR_ENABLED !== "true")
    throw Error("HumanWiki witness catch-up not enabled");
  const directory = cfg.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY;
  const ledgerKey = humanWikiConsentLedgerKey(
    cfg.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY);
  const registryId = cfg.AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID;
  const origin = humanWikiWitnessHttpsOrigin(
    cfg.AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN);
  const spkiText = cfg.AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL;
  if (!directory || !ledgerKey || !origin ||
      typeof registryId !== "string" || !UUID.test(registryId) ||
      typeof spkiText !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(spkiText))
    throw Error("HumanWiki witness catch-up unavailable");
  const spki = Buffer.from(spkiText, "base64url");
  if (spki.length !== 44 || spki.toString("base64url") !== spkiText)
    throw Error("HumanWiki witness catch-up unavailable");
  const witnessPublicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  if (witnessPublicKey.type !== "public" ||
      witnessPublicKey.asymmetricKeyType !== "ed25519")
    throw Error("HumanWiki witness catch-up unavailable");

  const result = await withHumanWikiConsentPrivateLedgerAsync(directory, db =>
    planHumanWikiWitnessCatchup({
      db, ledgerKey, registryId, witnessPublicKey,
      getFreshReceipt: createHumanWikiWitnessHttpsReceiptProvider(origin),
    }));
  if (!result.ok || result.importAuthorized !== false ||
      result.withdrawalComplete !== false ||
      result.independentWitnessVerified !== false)
    throw Error("HumanWiki witness catch-up unavailable");
  process.stdout.write(JSON.stringify(result) + "\n");
}
main().catch(() => {
  // Never serialize credential/config/SQLite/HTTP errors to stdout.
  process.stderr.write("HumanWiki witness catch-up blocked.\n");
  process.exitCode = 1;
});
