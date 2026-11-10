#!/usr/bin/env node
/**
 * Explicit, ONE-TIME operator provisioning of an empty, content-free HumanWiki
 * consent INTENT registry. Never run from an API or normal service startup.
 * Requires a pre-created, owned, mode-0700 directory and an independently
 * provisioned 32-byte HMAC secret. Does not accept personal export content.
 */
import {
  bootstrapHumanWikiConsentPrivateLedger, humanWikiConsentLedgerKey,
} from "../lib/humanwiki-consent-private-store.mjs";

if (process.env.AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED === "true") {
  throw Error("Disable the withdrawal intent HTTP feature before operator bootstrap");
}
if (!humanWikiConsentLedgerKey(process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY)) {
  throw Error("Missing or invalid dedicated HumanWiki consent ledger HMAC key");
}
const directory = process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY;
const result = bootstrapHumanWikiConsentPrivateLedger(directory);
if (!result.ok || result.importAuthorized !== false || result.withdrawalComplete !== false)
  throw Error("HumanWiki operator provisioning failed");

process.stdout.write("HumanWiki consent intent ledger initialized; import and revocation remain blocked.\n");
