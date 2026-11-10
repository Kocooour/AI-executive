// HumanWiki H1-synthetic: curated mock claim-proposal boundaries.
// This previews ONE fictional, manually specified topic draft. It is not an
// extractor, claim writer, approval flow, AI tool, or real-data adapter.
// No network, IO, identifiers outside checked-in fictional fixtures or egress.
import { previewSyntheticHumanWikiAcceptance } from "./acceptance-matrix.mjs";
import { previewSyntheticReviewQueue } from "./review-preview.mjs";

const fail = () => { throw new Error("Synthetic claim proposal: fixture contract not satisfied"); };
const locatorKey = locator => JSON.stringify([
  locator.source_id, locator.conversation_id, locator.message_id, locator.segment,
]);
const categories = Object.freeze({
  candidate: "candidate_only_not_fact",
  question: "owner_question_not_an_assertion",
  assistant: "assistant_output_not_owner_evidence",
  quote: "third_party_quote_not_owner_evidence",
});

// Deliberately hand-curated from the two immutable fictional fixture files.
// No text inference or assertion extraction is performed by this module.
// Crucially, a user QUESTION is not an autobiographical statement, and an
// assistant-authored ownership sentence never becomes a user's fact.
const toyManifest = Object.freeze([
  { locator: ["fixture-chatgpt-01", "chat-synthetic-01", "m-01", 0],
    provenance: "owner_statement", speaker: "user", kind: "candidate" },
  { locator: ["fixture-chatgpt-01", "chat-synthetic-01", "m-01", 1],
    provenance: "quoted_third_party", speaker: "unknown", kind: "quote" },
  { locator: ["fixture-chatgpt-01", "chat-synthetic-01", "m-02", 0],
    provenance: "assistant_generated", speaker: "assistant", kind: "assistant" },
  { locator: ["fixture-claude-01", "claude-synthetic-01", "c-01", 0],
    provenance: "owner_statement", speaker: "user", kind: "question" },
  { locator: ["fixture-claude-01", "claude-synthetic-01", "c-02", 0],
    provenance: "assistant_generated", speaker: "assistant", kind: "assistant" },
  { locator: ["fixture-claude-01", "claude-synthetic-01", "c-02", 1],
    provenance: "quoted_third_party", speaker: "unknown", kind: "quote" },
]);
const keyedManifest = new Map(toyManifest.map(item => [JSON.stringify(item.locator), item]));
if (keyedManifest.size !== toyManifest.length) fail();

function classify(entry) {
  const spec = keyedManifest.get(locatorKey(entry.locator));
  if (!spec || entry.provenance !== spec.provenance ||
      entry.speaker !== spec.speaker ||
      entry.review !== "proposed" ||
      entry.freshness !== "current" ||
      entry.disputed !== false ||
      entry.sensitivity !== "unclassified" ||
      entry.scope !== "owner_private_unassigned" ||
      entry.independent_evidence !== false ||
      entry.eligible_for_automatic_confirmation !== false ||
      entry.requires_explicit_review !== true) fail();
  if (!Object.hasOwn(categories, spec.kind)) fail();
  return spec;
}

/**
 * Apply an explicitly hardcoded fictional candidate template after the
 * previous cross-module acceptance and provenance checks. The template is
 * NOT produced by a model and is NOT evidence of the owner's real biography.
 */
export function previewSyntheticClaimProposals(bundles) {
  const prior = previewSyntheticHumanWikiAcceptance(bundles);
  if (prior.synthetic_status !== "toy_checks_passed" ||
      prior.h1_real_import_enabled !== false ||
      prior.data_release_authorized !== false) fail();

  const queue = previewSyntheticReviewQueue(bundles);
  if (queue.entries.length !== toyManifest.length ||
      queue.claims_created !== 0 || queue.review_outcomes_written !== 0) fail();

  const draft_proposals = [];
  const withheld_entries = [];
  const seen = new Set();

  for (const entry of queue.entries) {
    const key = locatorKey(entry.locator);
    if (seen.has(key)) fail();
    seen.add(key);
    const spec = classify(entry);
    if (spec.kind === "candidate") {
      // A tentative TOPIC/PROJECT suggestion, never a confirmed biography,
      // real claim, new task, shared workspace, or independent evidence.
      draft_proposals.push({
        draft_id: "toy-garden-topic-draft-01",
        draft_type: "fictional_project_topic_suggestion",
        fictional_subject: "toy_owner",
        fictional_relation: "may_be_planning",
        fictional_object: "fictional_garden",
        source_locator: { ...entry.locator },
        observed_at: entry.observed_at,
        provenance: entry.provenance,
        speaker: entry.speaker,
        review: entry.review,
        freshness: entry.freshness,
        disputed: entry.disputed,
        sensitivity: entry.sensitivity,
        scope: entry.scope,
        independent_evidence: false,
        requires_explicit_human_claim_review: true,
        claim_confirmed: false,
        canonical_claim_written: false,
        canonical_task_written: false,
        usable_as_personal_fact: false,
      });
    } else {
      withheld_entries.push({
        source_locator: { ...entry.locator },
        provenance: entry.provenance,
        reason_code: categories[spec.kind],
        eligible_for_claim_proposal: false,
      });
    }
  }
  if (seen.size !== toyManifest.length ||
      draft_proposals.length !== 1 || withheld_entries.length !== 5 ||
      draft_proposals[0].provenance !== "owner_statement" ||
      withheld_entries.filter(item =>
        item.reason_code === categories.assistant).length !== 2 ||
      withheld_entries.filter(item =>
        item.reason_code === categories.quote).length !== 2 ||
      withheld_entries.filter(item =>
        item.reason_code === categories.question).length !== 1) fail();

  return {
    synthetic_fixture_only: true,
    mode: "manually_curated_fictional_claim_proposal_preview",
    stages_checked: prior.synthetic_checks.length,
    source_segments_checked: queue.entries.length,
    draft_proposals,
    withheld_entries,
    withheld_reason_counts: {
      owner_question_not_an_assertion: 1,
      assistant_output_not_owner_evidence: 2,
      third_party_quote_not_owner_evidence: 2,
    },
    draft_proposals_count: draft_proposals.length,
    withheld_segments_count: withheld_entries.length,
    source_text_disclosed: false,
    model_extraction_performed: false,
    auto_identity_resolution_performed: false,
    source_evidence_authenticated: false,
    explicit_claim_review_completed: false,
    actual_claims_created: 0,
    claims_confirmed: 0,
    actual_tasks_created: 0,
    review_outcomes_written: 0,
    external_model_egress_performed: false,
    h1_real_entry_gates: prior.h1_real_entry_gates.map(gate => ({ ...gate })),
    h1_real_import_enabled: false,
    data_release_authorized: false,
    real_import_enabled: false,
  };
}
