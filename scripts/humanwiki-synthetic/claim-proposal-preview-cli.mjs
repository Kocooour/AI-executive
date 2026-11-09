// Zero-argument, no-write and content-free HumanWiki toy proposal preview.
// The only inputs are the two committed fictional JSON fixtures.
import { readFileSync } from "node:fs";
import { previewSyntheticClaimProposals } from "./claim-proposal-preview.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/claim-proposal-preview-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const bundles = ["chatgpt", "claude"].map(name =>
      JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")));
    const report = previewSyntheticClaimProposals(bundles);
    if (report.draft_proposals_count !== 1 ||
        report.withheld_segments_count !== 5 ||
        report.model_extraction_performed !== false ||
        report.h1_real_import_enabled !== false ||
        report.data_release_authorized !== false) {
      throw new Error("toy proposal invariant broken");
    }
    // Never print source locators, timestamps, IDs, content or fingerprints.
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      mode: report.mode,
      source_segments_checked: report.source_segments_checked,
      draft_proposals_count: report.draft_proposals_count,
      withheld_segments_count: report.withheld_segments_count,
      withheld_reason_counts: report.withheld_reason_counts,
      candidates_require_explicit_human_review: true,
      source_text_disclosed: false,
      source_locators_disclosed: false,
      source_digests_disclosed: false,
      model_extraction_performed: report.model_extraction_performed,
      auto_identity_resolution_performed: report.auto_identity_resolution_performed,
      explicit_claim_review_completed: report.explicit_claim_review_completed,
      actual_claims_created: report.actual_claims_created,
      claims_confirmed: report.claims_confirmed,
      actual_tasks_created: report.actual_tasks_created,
      review_outcomes_written: report.review_outcomes_written,
      external_model_egress_performed: report.external_model_egress_performed,
      h1_real_gates_unverified: report.h1_real_entry_gates.every(gate =>
        gate.result === "not_verified_blocked"),
      data_release_authorized: report.data_release_authorized,
      real_import_enabled: report.real_import_enabled,
    }));
  } catch {
    console.error("Synthetic claim proposal: fixture contract not satisfied");
    process.exitCode = 1;
  }
}
