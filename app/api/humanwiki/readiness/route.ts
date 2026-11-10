/**
 * HumanWiki H1-real.1 — owner-only, read-only readiness status.
 *
 * This is NOT an upload, consent, or import API. A real configured owner
 * session is mandatory; the insecure development authentication bypass is
 * rejected. There is no staging session, integration-token or bearer fallback.
 *
 * This endpoint only publishes a static status of UNSATISFIED prerequisites.
 * It never reads export bytes, identity/Area records, source evidence,
 * consent state, revocation records or private user information.
 */
import { getAuthState } from "../../../../lib/auth";
import { humanWikiH1RealEntryReadiness } from "../../../../lib/humanwiki-h1-real-entry.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const hidden = (): Response =>
  Response.json({ error: "Not found" }, { status: 404, headers });

const enabled = (): boolean =>
  process.env.AI_EXECUTIVE_HUMANWIKI_READINESS_ENABLED === "true";

/**
 * A real owner cookie is required, not a caller-controlled identity assertion.
 * Calling getAuthState twice prevents a token/configuration change between
 * admission and response release from silently publishing a status. Nothing
 * returned by this endpoint can itself authorize or enable an import.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    if (!enabled()) return hidden();
    const admission = getAuthState(request);
    if (!admission.enabled || !admission.configured || !admission.authenticated)
      return hidden();

    const report = humanWikiH1RealEntryReadiness();
    if (report.enabled !== false || report.result !== "blocked_not_enabled" ||
        report.prerequisites.length !== 6 ||
        report.prerequisites.some(gate => gate.status !== "not_verified_blocked") ||
        report.real_actor_or_area_verified !== false ||
        report.explicit_owner_consent_received !== false ||
        report.real_data_accepted !== false || report.real_data_read !== false ||
        report.data_stored !== false || report.external_model_egress !== false)
      return hidden();

    const release = getAuthState(request);
    if (!enabled() || !release.enabled || !release.configured || !release.authenticated)
      return hidden();
    return Response.json(report, { status: 200, headers });
  } catch {
    // Malformed cookies, missing auth secrets and unexpected errors must
    // never expose readiness or incident details to unauthenticated clients.
    return hidden();
  }
}
