// H1-real: fail-closed import entry boundary, NOT an importer.
// There is deliberately no runtime flag, file reader, parser, upload handler,
// consent writer, persistence, network call, AI model or release path here.
// A real user's export MUST NOT be passed to a synthetic laboratory helper.
export const H1_REAL_GATE_SCHEMA = "humanwiki_h1_real_entry_readiness_v1";

const prerequisites = Object.freeze([
  Object.freeze({
    code: "authenticated_actor_and_owner_private_area_acl",
    requirement: "Current authenticated owner, private Area and live revocation-safe authorization",
  }),
  Object.freeze({
    code: "source_specific_consent_and_quarantine_retention",
    requirement: "Separate explicit ChatGPT/Claude export consent, scoped retention and encrypted quarantine",
  }),
  Object.freeze({
    code: "speaker_provenance_sensitivity_and_human_review",
    requirement: "Validated speaker/quote lineage, sensitivity classification and explicit owner review",
  }),
  Object.freeze({
    code: "independent_durable_revocation_and_rollback_witness",
    requirement: "Append-only revocation registry plus authenticated high-water witness outside restore domain",
  }),
  Object.freeze({
    code: "atomic_commit_and_derivative_release_invalidation",
    requirement: "CAS-protected claim lifecycle, dependent artifact invalidation and live serving authorization",
  }),
  Object.freeze({
    code: "r3_integration_r4_owner_release_and_full_e2e",
    requirement: "Integrated R3 security acceptance and explicitly owner-approved R4 release on exact SHA",
  }),
]);

// This is an engineering inventory, never a proof of satisfying a gate.
// Do not add an isReady boolean or accept caller-provided 'verified' flags.
// A future H1-real implementation must use authenticated server-side checks
// backed by separate consent/revocation evidence before changing this boundary.
export function humanWikiH1RealEntryReadiness() {
  return {
    schema: H1_REAL_GATE_SCHEMA,
    result: "blocked_not_enabled",
    enabled: false,
    source_types_in_future_scope: ["chatgpt_user_export", "claude_user_export"],
    mail_content_import_in_scope: false,
    explicit_owner_consent_received: false,
    real_actor_or_area_verified: false,
    independent_witness_verified: false,
    real_data_accepted: false,
    real_data_read: false,
    data_stored: false,
    external_model_egress: false,
    claims_created: 0,
    tasks_created: 0,
    prerequisites: prerequisites.map(item => ({
      code: item.code,
      requirement: item.requirement,
      status: "not_verified_blocked",
    })),
  };
}

export class HumanWikiH1RealEntryBlockedError extends Error {
  constructor() {
    super("HumanWiki H1-real import is not enabled or authorized");
    this.name = "HumanWikiH1RealEntryBlockedError";
    this.code = "HUMANWIKI_H1_REAL_IMPORT_BLOCKED";
  }
}

/**
 * Intended only as an early-entry deny guard if a future H1-real
 * intake implementation is added. Do NOT inspect a caller's export bytes,
 * request/body, filenames, tokens or consent assertions, not even for logs.
 * The arguments are intentionally ignored (including throwing proxies).
 * No env flag, runtime callback or caller-supplied evidence can enable this.
 */
export function denyHumanWikiH1RealImport(_untrustedRequest, _untrustedClaims) {
  throw new HumanWikiH1RealEntryBlockedError();
}
