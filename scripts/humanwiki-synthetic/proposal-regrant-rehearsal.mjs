// HumanWiki H1-synthetic: revoked-source replay/regrant contract rehearsal.
// Fictional states, toy counters and unkeyed digests ONLY. No real source,
// actor, consent ledger, durable witness, CAS, persistence or authorization.
import { bindSyntheticProposalReview } from "./proposal-review-rehearsal.mjs";
import {
  previewSyntheticProposalLifecycleHolds,
  rehearseSyntheticProposalLifecycleIntent,
} from "./proposal-lifecycle-holds.mjs";

const fail = () => { throw new Error("Synthetic proposal regrant: fictional fixture contract not satisfied"); };
const scenarios = Object.freeze([
  Object.freeze({ id: "initial_active", epoch: 10, last_revoked: 9, consent_epoch: 10, lifecycle: "active", binding_epoch: 10 }),
  Object.freeze({ id: "revoked", epoch: 11, last_revoked: 11, consent_epoch: 10, lifecycle: "revoke", binding_epoch: 10 }),
  Object.freeze({ id: "reappeared_without_regrant", epoch: 12, last_revoked: 11, consent_epoch: 10, lifecycle: "active", binding_epoch: 10 }),
  Object.freeze({ id: "fresh_toy_regrant_old_binding", epoch: 13, last_revoked: 11, consent_epoch: 13, lifecycle: "active", binding_epoch: 10 }),
  Object.freeze({ id: "fresh_toy_regrant_new_binding", epoch: 13, last_revoked: 11, consent_epoch: 13, lifecycle: "active", binding_epoch: 13 }),
  Object.freeze({ id: "source_epoch_rollback", epoch: 10, last_revoked: 11, consent_epoch: 10, lifecycle: "active", binding_epoch: 10 }),
  Object.freeze({ id: "source_and_witness_rollback_counterexample", epoch: 10, last_revoked: 9, consent_epoch: 10, lifecycle: "active", binding_epoch: 10 }),
]);
const known = new Map(scenarios.map(s => [s.id, s]));
const common = Object.freeze({
  synthetic_fixture_only: true,
  mode: "fictional_proposal_regrant_aba_fence_no_write",
  content_only_binding_does_not_grant_consent: true,
  user_consent_actually_verified: false,
  reviewer_identity_authenticated: false,
  area_acl_actually_verified: false,
  monotonic_witness_authenticated: false,
  actual_compare_and_swap_performed: false,
  actual_lifecycle_event_written: false,
  actual_new_consent_recorded: false,
  actual_human_review_completed: false,
  actual_deletions_performed: 0,
  actual_invalidation_performed: 0,
  claims_created: 0,
  review_outcomes_written: 0,
  actual_tasks_created: 0,
  data_release_authorized: false,
  real_import_enabled: false,
});
const status = (frame, decision, inspected = false) => ({
  ...common,
  scenario: frame.id,
  decision,
  review_intent_inspected: inspected,
  candidate_review: "proposed",
  candidate_sensitivity: "unclassified",
  candidate_scope: "owner_private_unassigned",
  source_content_unchanged: true,
  source_text_disclosed: false,
  source_locator_disclosed: false,
  proposal_identifier_disclosed: false,
  toy_binding_digest_disclosed: false,
  real_entry_gates_unverified: 6,
});

function validated(bundles) {
  // Full exact fixture pinning and all H1-real status gates from #358-#362.
  const binding = bindSyntheticProposalReview(bundles);
  const matrix = previewSyntheticProposalLifecycleHolds(bundles);
  const scenarioMap = new Map(matrix.scenarios.map(x => [x.scenario, x]));
  if (matrix.scenario_count !== 6 ||
      matrix.real_entry_gates_unverified !== 6 ||
      matrix.claims_created !== 0 ||
      matrix.real_import_enabled !== false ||
      scenarioMap.get("active")?.candidate_pending_visible !== true ||
      scenarioMap.get("revoke")?.candidate_pending_visible !== false ||
      scenarioMap.get("erase")?.candidate_pending_visible !== false ||
      scenarioMap.get("unrelated_disconnect")?.candidate_pending_visible !== true) fail();
  return binding;
}

/**
 * Accepts only hardcoded fictional timeline keys and two exact committed
 * fixtures. No external state/frame/consent input is permitted. The supplied
 * intent is read only if the chosen toy lifecycle/regrant preflight permits
 * evaluation. Even the "permit" case never completes real human review.
 */
export function rehearseSyntheticProposalRegrantScenario(bundles, scenarioId, intents) {
  const frame = known.get(scenarioId);
  if (!frame) fail();
  const binding = validated(bundles);
  if (binding.draft_id !== "toy-garden-topic-draft-01" ||
      typeof binding.toy_digest !== "string") fail();

  // A replay of the entire fake witness cannot be detected by any LOCAL
  // source/content/epoch match. Demonstrate this untrustworthy boundary,
  // then fail-closed: no tool may call it consent, approval or authorization.
  if (frame.id === "source_and_witness_rollback_counterexample") {
    if (!(frame.epoch === frame.binding_epoch &&
          frame.consent_epoch > frame.last_revoked &&
          frame.lifecycle === "active")) fail();
    return {
      ...status(frame, "unsafe_replay_if_independent_witness_also_rolled_back"),
      toy_untrusted_replay_would_appear_valid: true,
      real_witness_required_to_detect_this: true,
    };
  }
  // Recalled revocation wins even if the content and caller's old binding
  // look identical. No attempt to parse even a hostile intent in these cases.
  if (frame.epoch <= frame.last_revoked) {
    return status(frame, frame.lifecycle === "revoke"
      ? "would_hold_revoked_source_without_inspecting_intent"
      : "would_block_replayed_pre_revocation_generation");
  }
  if (frame.lifecycle !== "active") fail();
  if (frame.consent_epoch <= frame.last_revoked) {
    return status(frame, "would_require_fresh_explicit_toy_regrant");
  }
  if (frame.binding_epoch !== frame.epoch) {
    return status(frame, "would_block_pre_regrant_binding_even_with_same_content");
  }
  // A plausible newer generation is still only fictional metadata, not
  // consent. The downstream call is a no-write dry-run review intention.
  const result = rehearseSyntheticProposalLifecycleIntent(bundles, "active", intents);
  if (result.review_intent_evaluated !== true ||
      result.claims_created !== 0 ||
      result.review_outcomes_written !== 0 ||
      result.data_release_authorized !== false ||
      result.real_import_enabled !== false) fail();
  return {
    ...status(frame, "would_evaluate_fresh_fictional_intent_no_release", true),
    hypothetical_review_intent_status: result.review_intent_status,
  };
}

/** No inputs beyond pinned toy fixtures; status and count-only output. */
export function previewSyntheticProposalRegrantTimeline(bundles) {
  const binding = validated(bundles);
  const validIntent = [{ draft_id: binding.draft_id, choice: "inspect" }];
  const unreadable = new Proxy([{}], {
    get() { throw new Error("blocked fictional intent was unexpectedly read"); },
    ownKeys() { throw new Error("blocked fictional intent keys were read"); },
    getOwnPropertyDescriptor() { throw new Error("blocked fictional intent descriptor was read"); },
  });
  const reports = scenarios.map(frame => {
    const allowed = ["initial_active", "fresh_toy_regrant_new_binding"].includes(frame.id);
    return rehearseSyntheticProposalRegrantScenario(bundles, frame.id, allowed ? validIntent : unreadable);
  });
  const expected = [
    "would_evaluate_fresh_fictional_intent_no_release",
    "would_hold_revoked_source_without_inspecting_intent",
    "would_require_fresh_explicit_toy_regrant",
    "would_block_pre_regrant_binding_even_with_same_content",
    "would_evaluate_fresh_fictional_intent_no_release",
    "would_block_replayed_pre_revocation_generation",
    "unsafe_replay_if_independent_witness_also_rolled_back",
  ];
  if (reports.length !== expected.length ||
      reports.some((x, i) => x.decision !== expected[i] ||
        x.data_release_authorized !== false ||
        x.real_import_enabled !== false ||
        x.claims_created !== 0 ||
        x.review_outcomes_written !== 0 ||
        x.real_entry_gates_unverified !== 6) ||
      reports.filter(x => x.review_intent_inspected).length !== 2 ||
      reports.at(-1)?.real_witness_required_to_detect_this !== true) fail();
  return {
    ...common,
    scenario_count: reports.length,
    scenarios: reports,
    content_only_binding_stays_identical: true,
    synthetic_regrant_is_not_real_consent: true,
    source_text_disclosed: false,
    source_locators_disclosed: false,
    toy_binding_digest_disclosed: false,
    real_entry_gates_unverified: 6,
  };
}
