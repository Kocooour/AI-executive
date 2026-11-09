// HumanWiki H1-synthetic only: no-write proposal-review decision rehearsal.
// NOT a human review, approval, authorized command, source consent, or CAS.
// The caller-supplied digest is toy metadata, NOT a signed/secure token.
import { createHash } from "node:crypto";
import { previewSyntheticClaimProposals } from "./claim-proposal-preview.mjs";

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
  return { draft, toy_digest: sha(JSON.stringify({
    sources: ordered, draft,
  })) };
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
  const value = current(bundles);
  return {
    schema,
    draft_id: value.draft.draft_id,
    toy_digest: value.toy_digest,
  };
}

/**
 * Simulate a review UI intent. No choice is an actual review outcome, no
 * entity is written, and none grants authorization. An upstream toy revision
 * mismatch short-circuits without inspecting the submitted intent list.
 */
export function rehearseSyntheticProposalReview(bundles, binding, intents = []) {
  checkBinding(binding);
  const value = current(bundles);
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
