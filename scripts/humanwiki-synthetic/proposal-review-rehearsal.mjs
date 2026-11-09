// HumanWiki H1-synthetic only: no-write proposal-review decision rehearsal.
// NOT a human review, approval, authorized command, source consent, or CAS.
// The caller-supplied digest is toy metadata, NOT a signed/secure token.
import { createHash } from "node:crypto";
import { previewSyntheticClaimProposals } from "./claim-proposal-preview.mjs";
import { previewSyntheticReviewQueue } from "./review-preview.mjs";

const fail = reason => { throw new Error("Synthetic proposal review: " + reason); };
const plain = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
   Object.getPrototypeOf(value) === null);
const exact = (value, fields) => plain(value) &&
  Reflect.ownKeys(value).length === fields.length &&
  fields.every(key => Object.hasOwn(value, key));
const sha = value => createHash("sha256").update(value).digest("hex");
const hex = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const schema = "fictional_humanwiki_proposal_review_binding_v1";
const choices = new Set(["inspect", "defer", "shelve"]);
const missingGates = Object.freeze([
  "authenticated_reviewer_identity_and_owner_area_acl",
  "explicit_source_consent_and_valid_retention",
  "classified_sensitivity_and_provenance_review",
  "independent_revocation_witness_and_anti_rollback",
  "atomic_claim_commit_and_dependent_cache_invalidation",
  "r4_release_and_end_to_end_security_validation",
]);
const noWrite = Object.freeze({
  synthetic_fixture_only: true,
  mode: "fictional_proposal_review_intent_rehearsal_no_write",
  actual_human_review_completed: false,
  reviewer_identity_authenticated: false,
  source_consent_verified: false,
  sensitivity_classified: false,
  atomic_commit_performed: false,
  durable_review_event_written: false,
  claim_confirmed: false,
  claims_created: 0,
  review_outcomes_written: 0,
  actual_tasks_created: 0,
  external_model_egress_performed: false,
  data_release_authorized: false,
  real_import_enabled: false,
});

function current(bundles) {
  // This upstream preview checks exact pinned fixture bytes, origin and the
  // full H1-synthetic acceptance. Not evidence of a production release gate.
  const preview = previewSyntheticClaimProposals(bundles);
  if (preview.draft_proposals.length !== 1 ||
      preview.withheld_entries.length !== 5 ||
      preview.h1_real_entry_gates.some(gate => gate.result !== "not_verified_blocked") ||
      preview.h1_real_import_enabled !== false ||
      preview.data_release_authorized !== false) fail("fictional preview not eligible");

  const draft = preview.draft_proposals[0];
  if (draft.draft_id !== "toy-garden-topic-draft-01" ||
      draft.review !== "proposed" ||
      draft.sensitivity !== "unclassified" ||
      draft.scope !== "owner_private_unassigned" ||
      draft.provenance !== "owner_statement" ||
      draft.requires_explicit_human_claim_review !== true ||
      draft.claim_confirmed !== false ||
      draft.canonical_claim_written !== false ||
      draft.canonical_task_written !== false ||
      draft.usable_as_personal_fact !== false) fail("fictional draft changed");

  // Bind the candidate AND both precise fictional source revisions. Source
  // ordering is canonical and cannot influence the fake review token.
  const ordered = [...bundles].sort((a, b) =>
    a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0);
  return { draft, toy_digest: toyFrameDigest(ordered, draft) };
}

// Internal digest for validated, immutable-to-the-caller fictional frames.
// The source ordering is canonical even when the fixtures are supplied reversed.
function toyFrameDigest(sources, draft) {
  const ordered = [...sources].sort((a, b) =>
    a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0);
  return sha(JSON.stringify({ sources: ordered, draft }));
}
function bindingFromFrame(frame) {
  return { schema, draft_id: frame.draft.draft_id, toy_digest: frame.toy_digest };
}

function checkBinding(binding) {
  if (!exact(binding, ["schema", "draft_id", "toy_digest"]) ||
      binding.schema !== schema ||
      binding.draft_id !== "toy-garden-topic-draft-01" ||
      !hex(binding.toy_digest)) fail("malformed fictional review binding");
}

function checkIntent(intents, draftId) {
  if (!Array.isArray(intents) || intents.length > 1) fail("invalid review intent list");
  if (intents.length === 0) return null;
  const [item] = intents;
  // In particular confirm/approve/reject/share/create_task (and free text)
  // are explicitly prohibited. "shelve" is only a fictional intention;
  // there is never an actual rejected claim or deletion.
  if (!exact(item, ["draft_id", "choice"]) ||
      item.draft_id !== draftId ||
      typeof item.choice !== "string" ||
      !choices.has(item.choice)) fail("invalid fictional review intent");
  return item.choice;
}

/** Bind a single fictional draft to the two exact, checked-in fake sources. */
export function bindSyntheticProposalReview(bundles) {
  return bindingFromFrame(current(bundles));
}

/**
 * Simulate a review UI intent. No choice is an actual review outcome, no
 * entity is written, and none grants authorization. An upstream toy revision
 * mismatch short-circuits without inspecting the submitted intent list.
 */
export function rehearseSyntheticProposalReview(bundles, binding, intents = []) {
  checkBinding(binding);
  return evaluateFictionalReviewFrame(current(bundles), binding, intents);
}

// This private evaluator accepts only frames already validated or assembled
// inside this module. Public callers cannot bypass exact-fixture pinning.
function evaluateFictionalReviewFrame(value, binding, intents) {
  if (value.toy_digest !== binding.toy_digest) {
    return {
      ...noWrite,
      review_gate_status: "would_block_stale_fictional_binding",
      review_intent: "not_evaluated",
      missing_real_gates: [...missingGates],
      current_review: "proposed",
      current_sensitivity: "unclassified",
      current_scope: "owner_private_unassigned",
    };
  }

  const choice = checkIntent(intents, value.draft.draft_id);
  const statuses = {
    inspect: "would_open_source_for_explicit_review_only",
    defer: "would_defer_draft_without_review_outcome",
    shelve: "would_shelve_draft_without_review_outcome",
  };
  return {
    ...noWrite,
    review_gate_status: choice ? statuses[choice] : "no_review_intent_submitted",
    review_intent: choice ?? "none",
    missing_real_gates: [...missingGates],
    current_review: "proposed",
    current_sensitivity: "unclassified",
    current_scope: "owner_private_unassigned",
  };
}

// An INTERNAL, deterministic A → B exercise. Both frames are fictional, and
// the public binder/reviewer STILL accept only the two exact committed inputs.
// B edits a different message in the SAME source as the candidate; the
// candidate/source locator and the review-protection fields are unchanged.
// This prevents a fake "stale" test using only a zeroed caller token.
export function rehearseSyntheticProposalReviewRevisionTransition(bundles) {
  const frameA = current(bundles); // strict pinned input + full toy acceptance
  const bindingA = bindingFromFrame(frameA);
  const revisionB = structuredClone(bundles);
  const chatgptB = revisionB.find(item => item.source_id === "fixture-chatgpt-01");
  const chatgptA = bundles.find(item => item.source_id === "fixture-chatgpt-01");
  if (!chatgptA || !chatgptB) fail("invalid fictional transition source");
  const unchangedCandidate = chatgptB.conversations[0].mapping.a.message;
  const otherMessage = chatgptB.conversations[0].mapping.b.message;
  if (otherMessage.id === frameA.draft.source_locator.message_id ||
      typeof otherMessage.content?.parts?.[0] !== "string") {
    fail("invalid fictional transition message");
  }
  otherMessage.content.parts[0] += " (independent fictional revision B)";

  // The B source is independently valid for the existing synthetic parser
  // and review queue. It is NOT passed through the strict public proposal
  // preview: that must continue to reject anything but committed A fixtures.
  const baseline = previewSyntheticReviewQueue(bundles);
  const revised = previewSyntheticReviewQueue(revisionB);
  const beforeCandidate = chatgptA.conversations[0].mapping.a.message;
  const expectedLocator = JSON.stringify(frameA.draft.source_locator);
  const revisedCandidate = revised.entries.find(item =>
    JSON.stringify(item.locator) === expectedLocator);
  if (JSON.stringify(revisionB) === JSON.stringify(bundles) ||
      JSON.stringify(unchangedCandidate) !== JSON.stringify(beforeCandidate) ||
      baseline.entries.length !== 6 ||
      revised.entries.length !== baseline.entries.length ||
      revised.duplicate_groups !== 0 ||
      revised.claims_created !== 0 || revised.review_outcomes_written !== 0 ||
      revised.entries.some(item =>
        item.review !== "proposed" ||
        item.sensitivity !== "unclassified" ||
        item.scope !== "owner_private_unassigned" ||
        item.independent_evidence !== false ||
        item.eligible_for_automatic_confirmation !== false ||
        item.requires_explicit_review !== true) ||
      !revisedCandidate ||
      revisedCandidate.provenance !== frameA.draft.provenance ||
      revisedCandidate.speaker !== frameA.draft.speaker ||
      revisedCandidate.observed_at !== frameA.draft.observed_at ||
      revisedCandidate.review !== frameA.draft.review) {
    fail("fictional revision B invalid");
  }
  const frameB = {
    draft: frameA.draft,
    toy_digest: toyFrameDigest(revisionB, frameA.draft),
  };
  if (frameA.toy_digest === frameB.toy_digest) fail("fictional revision not advanced");
  const bindingB = bindingFromFrame(frameB);
  // A stale intent must not be read, even if its submitted shape is hostile.
  const unreadableIntent = new Proxy([{}], {
    get() { throw new Error("stale fictional intent should never be inspected"); },
  });
  const stale = evaluateFictionalReviewFrame(frameB, bindingA, unreadableIntent);
  const fresh = evaluateFictionalReviewFrame(frameB, bindingB, [
    { draft_id: bindingB.draft_id, choice: "inspect" },
  ]);
  const initial = evaluateFictionalReviewFrame(frameA, bindingA, [
    { draft_id: bindingA.draft_id, choice: "defer" },
  ]);
  if (stale.review_gate_status !== "would_block_stale_fictional_binding" ||
      stale.review_intent !== "not_evaluated" ||
      fresh.review_gate_status !== "would_open_source_for_explicit_review_only" ||
      initial.review_gate_status !== "would_defer_draft_without_review_outcome" ||
      [stale, fresh, initial].some(report =>
        report.current_review !== "proposed" ||
        report.current_sensitivity !== "unclassified" ||
        report.claim_confirmed !== false ||
        report.claims_created !== 0 ||
        report.review_outcomes_written !== 0 ||
        report.actual_human_review_completed !== false ||
        report.atomic_commit_performed !== false ||
        report.data_release_authorized !== false ||
        report.real_import_enabled !== false)) {
    fail("fictional transition result invalid");
  }
  return {
    ...noWrite,
    mode: "fictional_proposal_review_a_to_b_transition_no_write",
    valid_independent_revision_b: true,
    changed_source_is_candidate_source: true,
    revised_message_is_not_candidate: true,
    unchanged_candidate_preserved: true,
    revisions_have_distinct_toy_digests: true,
    stale_a_on_b: stale.review_gate_status,
    stale_intent_not_evaluated: stale.review_intent === "not_evaluated",
    fresh_b_on_b: fresh.review_gate_status,
    original_a_on_a: initial.review_gate_status,
    missing_real_gates: [...missingGates],
    current_review: "proposed",
    current_sensitivity: "unclassified",
    current_scope: "owner_private_unassigned",
  };
}
