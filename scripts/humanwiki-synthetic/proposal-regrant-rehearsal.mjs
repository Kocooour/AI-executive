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
const bindingSchema = "fictional_humanwiki_regrant_epoch_binding_v1";
const plain = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
   Object.getPrototypeOf(value) === null);
const exact = (value, fields) => plain(value) &&
  Reflect.ownKeys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const positiveToyEpoch = value => Number.isSafeInteger(value) && value > 0;
const hex = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const issuable = new Set(["initial_active", "fresh_toy_regrant_new_binding"]);
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
 * Issue a toy binding at an explicitly chosen valid fictional A or B frame.
 * The content digest comes from the existing pinned fixture proposal binder.
 * The toy epoch/consent generation is NOT trusted or authenticated.
 */
export function bindSyntheticProposalRegrant(bundles, scenarioId) {
  const frame = known.get(scenarioId);
  if (!frame || !issuable.has(frame.id)) fail();
  const proposal = validated(bundles);
  if (proposal.draft_id !== "toy-garden-topic-draft-01" ||
      !hex(proposal.toy_digest) ||
      !positiveToyEpoch(frame.epoch) ||
      !positiveToyEpoch(frame.consent_epoch) ||
      frame.consent_epoch <= frame.last_revoked) fail();
  return {
    schema: bindingSchema,
    proposal_binding: proposal,
    toy_epoch: frame.epoch,
    toy_consent_epoch: frame.consent_epoch,
  };
}

function checkBinding(binding, originalProposal) {
  if (!exact(binding, ["schema", "proposal_binding", "toy_epoch", "toy_consent_epoch"]) ||
      binding.schema !== bindingSchema ||
      !exact(binding.proposal_binding, ["schema", "draft_id", "toy_digest"]) ||
      binding.proposal_binding.schema !== originalProposal.schema ||
      binding.proposal_binding.draft_id !== originalProposal.draft_id ||
      !hex(binding.proposal_binding.toy_digest) ||
      binding.proposal_binding.toy_digest !== originalProposal.toy_digest ||
      !positiveToyEpoch(binding.toy_epoch) ||
      !positiveToyEpoch(binding.toy_consent_epoch)) fail();
}

/**
 * Evaluate a previously ISSUED, supplied toy binding against a separate,
 * immutable, hardcoded source/consent/revocation frame.
 * Signature intentionally requires a binding: never auto-mint on review.
 * Only seven fixed toy frames are accepted, never arbitrary consent state.
 */
export function rehearseSyntheticProposalRegrantScenario(bundles, scenarioId, issuedBinding, intents) {
  const frame = known.get(scenarioId);
  if (!frame) fail();
  const originalProposal = validated(bundles);
  checkBinding(issuedBinding, originalProposal);

  // A local source AND its alleged independent witness can both roll back.
  // An old actually issued A token then appears valid again. ALWAYS mark
  // unsafe, never authorize even hypothetical inspection of the input.
  if (frame.id === "source_and_witness_rollback_counterexample") {
    if (!(issuedBinding.toy_epoch === frame.epoch &&
          issuedBinding.toy_consent_epoch === frame.consent_epoch &&
          frame.consent_epoch > frame.last_revoked &&
          frame.lifecycle === "active")) fail();
    return {
      ...status(frame, "unsafe_replay_if_independent_witness_also_rolled_back"),
      toy_untrusted_replay_would_appear_valid: true,
      real_witness_required_to_detect_this: true,
    };
  }

  // This revocation snapshot belongs to the CURRENT toy frame, not to the
  // issued token. Recalled revocation wins before any intent can be read.
  if (frame.epoch <= frame.last_revoked) {
    return status(frame, frame.lifecycle === "revoke"
      ? "would_hold_revoked_source_without_inspecting_intent"
      : "would_block_replayed_pre_revocation_generation");
  }
  if (frame.lifecycle !== "active") fail();
  if (frame.consent_epoch <= frame.last_revoked) {
    return status(frame, "would_require_fresh_explicit_toy_regrant");
  }
  // Crucially compare the SAME previously issued token against the current
  // B snapshot, not two numbers preselected inside a scenario frame.
  if (issuedBinding.toy_epoch !== frame.epoch ||
      issuedBinding.toy_consent_epoch !== frame.consent_epoch) {
    return status(frame, "would_block_pre_regrant_binding_even_with_same_content");
  }

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
  // Bind A BEFORE revocation. Preserve that exact object throughout the
  // timeline; independently issue B only after the hardcoded toy regrant.
  const bindingA = bindSyntheticProposalRegrant(bundles, "initial_active");
  const bindingB = bindSyntheticProposalRegrant(bundles, "fresh_toy_regrant_new_binding");
  if (bindingA === bindingB ||
      bindingA.proposal_binding.toy_digest !== bindingB.proposal_binding.toy_digest ||
      bindingA.toy_epoch === bindingB.toy_epoch ||
      bindingA.toy_consent_epoch === bindingB.toy_consent_epoch) fail();
  const validIntent = [{ draft_id: bindingA.proposal_binding.draft_id, choice: "inspect" }];
  const unreadable = new Proxy([{}], {
    get() { throw new Error("blocked fictional intent was unexpectedly read"); },
    ownKeys() { throw new Error("blocked fictional intent keys were read"); },
    getOwnPropertyDescriptor() { throw new Error("blocked fictional intent descriptor was read"); },
  });
  const reports = scenarios.map(frame => {
    const allowed = ["initial_active", "fresh_toy_regrant_new_binding"].includes(frame.id);
    const issued = frame.id === "fresh_toy_regrant_new_binding" ? bindingB : bindingA;
    return rehearseSyntheticProposalRegrantScenario(
      bundles, frame.id, issued, allowed ? validIntent : unreadable);
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
      reports.at(-1)?.real_witness_required_to_detect_this !== true ||
      reports[3].review_intent_inspected !== false ||
      reports[4].hypothetical_review_intent_status !==
        "would_open_source_for_explicit_review_only" ||
      reports[5].review_intent_inspected !== false) fail();
  return {
    ...common,
    scenario_count: reports.length,
    scenarios: reports,
    content_only_binding_stays_identical:
      bindingA.proposal_binding.toy_digest === bindingB.proposal_binding.toy_digest,
    old_issued_binding_rejected_after_regrant:
      reports[3].decision === "would_block_pre_regrant_binding_even_with_same_content",
    fresh_issued_binding_accepted_for_no_write_review:
      reports[4].decision === "would_evaluate_fresh_fictional_intent_no_release",
    remembered_revocation_blocks_rollback:
      reports[5].decision === "would_block_replayed_pre_revocation_generation",
    synthetic_regrant_is_not_real_consent: true,
    source_text_disclosed: false,
    source_locators_disclosed: false,
    toy_binding_digest_disclosed: false,
    real_entry_gates_unverified: 6,
  };
}
