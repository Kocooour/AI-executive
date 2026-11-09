// HumanWiki H1-synthetic acceptance matrix: a deterministic, content-free
// cross-module rehearsal over TWO preinstalled fictional fixture shapes.
// This is not a production importer, security gate, release attestation,
// ACL, consent record, Context Graph writer, or real-data readiness claim.
import { parseSyntheticBundle, advanceSyntheticImport } from "./ingest.mjs";
import { previewSyntheticOverlaps } from "./overlap.mjs";
import { previewSyntheticReviewQueue } from "./review-preview.mjs";
import { bindSyntheticTriageIntents, rehearseVersionBoundSyntheticTriage } from "./version-bound-triage.mjs";
import { previewSyntheticSourceLifecycle } from "./lifecycle-preview.mjs";
import { makeSyntheticRestoreFixture } from "./restore-preflight.mjs";
import { previewSyntheticRestoreReplayPlan } from "./restore-replay-plan.mjs";
import { previewSyntheticDerivativeImpact } from "./derivative-impact-preview.mjs";
import { bindSyntheticDerivativeRevision, recheckSyntheticDerivativeRevision } from "./derivative-revision.mjs";
import { bindSyntheticEpochFence, makeSyntheticEpochFenceFixture, rehearseSyntheticFenceWindow, recheckSyntheticEpochFence } from "./epoch-fence-rehearsal.mjs";

const fail = () => { throw new Error("Synthetic acceptance: fixture contract not satisfied"); };
// Deliberately pinned to the exact checked-in fictional JSON only. Unkeyed
// digests prevent accidental use with modified data; they provide NO security,
// authorization, provenance or real-source privacy protection.
const sourceShapes = new Map([
  ["fixture-chatgpt-01", {
    format: "chatgpt-mapping-v1",
    digest: "44c36f199d552d57ea4b65a8cca7e52c03c5ee0fbc82a62a3283e047410c81f4",
  }],
  ["fixture-claude-01", {
    format: "claude-chat-v1",
    digest: "6b8cb2e9bf5962f41d88db3cb4ffc456f1bc9b51ef1c426b249d7a25303f1566",
  }],
]);
const status = id => ({ id, result: "toy_passed_real_release_blocked" });
const realGates = Object.freeze([
  "owner_identity_and_area_acl",
  "source_specific_explicit_consent_and_retention",
  "context_resolver_provenance_and_human_claim_review",
  "durable_revocation_and_authenticated_anti_rollback_witness",
  "transactional_dependency_coverage_replay_and_invalidation",
  "r4_production_release_and_security_e2e",
]);

function verifyCleanQueue(queue, overlap) {
  if (queue.segments_total !== overlap.segments_total ||
      queue.sources.length !== 2 ||
      queue.entries.length !== overlap.segments_total ||
      queue.entries.length === 0 ||
      !queue.entries.some(entry => entry.provenance === "owner_statement") ||
      !queue.entries.some(entry => entry.provenance === "assistant_generated") ||
      !queue.entries.some(entry => entry.provenance === "quoted_third_party") ||
      queue.entries.some(entry =>
        entry.review !== "proposed" ||
        entry.freshness !== "current" ||
        entry.disputed !== false ||
        entry.sensitivity !== "unclassified" ||
        entry.scope !== "owner_private_unassigned" ||
        entry.independent_evidence !== false ||
        entry.eligible_for_automatic_confirmation !== false ||
        entry.requires_explicit_review !== true ||
        !Array.isArray(entry.reason_codes) ||
        entry.reason_codes.length < 1) ||
      overlap.groups.some(group => group.independent_evidence !== false) ||
      queue.claims_created !== 0 || queue.review_outcomes_written !== 0) fail();
}

/**
 * Challenge the overlap/review rules with an INTERNAL fake copy only.
 * The two pinned input fixtures intentionally contain no exact repeats;
 * checking their empty duplicate-group list would be vacuously green.
 * Never change the externally accepted fixture digests or expose the copy.
 */
function verifyFictionalDuplicateEvidence(bundles) {
  const probe = structuredClone(bundles);
  const chatgpt = probe.find(source => source.source_id === "fixture-chatgpt-01");
  const claude = probe.find(source => source.source_id === "fixture-claude-01");
  if (!chatgpt || !claude) fail();

  const lines = chatgpt.conversations[0].mapping.a.message.content.parts[0].split("\n");
  const assistantText = chatgpt.conversations[0].mapping.b.message.content.parts[0];
  if (lines.length !== 2 || !lines[1].startsWith("> ")) fail();
  // Same text in two direct owner turns, a third-party quote vs owner
  // statement, and two assistant turns: NONE is independent evidence.
  claude.conversations[0].chat_messages[0].content[0].text =
    [lines[0], lines[1].slice(2)].join("\n");
  claude.conversations[0].chat_messages[1].content[0].text = assistantText;

  const overlap = previewSyntheticOverlaps(probe);
  const queue = previewSyntheticReviewQueue(probe);
  verifyCleanQueue(queue, overlap);
  if (overlap.duplicate_groups !== 3 ||
      overlap.cross_source_duplicate_groups !== 3 ||
      overlap.repeated_segment_occurrences !== 6 ||
      queue.duplicate_groups !== 3 ||
      queue.entries.length !== 6 ||
      overlap.groups.some(group =>
        group.members.length !== 2 ||
        group.cross_source !== true ||
        group.independent_evidence !== false ||
        group.review !== "proposed" ||
        group.members.some(member =>
          member.review !== "proposed" ||
          member.sensitivity !== "unclassified")) ||
      queue.entries.some(entry =>
        entry.duplicate_group_id === null ||
        entry.cross_source_repeat !== true ||
        !entry.reason_codes.includes("repeated_text_not_independent_evidence") ||
        entry.independent_evidence !== false ||
        entry.eligible_for_automatic_confirmation !== false ||
        entry.review !== "proposed" ||
        entry.sensitivity !== "unclassified") ||
      queue.claims_created !== 0 ||
      queue.review_outcomes_written !== 0) fail();

  const quoteGroup = overlap.groups.find(group =>
    group.members.some(member => member.provenance === "quoted_third_party"));
  if (!quoteGroup || quoteGroup.members.length !== 2 ||
      !quoteGroup.members.some(member => member.provenance === "owner_statement") ||
      !quoteGroup.members.some(member => member.speaker === "unknown")) fail();
  return overlap.duplicate_groups;
}

/**
 * A correct unchanged-source decision is not enough to validate version
 * binding. Edit an UNSELECTED message in the selected fake source AFTER
 * binding; the old user decision must fail with a stale-version error.
 */
function verifyStaleFictionalTriage(bundles, boundIntents) {
  const old = boundIntents.find(intent =>
    intent.locator.source_id === "fixture-chatgpt-01" &&
    intent.choice === "consider");
  if (!old) fail();
  const edited = structuredClone(bundles);
  const changedSource = edited.find(bundle =>
    bundle.source_id === "fixture-chatgpt-01");
  if (!changedSource) fail();
  const other = changedSource.conversations[0].mapping.b.message;
  if (old.locator.message_id === other.id) fail();
  other.content.parts[0] += " (synthetic post-decision revision)";
  // Keep the same locator and a structurally valid fictional bundle.
  parseSyntheticBundle(changedSource);
  let rejectedAsStale = false;
  try {
    rehearseVersionBoundSyntheticTriage(edited, [old]);
  } catch (error) {
    rejectedAsStale = error instanceof Error &&
      error.message === "Synthetic versioned triage: stale or missing synthetic source version";
  }
  if (!rejectedAsStale) fail();
  return true;
}

/**
 * Inputs must match the exact two committed *fictional fixtures*.
 * The source IDs, marker and unkeyed pinned digests are NOT authentication
 * or authorization for real content.
 * Only the no-argument CLI reads checked-in fixture files. Never use this
 * helper with personal exports or attach it to an app endpoint.
 */
export function previewSyntheticHumanWikiAcceptance(bundles) {
  if (!Array.isArray(bundles) || bundles.length !== 2) fail();
  const parsed = bundles.map(bundle => parseSyntheticBundle(bundle));
  const seen = new Set();
  for (const source of parsed) {
    const pinned = sourceShapes.get(source.source_id);
    if (!pinned || pinned.format !== source.format ||
        pinned.digest !== source.digest ||
        seen.has(source.source_id) || !Array.isArray(source.messages) ||
        source.messages.length === 0) fail();
    seen.add(source.source_id);
    const first = advanceSyntheticImport(source, undefined, 1);
    const resumed = advanceSyntheticImport(source, first);
    const oneShot = advanceSyntheticImport(source);
    if (first.next_message !== 1 ||
        resumed.next_message !== source.messages.length ||
        JSON.stringify(resumed) !== JSON.stringify(oneShot) ||
        oneShot.records.some(record =>
          record.review !== "proposed" ||
          record.sensitivity !== "unclassified" ||
          record.scope !== "owner_private_unassigned")) fail();
  }
  if (seen.size !== sourceShapes.size) fail();

  const overlap = previewSyntheticOverlaps(bundles);
  const queue = previewSyntheticReviewQueue(bundles);
  verifyCleanQueue(queue, overlap);
  const duplicateGroupsExercised = verifyFictionalDuplicateEvidence(bundles);

  // Select three *fictional segment* intents, not claim decisions or consent.
  const selection = ["owner_statement", "quoted_third_party", "assistant_generated"]
    .map((provenance, index) => {
      const entry = queue.entries.find(item => item.provenance === provenance);
      if (!entry) fail();
      return {
        locator: { ...entry.locator },
        choice: ["consider", "defer", "skip"][index],
      };
    });
  const boundIntents = bindSyntheticTriageIntents(bundles, selection);
  const triage = rehearseVersionBoundSyntheticTriage(bundles, boundIntents);
  if (triage.triage_intents_applied !== 3 ||
      triage.source_version_checks !== 3 ||
      triage.claims_created !== 0 ||
      triage.review_outcomes_written !== 0 ||
      triage.entries.some(entry =>
        entry.review !== "proposed" ||
        entry.sensitivity !== "unclassified" ||
        entry.independent_evidence !== false)) fail();
  const staleDecisionRejected = verifyStaleFictionalTriage(bundles, boundIntents);

  const lifecycle = previewSyntheticSourceLifecycle(bundles, [
    { source_id: "fixture-chatgpt-01", action: "request_erasure" },
    { source_id: "fixture-claude-01", action: "revoke_import_consent" },
  ]);
  if (lifecycle.visible_entries.length !== 0 ||
      lifecycle.visible_segments !== 0 ||
      lifecycle.suppressed_segments !== queue.segments_total ||
      lifecycle.durable_lifecycle_events_written !== 0 ||
      lifecycle.tombstones_written !== 0 ||
      lifecycle.source_states.some(source =>
        source.operation_completed !== false ||
        source.witness_confirmed !== false ||
        source.durable_lifecycle_event_written !== false ||
        source.would_invalidate_source_derivatives !== true)) fail();

  // Recovery is a SEPARATE fictional fixture (source IDs here are deliberately
  // unrelated to the ChatGPT/Claude toy bundles). No actual actions occur.
  const restore = makeSyntheticRestoreFixture();
  const replay = previewSyntheticRestoreReplayPlan(restore);
  const derivatives = previewSyntheticDerivativeImpact(restore);
  const revision = bindSyntheticDerivativeRevision(restore);
  const checked = recheckSyntheticDerivativeRevision(restore, undefined, revision);
  if (replay.plan_status !== "requires_hypothetical_replay" ||
      replay.event_obligations.length !== 2 ||
      replay.event_obligations.some(event => event.completed !== false) ||
      replay.replay_completed !== false ||
      derivatives.impact_status !== "hypothetical_impacts_only" ||
      !derivatives.fictional_fixture_manifest_matched ||
      derivatives.claim_impacts.length !== 6 ||
      derivatives.artifact_impacts.length !== 10 ||
      derivatives.artifact_impacts.some(item => item.served ||
        item.invalidation_completed || !item.must_revalidate_before_any_release) ||
      checked.revision_status !== "toy_revision_matches_no_release" ||
      checked.data_release_authorized !== false) fail();

  const a = makeSyntheticEpochFenceFixture(restore, 1);
  const token = bindSyntheticEpochFence(a);
  const b = structuredClone(a);
  b.toy_epoch = 2;
  b.restore_state.snapshot = {
    applied_sequence: 1, applied_digest: b.restore_state.registry[0].digest,
  };
  const bVerified = recheckSyntheticEpochFence(b, bindSyntheticEpochFence(b));
  const returnedA = structuredClone(a);
  returnedA.toy_epoch = 3;
  const detected = rehearseSyntheticFenceWindow(a, returnedA, token);
  const undetected = rehearseSyntheticFenceWindow(a, structuredClone(a), token);
  if (bVerified.fence_status !== "toy_fence_matches_no_release" ||
      JSON.stringify(b.restore_state) === JSON.stringify(a.restore_state) ||
      JSON.stringify(returnedA.restore_state) !== JSON.stringify(a.restore_state) ||
      detected.window_status !== "would_abort_at_final_check" ||
      undetected.window_status !== "toy_checks_match_no_commit" ||
      detected.actual_compare_and_swap_performed !== false ||
      detected.data_release_authorized !== false ||
      undetected.data_release_authorized !== false) fail();

  return {
    synthetic_fixture_only: true,
    mode: "humanwiki_h1_synthetic_cross_module_acceptance_preview",
    synthetic_status: "toy_checks_passed",
    source_count: 2,
    segments_total: queue.segments_total,
    provenance_counts: { ...queue.provenance_counts },
    synthetic_negative_cases: {
      cross_source_duplicate_groups_exercised: duplicateGroupsExercised,
      stale_source_decision_rejected: staleDecisionRejected,
    },
    synthetic_checks: [
      status("resumable_import_and_idempotence"),
      status("speaker_quote_and_assistant_provenance"),
      status("duplicate_evidence_remains_unverified"),
      status("version_bound_segment_triage_without_approval"),
      status("source_revocation_and_erasure_suppress_review"),
      status("restore_replay_and_derived_output_hold"),
      status("epoch_aba_and_rollback_limit_exposed"),
    ],
    h1_real_entry_gates: realGates.map(id => ({ id, result: "not_verified_blocked" })),
    h1_real_import_enabled: false,
    h2_production_ui_enabled: false,
    personal_export_compatibility_verified: false,
    source_text_or_identifiers_disclosed: false,
    source_digest_disclosed: false,
    assistant_statements_promoted_to_owner_facts: false,
    independent_evidence_proven: false,
    actual_imports_performed: 0,
    claims_created: 0,
    review_outcomes_written: 0,
    durable_revocations_written: 0,
    actual_witness_contacted: false,
    actual_deletions_performed: 0,
    actual_invalidation_performed: 0,
    actual_compare_and_swap_performed: false,
    data_release_authorized: false,
    real_import_enabled: false,
  };
}
