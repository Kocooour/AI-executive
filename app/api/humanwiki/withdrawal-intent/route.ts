/**
 * H1-real.4a — default-OFF owner-authenticated non-authorizing
 * withdrawal-INTENT command. A successful response records a REQUEST, not a
 * completed revocation, consent, release barrier or import authorization.
 * No source files, emails, notes, or export content enter this route.
 */
import { getAuthState } from "../../../../lib/auth";
import { enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { targetSessionGenerationConfig } from "../../../../lib/target-staging-session-generation";
import { verifyHumanWikiOwnerPrivateAreaLive } from "../../../../lib/target-staging-durable-session";
import {
  HUMANWIKI_CONSENT_SOURCES, appendHumanWikiConsentIntent, humanWikiConsentIntentReadiness,
} from "../../../../lib/humanwiki-consent-intents.mjs";
import {
  humanWikiConsentLedgerKey, withHumanWikiConsentPrivateLedger,
} from "../../../../lib/humanwiki-consent-private-store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const hidden = (): Response => Response.json({ error: "Not found" }, { status: 404, headers });
const enabled = () =>
  process.env.AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED === "true";

const owner = (request: Request): boolean => {
  const auth = getAuthState(request);
  return auth.enabled && auth.configured && auth.authenticated;
};

const configured = () => {
  const staging = targetSessionGenerationConfig();
  const privateAreaId = process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID;
  const directory = process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY;
  const encodedKey = process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY;
  const key = humanWikiConsentLedgerKey(encodedKey);
  return staging && privateAreaId && directory && key && encodedKey
    ? { staging, privateAreaId, directory, encodedKey, key } : null;
};
type Config = NonNullable<ReturnType<typeof configured>>;
const unchanged = (original: Config) => {
  const fresh = configured();
  return enabled() && fresh !== null &&
    fresh.staging.stagingDirectory === original.staging.stagingDirectory &&
    fresh.staging.expectedRestoreGeneration === original.staging.expectedRestoreGeneration &&
    fresh.staging.ownerUserId === original.staging.ownerUserId &&
    fresh.privateAreaId === original.privateAreaId &&
    fresh.directory === original.directory && fresh.encodedKey === original.encodedKey;
};
const liveAllowed = (config: Config) =>
  verifyHumanWikiOwnerPrivateAreaLive(
    config.staging, config.staging.ownerUserId, config.privateAreaId,
  );
const scope = (config: Config) => ({
  ownerUserId: config.staging.ownerUserId, privateAreaId: config.privateAreaId,
});
const requestAllowed = (request: Request, config: Config) =>
  owner(request) && unchanged(config) && liveAllowed(config);

export async function GET(request: Request): Promise<Response> {
  try {
    if (!enabled() || !owner(request) || request.url.includes("?")) return hidden();
    const config = configured();
    if (!config || enforceRateLimit(request, "humanwiki-withdrawal-intent-read", 60, 600_000) ||
        !liveAllowed(config)) return hidden();
    const status = withHumanWikiConsentPrivateLedger(config.directory, "read", db => {
      const revisions: Record<string, number> = {};
      for (const source of HUMANWIKI_CONSENT_SOURCES) {
        const check = humanWikiConsentIntentReadiness(db, config.key, scope(config), source);
        if (!check.ok || check.importAuthorized !== false ||
            check.withdrawalComplete !== false) throw Error("unavailable");
        revisions[source] = check.revision;
      }
      return revisions;
    });
    if (!requestAllowed(request, config)) return hidden();
    return Response.json({
      result: "owner_private_source_intent_revisions_only",
      sourceRevisions: status,
      importAuthorized: false, consentVerified: false,
      withdrawalComplete: false, independentWitnessVerified: false,
    }, { status: 200, headers });
  } catch { return hidden(); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!enabled() || !owner(request) || request.url.includes("?")) return hidden();
    // Reject CSRF before parsing any body bytes.
    requireSameOrigin(request);
    const config = configured();
    if (!config || enforceRateLimit(request, "humanwiki-withdrawal-intent-write", 20, 600_000) ||
        !liveAllowed(config)) return hidden();

    // Source-specific, bounded metadata command only; no upload or body fields.
    const command = await readJsonBody(request, 1024, { strictUtf8: true });
    if (!command || typeof command !== "object" ||
        (command as { decision?: unknown }).decision !== "withdrawal_requested" ||
        !requestAllowed(request, config)) return hidden();
    const result = withHumanWikiConsentPrivateLedger(config.directory, "write", db =>
      appendHumanWikiConsentIntent(db, config.key, scope(config), command));
    if (!result.ok || result.importAuthorized !== false ||
        result.withdrawalComplete !== false || !requestAllowed(request, config)) return hidden();
    return Response.json({
      result: "withdrawal_intent_recorded_not_completed",
      replayed: result.replayed, revision: result.revision,
      importAuthorized: false, consentVerified: false,
      withdrawalComplete: false, independentWitnessVerified: false,
    }, { status: 200, headers });
  } catch { return hidden(); }
}
