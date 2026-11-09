// H1-synthetic only. No args, no real files, no writes, no model calls.
// Output contains status labels, not source/proposal IDs, excerpts or hashes.
import { readFileSync } from "node:fs";
import {
  bindSyntheticProposalReview, rehearseSyntheticProposalReview,
} from "./proposal-review-rehearsal.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/proposal-review-rehearsal-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const bundles = ["chatgpt", "claude"].map(name =>
      JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")));
    const bound = bindSyntheticProposalReview(bundles);
    const noIntent = rehearseSyntheticProposalReview(bundles, bound);
    const inspect = rehearseSyntheticProposalReview(bundles, bound, [
      { draft_id: bound.draft_id, choice: "inspect" },
    ]);
    const deferred = rehearseSyntheticProposalReview(bundles, bound, [
      { draft_id: bound.draft_id, choice: "defer" },
    ]);
    const shelved = rehearseSyntheticProposalReview(bundles, bound, [
      { draft_id: bound.draft_id, choice: "shelve" },
    ]);
    const stale = rehearseSyntheticProposalReview(bundles,
      { ...bound, toy_digest: "0".repeat(64) },
      // Deliberately malformed: must never be inspected after stale binding.
      [{ private_data_must_not_be_examined: "fictional" }]);
    let forbiddenConfirmRejected = false;
    try {
      rehearseSyntheticProposalReview(bundles, bound, [
        { draft_id: bound.draft_id, choice: "confirm" },
      ]);
    } catch (error) {
      forbiddenConfirmRejected = error.message ===
        "Synthetic proposal review: invalid fictional review intent";
    }
    if (noIntent.review_gate_status !== "no_review_intent_submitted" ||
        inspect.review_gate_status !== "would_open_source_for_explicit_review_only" ||
        deferred.review_gate_status !== "would_defer_draft_without_review_outcome" ||
        shelved.review_gate_status !== "would_shelve_draft_without_review_outcome" ||
        stale.review_gate_status !== "would_block_stale_fictional_binding" ||
        stale.review_intent !== "not_evaluated" ||
        !forbiddenConfirmRejected ||
        inspect.missing_real_gates.length !== 6 ||
        inspect.claim_confirmed !== false ||
        inspect.review_outcomes_written !== 0 ||
        inspect.real_import_enabled !== false) {
      throw new Error("fictional review rehearsal failed");
    }
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      mode: noIntent.mode,
      no_intent: noIntent.review_gate_status,
      inspect: inspect.review_gate_status,
      defer: deferred.review_gate_status,
      shelve: shelved.review_gate_status,
      stale: stale.review_gate_status,
      confirm_choice_rejected: forbiddenConfirmRejected,
      real_entry_gates_unverified: inspect.missing_real_gates.length,
      current_review: inspect.current_review,
      current_sensitivity: inspect.current_sensitivity,
      reviewer_identity_authenticated: inspect.reviewer_identity_authenticated,
      source_consent_verified: inspect.source_consent_verified,
      actual_human_review_completed: inspect.actual_human_review_completed,
      durable_review_event_written: inspect.durable_review_event_written,
      claims_created: inspect.claims_created,
      review_outcomes_written: inspect.review_outcomes_written,
      actual_tasks_created: inspect.actual_tasks_created,
      data_release_authorized: inspect.data_release_authorized,
      real_import_enabled: inspect.real_import_enabled,
      source_text_disclosed: false,
      source_locators_disclosed: false,
      toy_token_hash_disclosed: false,
    }));
  } catch {
    console.error("Synthetic proposal review: fixture contract not satisfied");
    process.exitCode = 1;
  }
}
