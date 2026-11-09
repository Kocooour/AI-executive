// Fixed, checked-in fictional ChatGPT/Claude fixtures only; no arguments,
// imports, consent changes, app routes, model calls, writes or external egress.
import { readFileSync } from "node:fs";
import { previewSyntheticProposalRegrantTimeline } from "./proposal-regrant-rehearsal.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/proposal-regrant-rehearsal-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const bundles = ["chatgpt", "claude"].map(name =>
      JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")));
    const report = previewSyntheticProposalRegrantTimeline(bundles);
    if (report.scenario_count !== 7 ||
        report.scenarios.filter(s => s.review_intent_inspected).length !== 2 ||
        report.scenarios.some(s => s.data_release_authorized !== false ||
          s.actual_new_consent_recorded !== false || s.real_import_enabled !== false) ||
        report.content_only_binding_stays_identical !== true ||
        report.synthetic_regrant_is_not_real_consent !== true) {
      throw new Error("toy replay contract not satisfied");
    }
    // Never emit source data, locators, IDs, exact toy epochs, consent
    // generations or content hashes. No output holds actual approval.
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      mode: report.mode,
      scenario_count: report.scenario_count,
      decisions: report.scenarios.map(s => ({
        scenario: s.scenario, decision: s.decision,
        review_intent_inspected: s.review_intent_inspected,
      })),
      content_only_binding_stays_identical: report.content_only_binding_stays_identical,
      synthetic_regrant_is_not_real_consent: report.synthetic_regrant_is_not_real_consent,
      real_entry_gates_unverified: report.real_entry_gates_unverified,
      actual_new_consent_recorded: report.actual_new_consent_recorded,
      claims_created: report.claims_created,
      review_outcomes_written: report.review_outcomes_written,
      data_release_authorized: report.data_release_authorized,
      real_import_enabled: report.real_import_enabled,
      source_text_disclosed: false,
      source_locators_disclosed: false,
      toy_binding_digest_disclosed: false,
    }));
  } catch {
    console.error("Synthetic proposal regrant: fictional fixture contract not satisfied");
    process.exitCode = 1;
  }
}
