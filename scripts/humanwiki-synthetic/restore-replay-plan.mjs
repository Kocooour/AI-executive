// Toy-only recovery obligations plan. No replay, writes, real identifiers, or release.
// This models what MUST be checked, not what has happened after a restore.
import { previewSyntheticRestorePreflight } from "./restore-preflight.mjs";

const actionChecks = Object.freeze({
  request_erasure: Object.freeze([
    "remove_source_and_exclusively_derived_claims",
    "prune_multi_source_evidence_and_revalidate_remaining_basis",
    "invalidate_dependent_search_cache_embeddings_exports_summaries",
    "retain_independent_anti_resurrection_tombstone_witness",
  ]),
  revoke_import_consent: Object.freeze([
    "stop_source_processing_and_ai_egress",
    "recheck_separate_valid_retention_and_evidence_basis",
    "purge_unauthorized_proposals_copies_and_derivatives",
    "invalidate_and_revalidate_dependent_search_cache_ai_outputs",
  ]),
});
const globalGates = Object.freeze([
  "verify_current_external_independent_witness",
  "replay_confirmed_revocations_before_serving",
  "revalidate_source_acl_consent_retention_and_claim_evidence",
  "invalidate_all_stale_derived_indexes_caches_and_ai_outputs",
  "perform_transactional_restore_reconciliation_and_release_review",
]);

/**
 * Plan the *obligations* after the preflight from #349. The preflight already
 * validates the complete fake registry / snapshot / witness chain.
 * A blocked preflight does not reveal pending event IDs or their existence.
 */
export function previewSyntheticRestoreReplayPlan(state) {
  const preflight = previewSyntheticRestorePreflight(state);
  const common = {
    synthetic_fixture_only: true,
    mode: "fictional_restore_replay_obligations_only",
    global_release_gates: [...globalGates],
    all_release_gates_satisfied: false,
    replay_completed: false,
    actual_restore_applied: false,
    actual_witness_contacted: false,
    data_release_authorized: false,
    durable_events_written: 0,
    tombstones_written: 0,
    claims_created: 0,
    real_import_enabled: false,
  };

  if (preflight.preflight_status === "blocked") {
    return {
      ...common,
      plan_status: "blocked",
      reason: preflight.reason,
      pending_events_to_reconcile: 0,
      event_obligations: [],
      source_specific_work_disclosed: false,
    };
  }

  if (preflight.preflight_status !== "requires_replay_and_revalidation" &&
      preflight.preflight_status !== "checks_passed_in_toy_only") {
    throw new Error("Synthetic replay: unexpected preflight state");
  }
  // The preflight returns contiguous pending events for a validated toy chain.
  const event_obligations = preflight.pending_replay_events.map(event => {
    const checks = actionChecks[event.action];
    if (!checks) throw new Error("Synthetic replay: unexpected action");
    return {
      sequence: event.sequence,
      opaque_source_id: event.opaque_source_id,
      action: event.action,
      required_checks: [...checks],
      completed: false,
    };
  });
  return {
    ...common,
    plan_status: event_obligations.length ?
      "requires_hypothetical_replay" : "preflight_passed_revalidation_still_required",
    reason: null,
    pending_events_to_reconcile: event_obligations.length,
    event_obligations,
    source_specific_work_disclosed: true,
  };
}
