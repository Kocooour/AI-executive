/**
 * HumanWiki H1-real.2 — strictly read-only, owner-private Area LIVE ACL preflight.
 * Default-off and independent of the deny-only import endpoint. The result is
 * NOT an import authorization, consent grant or evidence of H1-real readiness.
 *
 * Uses the existing pinned staging SQLite read transaction and Area policy;
 * only trusted process configuration chooses the actor and private Area.
 * Request URL, query, headers or payload never supply Area/actor/consent IDs.
 */
import { getAuthState } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import { targetSessionGenerationConfig } from "../../../../lib/target-staging-session-generation";
import { verifyHumanWikiOwnerPrivateAreaLive } from "../../../../lib/target-staging-durable-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const hidden = (): Response =>
  Response.json({ error: "Not found" }, { status: 404, headers });

const enabled = (): boolean =>
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_PREFLIGHT_ENABLED === "true";

const configured = () => {
  const store = targetSessionGenerationConfig();
  const areaId = process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID;
  return store && areaId ? { store, areaId } : null;
};
const unchanged = (original: NonNullable<ReturnType<typeof configured>>): boolean => {
  const live = configured();
  return enabled() && live !== null &&
    live.store.stagingDirectory === original.store.stagingDirectory &&
    live.store.expectedRestoreGeneration === original.store.expectedRestoreGeneration &&
    live.store.ownerUserId === original.store.ownerUserId &&
    live.areaId === original.areaId;
};

export async function GET(request: Request): Promise<Response> {
  try {
    if (!enabled()) return hidden();
    // A signed, configured owner cookie is necessary but not sufficient.
    // Development bypass, session, bearer or caller-supplied Area claims fail.
    const admission = getAuthState(request);
    if (!admission.enabled || !admission.configured || !admission.authenticated)
      return hidden();
    // No request-controlled scope or area selection, even empty "?".
    if (request.url.includes("?")) return hidden();
    const config = configured();
    if (!config) return hidden();

    // Limit the cost of pinned, anti-rollback SQLite opens per client.
    if (enforceRateLimit(request, "humanwiki-private-area-live-preflight", 60, 600_000))
      return hidden();
    const allowed = verifyHumanWikiOwnerPrivateAreaLive(
      config.store, config.store.ownerUserId, config.areaId,
    );
    if (!allowed) return hidden();

    // Recheck owner cookie and every relevant server config before releasing.
    const release = getAuthState(request);
    if (!release.enabled || !release.configured || !release.authenticated ||
        !unchanged(config)) return hidden();

    // NEVER return Area IDs, actor IDs, revision/epoch or private data.
    return Response.json({
      result: "owner_private_area_read_verified_for_preflight_only",
      actual_import_authorized: false,
      real_source_consent_verified: false,
      independent_revocation_witness_verified: false,
      h1_real_ready: false,
      claims_created: 0,
    }, { status: 200, headers });
  } catch {
    return hidden();
  }
}
