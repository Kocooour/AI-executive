/**
 * H1-real.4b: real owner-only LIVE HTTPS remote-witness consistency check.
 * Default OFF. Never accepts source bytes or client-provided identity, Area,
 * registry, key, nonce, witness URL, consent, or high-water checkpoint.
 * A successful 200 is PRE-FLIGHT ONLY; it cannot authorize any data import,
 * complete a withdrawal or prove external recovery-domain independence.
 */
import { createPublicKey } from "node:crypto";
import { getAuthState } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import { targetSessionGenerationConfig } from "../../../../lib/target-staging-session-generation";
import { verifyHumanWikiOwnerPrivateAreaLive } from "../../../../lib/target-staging-durable-session";
import { verifyHumanWikiFreshWitnessPreflight } from "../../../../lib/humanwiki-consent-witness-preflight.mjs";
import { withHumanWikiConsentPrivateLedgerAsync, humanWikiConsentLedgerKey }
  from "../../../../lib/humanwiki-consent-private-store.mjs";
import { createHumanWikiWitnessHttpsReceiptProvider, humanWikiWitnessHttpsOrigin }
  from "../../../../lib/humanwiki-witness-https-client.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const hidden = (): Response => Response.json({ error: "Not found" }, { status: 404, headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enabled = () =>
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTP_PREFLIGHT_ENABLED === "true";
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
    return { staging, areaId, directory, encodedKey, ledgerKey,
      registryId, origin, spkiB64, witnessPublicKey };
  } catch { return null; }
};
type Config = NonNullable<ReturnType<typeof configured>>;
const unchanged = (original: Config): boolean => {
  const live = configured();
  return enabled() && live !== null &&
    live.staging.stagingDirectory === original.staging.stagingDirectory &&
    live.staging.expectedRestoreGeneration === original.staging.expectedRestoreGeneration &&
    live.staging.ownerUserId === original.staging.ownerUserId &&
    live.areaId === original.areaId &&
    live.directory === original.directory &&
    live.encodedKey === original.encodedKey &&
    live.registryId === original.registryId &&
    live.origin === original.origin && live.spkiB64 === original.spkiB64;
};
const liveAllowed = (c: Config) =>
  verifyHumanWikiOwnerPrivateAreaLive(c.staging, c.staging.ownerUserId, c.areaId);
const requestAllowed = (req: Request, c: Config) =>
  owner(req) && unchanged(c) && liveAllowed(c);

export async function GET(request: Request): Promise<Response> {
  try {
    if (!enabled() || !owner(request) || request.url.includes("?")) return hidden();
    const config = configured();
    if (!config || enforceRateLimit(request, "humanwiki-witness-remote-preflight", 12, 600_000) ||
        !liveAllowed(config)) return hidden();

    // The callback performs a *real HTTPS* request with a strict 1KiB reply
    // bound. The verifier itself generates the nonce and aborts after 2s.
    // The SQLite file stays open to check the same HMAC head before AND after.
    const result = await withHumanWikiConsentPrivateLedgerAsync(
      config.directory, db => verifyHumanWikiFreshWitnessPreflight({
        db, ledgerKey: config.ledgerKey,
        registryId: config.registryId,
        witnessPublicKey: config.witnessPublicKey,
        getFreshReceipt: createHumanWikiWitnessHttpsReceiptProvider(config.origin),
      }),
    );
    if (!result.ok ||
        result.importAuthorized !== false ||
        result.independentWitnessVerified !== false ||
        result.withdrawalComplete !== false ||
        !requestAllowed(request, config)) return hidden();

    // Never expose the signed receipt, ledger seq/digest, scope, Area or key.
    return Response.json({
      result: "remote_signed_high_water_matches_for_preflight_only",
      importAuthorized: false,
      independentWitnessVerified: false,
      withdrawalComplete: false,
      consentVerified: false,
      realImportEnabled: false,
      claimsCreated: 0,
    }, { status: 200, headers });
  } catch { return hidden(); }
}
