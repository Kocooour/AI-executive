// HumanWiki H1-synthetic: fictitious source-lifecycle hold on a pending
// proposal. Not an authorization gate, consent store, reviewer command,
// deletion engine, source reader or durable state transition. Zero writes.
import { previewSyntheticClaimProposals } from "./claim-proposal-preview.mjs";
import {
  bindSyntheticProposalReview, rehearseSyntheticProposalReview,
} from "./proposal-review-rehearsal.mjs";
import { previewSyntheticSourceLifecycle } from "./lifecycle-preview.mjs";

const fail = () => { throw new Error("Synthetic proposal lifecycle: fixture contract not satisfied"); };
const equalLocator = (a, b) =>
  a.source_id === b.source_id &&
  a.conversation_id === b.conversation_id &&
  a.message_id === b.message_id &&
  a.segment === b.segment;
const cases = Object.freeze([
  { id: "active", action: null, target: "candidate" },
  { id: "pause", action: "pause_sync", target: "candidate" },
  { id: "disconnect", action: "disconnect_source", target: "candidate" },
  { id: "revoke", action: "revoke_import_consent", target: "candidate" },
  { id: "erase", action: "request_erasure", target: "candidate" },
  { id: "unrelated_disconnect", action: "disconnect_source", target: "other" },
]);
const holds = Object.freeze({
  disconnect_source: "would_withhold_candidate_after_source_disconnect",
  revoke_import_consent: "would_withhold_candidate_after_import_consent_revocation",
  request_erasure: "would_withhold_candidate_after_source_erasure_request",
});
const noWrites = Object.freeze({
  synthetic_fixture_only: true,
  actual_source_reads_performed: 0,
  actual_human_review_completed: false,
  reviewer_identity_authenticated: false,
  source_consent_verified: false,
  durable_lifecycle_events_written: 0,
  actual_deletions_performed: 0,
  claims_created: 0,
  review_outcomes_written: 0,
  actual_tasks_created: 0,
  actual_invalidation_performed: 0,
  independent_witness_contacted: false,
  atomic_commit_performed: false,
  data_release_authorized: false,
  real_import_enabled: false,
});

// The internal fake intent is purposefully unreadable. A blocked lifecycle
// scenario MUST return before evaluating it, even though the toy binding
// still matches the unchanged original fixture bytes.
const poison = new Proxy([{}], {
  get() { throw new Error("blocked fictional review intent was examined"); },
});
function consider(lifecycle, candidate, bundles, binding, blockedIntent) {
  const source = lifecycle.source_states.find(x =>
    x.source_id === candidate.source_locator.source_id);
  if (!source) fail();
  const visible = lifecycle.visible_entries.some(entry =>
    equalLocator(entry.locator, candidate.source_locator));
  if (visible !== source.would_allow_pending_review) fail();
  if (!visible) {
    if (!Object.hasOwn(holds, source.action) ||
        source.would_allow_new_source_reads !== false ||
        source.would_invalidate_source_derivatives !== true) fail();
    // No access to blockedIntent, and no real reviewer/event/witness.
    void blockedIntent;
    return {
      candidate_review_status: holds[source.action],
      review_intent_evaluated: false,
      binding_still_matches_toy_content: true,
      candidate_pending_visible: false,
      new_source_reads_allowed_by_policy: false,
    };
  }
  const simulated = rehearseSyntheticProposalReview(bundles, binding, [{
    draft_id: candidate.draft_id,
    choice: "inspect",
  }]);
  if (simulated.review_gate_status !== "would_open_source_for_explicit_review_only" ||
      simulated.current_review !== "proposed" ||
      simulated.claim_confirmed !== false ||
      simulated.review_outcomes_written !== 0 ||
      simulated.data_release_authorized !== false) fail();
  return {
    candidate_review_status: source.would_allow_new_source_reads
      ? "would_offer_existing_proposal_for_explicit_review_only"
      : "would_keep_existing_proposal_pending_without_source_refresh",
    review_intent_evaluated: true,
    binding_still_matches_toy_content: true,
    candidate_pending_visible: true,
    new_source_reads_allowed_by_policy: source.would_allow_new_source_reads,
  };
}

/**
 * Static experiment on exactly two *unchanged, pinned, fictional* exports.
 * Only scenarios inside this module may be run; no external content, source
 * paths, user actions, consent changes, real review or persistence is accepted.
 */
export function previewSyntheticProposalLifecycleHolds(bundles) {
  const proposals = previewSyntheticClaimProposals(bundles);
  if (proposals.draft_proposals_count !== 1 ||
      proposals.withheld_segments_count !== 5 ||
      proposals.real_import_enabled !== false ||
      proposals.h1_real_entry_gates.length !== 6 ||
      proposals.h1_real_entry_gates.some(g => g.result !== "not_verified_blocked")) fail();
  const candidate = proposals.draft_proposals[0];
  if (candidate.review !== "proposed" ||
      candidate.sensitivity !== "unclassified" ||
      candidate.scope !== "owner_private_unassigned" ||
      candidate.claim_confirmed !== false ||
      candidate.canonical_claim_written !== false) fail();

  const binding = bindSyntheticProposalReview(bundles);
  const initial = rehearseSyntheticProposalReview(bundles, binding);
  if (initial.review_gate_status !== "no_review_intent_submitted" ||
      initial.data_release_authorized !== false) fail();
  const initialLifecycle = previewSyntheticSourceLifecycle(bundles);
  const others = initialLifecycle.source_states.filter(state =>
    state.source_id !== candidate.source_locator.source_id);
  if (others.length !== 1 || initialLifecycle.segments_total !== 6) fail();

  const scenarios = cases.map(({ id, action, target }) => {
    const sourceId = target === "candidate"
      ? candidate.source_locator.source_id : others[0].source_id;
    const lifecycle = previewSyntheticSourceLifecycle(
      bundles, action === null ? [] : [{ source_id: sourceId, action }]);
    const source = lifecycle.source_states.find(s =>
      s.source_id === candidate.source_locator.source_id);
    const chosen = lifecycle.source_states.find(s => s.source_id === sourceId);
    if (!source || !chosen ||
        (action === null ? chosen.action !== "active" : chosen.action !== action) ||
        lifecycle.source_states.some(s =>
          s.durable_lifecycle_event_written !== false ||
          s.witness_confirmed !== false ||
          s.operation_completed !== false) ||
        lifecycle.claims_created !== 0 ||
        lifecycle.review_outcomes_written !== 0 ||
        lifecycle.durable_lifecycle_events_written !== 0 ||
        lifecycle.tombstones_written !== 0) fail();

    const checked = consider(lifecycle, candidate, bundles, binding, poison);
    if (source.would_allow_pending_review !== checked.candidate_pending_visible ||
        chosen.would_allow_new_source_reads !== (action === null) &&
        id === "active") {
      // Only the source's own flags, not a guessed global lifecycle state,
      // determine whether the candidate can remain pending.
      if (source.would_allow_pending_review !== checked.candidate_pending_visible) fail();
    }
    if (id === "pause" &&
        (checked.candidate_review_status !==
           "would_keep_existing_proposal_pending_without_source_refresh" ||
         checked.new_source_reads_allowed_by_policy !== false)) fail();
    if (["disconnect", "revoke", "erase"].includes(id) &&
        (checked.review_intent_evaluated !== false ||
         checked.candidate_pending_visible !== false ||
         checked.candidate_review_status !== holds[action])) fail();
    if (id === "unrelated_disconnect" &&
        (checked.candidate_pending_visible !== true ||
         chosen.would_allow_pending_review !== false ||
         lifecycle.suppressed_segments < 1)) fail();
    return {
      scenario: id,
      ...checked,
      affected_source_pending_review_allowed: chosen.would_allow_pending_review,
      affected_source_derivatives_would_be_invalidated:
        chosen.would_invalidate_source_derivatives,
      affected_source_requires_independent_witness:
        chosen.independent_witness_required,
      affected_source_requires_retention_recheck:
        chosen.retention_recheck_required,
      visible_segments_in_toy_policy: lifecycle.visible_segments,
      suppressed_segments_in_toy_policy: lifecycle.suppressed_segments,
    };
  });
  if (scenarios.length !== 6 ||
      scenarios.filter(x => !x.candidate_pending_visible).length !== 3 ||
      scenarios.filter(x => x.candidate_pending_visible).length !== 3 ||
      scenarios.some(x => !x.binding_still_matches_toy_content)) fail();

  return {
    ...noWrites,
    mode: "fictional_proposal_source_lifecycle_hold_matrix_no_write",
    initial_candidate_review: "proposed",
    initial_candidate_sensitivity: "unclassified",
    initial_candidate_scope: "owner_private_unassigned",
    source_segments_checked: initialLifecycle.segments_total,
    scenario_count: scenarios.length,
    scenarios,
    real_entry_gates_unverified: proposals.h1_real_entry_gates.length,
    source_text_disclosed: false,
    source_locators_disclosed: false,
    proposal_identifiers_disclosed: false,
    toy_binding_digest_disclosed: false,
  };
}
