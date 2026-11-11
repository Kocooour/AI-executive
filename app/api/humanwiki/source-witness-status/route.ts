/**
 * HumanWiki H1-real.8: real owner-private source intent + remote witness
 * status observer. A signed prefix is NOT a durable source-specific ACK.
 *
 * This is a distinct, default-OFF, read-only HTTP consumer. It NEVER turns
 * requested withdrawal into completed erasure, consent, or import authority.
 * No request body, query, source identifier, ledger digest or witness receipt
 * is accepted or returned.
 */
import { createPublicKey } from "node:crypto";
import { getAuthState } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import { targetSessionGenerationConfig } from "../../../../lib/target-staging-session-generation";
import { verifyHumanWikiOwnerPrivateAreaLive } from "../../../../lib/target-staging-durable-session";
import {
  humanWikiConsentIntentLocalHead, humanWikiConsentIntentSourceStates,
} from "../../../../lib/humanwiki-consent-intents.mjs";
import {
  withHumanWikiConsentPrivateLedgerAsync, humanWikiConsentLedgerKey,
} from "../../../../lib/humanwiki-consent-private-store.mjs";
import {
  createHumanWikiWitnessHttpsReceiptProvider, humanWikiWitnessHttpsOrigin,
} from "../../../../lib/humanwiki-witness-https-client.mjs";
import { planHumanWikiWitnessCatchup }
  from "../../../../lib/humanwiki-witness-catchup.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const hidden = (): Response =>
  Response.json({ error: "Not found" }, { status: 404, headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enabled = () =>
  process.env.AI_EXECUTIVE_HUMANWIKI_SOURCE_WITNESS_STATUS_ENABLED === "true";

const owner = (request: Request): boolean => {
  const auth = getAuthState(request);
  return auth.enabled && auth.configured && auth.authenticated;
};

const configured = () => {
  const staging = targetSessionGenerationConfig();
  const areaId = process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID;
  const directory = process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY;
  const encodedKey = process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY;
  const ledgerKey = humanWikiConsentLedgerKey(encodedKey);
  const registryId = process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID;
  const origin = humanWikiWitnessHttpsOrigin(
    process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN,
  );
  const spkiB64 = process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL;
  if (!staging || !areaId || !directory || !encodedKey || !ledgerKey ||
      !registryId || !UUID.test(registryId) || !origin ||
      typeof spkiB64 !== "string" || !/^[A-Za-z0-9_-]{59}$/.test(spkiB64))
    return null;
  try {
    const spki = Buffer.from(spkiB64, "base64url");
    if (spki.length !== 44 || spki.toString("base64url") !== spkiB64) return null;
    const witnessPublicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (witnessPublicKey.type !== "public" ||
        witnessPublicKey.asymmetricKeyType !== "ed25519") return null;
    return { staging, areaId, directory, encodedKey, ledgerKey, registryId,
      origin, spkiB64, witnessPublicKey };
  } catch { return null; }
};
type Config = NonNullable<ReturnType<typeof configured>>;

const unchanged = (previous: Config): boolean => {
  const fresh = configured();
  return enabled() && fresh !== null &&
    fresh.staging.stagingDirectory === previous.staging.stagingDirectory &&
    fresh.staging.expectedRestoreGeneration === previous.staging.expectedRestoreGeneration &&
    fresh.staging.ownerUserId === previous.staging.ownerUserId &&
    fresh.areaId === previous.areaId && fresh.directory === previous.directory &&
    fresh.encodedKey === previous.encodedKey &&
    fresh.registryId === previous.registryId &&
    fresh.origin === previous.origin && fresh.spkiB64 === previous.spkiB64;
};
const liveAllowed = (c: Config) =>
  verifyHumanWikiOwnerPrivateAreaLive(c.staging, c.staging.ownerUserId, c.areaId);
const requestAllowed = (req: Request, config: Config) =>
  owner(req) && unchanged(config) && liveAllowed(config);

export async function GET(request: Request): Promise<Response> {
  try {
    // Never accept a caller-controlled source, Area, URL or checkpoint in
    // query parameters. No POST handler exists; no request body is inspected.
    if (!enabled() || !owner(request) || request.url.includes("?")) return hidden();
    const config = configured();
    if (!config || enforceRateLimit(request, "humanwiki-source-witness-observe", 12, 600_000) ||
        !liveAllowed(config)) return hidden();

    const status = await withHumanWikiConsentPrivateLedgerAsync(
      config.directory, async db => {
        const before = humanWikiConsentIntentLocalHead(db, config.ledgerKey);
        if (!before.ok || before.importAuthorized !== false ||
            before.independentWitnessVerified !== false) throw Error("unavailable");
        // Real pinned HTTPS signed-prefix check, with a strict 2s budget.
        // It may propose a next checkpoint internally but never publishes it.
        const plan = await planHumanWikiWitnessCatchup({
          db, ledgerKey: config.ledgerKey,
          registryId: config.registryId, witnessPublicKey: config.witnessPublicKey,
          getFreshReceipt: createHumanWikiWitnessHttpsReceiptProvider(config.origin),
        });
        if (!plan.ok || plan.importAuthorized !== false ||
            plan.independentWitnessVerified !== false ||
            plan.withdrawalComplete !== false ||
            plan.consentVerified !== false) throw Error("unavailable");
        const source = humanWikiConsentIntentSourceStates(db, config.ledgerKey, {
          ownerUserId: config.staging.ownerUserId,
          privateAreaId: config.areaId,
        });
        const after = humanWikiConsentIntentLocalHead(db, config.ledgerKey);
        if (!source.ok || !after.ok ||
            source.sequence !== before.sequence || source.digest !== before.digest ||
            after.sequence !== before.sequence || after.digest !== before.digest)
          throw Error("unavailable");

        // Projection includes no remote sequence/digest, opaque scope tokens,
        // actor/Area identity, HMAC key, timestamp or signed receipt.
        return {
          witnessState: plan.checkpoint === null
            ? "signed_remote_head_matches_local"
            : "signed_remote_prefix_requires_catchup",
          sources: source.sources,
        };
      },
    );
    if (!requestAllowed(request, config)) return hidden();
    return Response.json({
      result: "source_intent_and_witness_observation_not_authorization",
      witnessState: status.witnessState,
      sources: status.sources,
      importAuthorized: false, consentVerified: false,
      independentWitnessVerified: false, withdrawalComplete: false,
      realImportEnabled: false, claimsCreated: 0,
    }, { status: 200, headers });
  } catch { return hidden(); }
}
