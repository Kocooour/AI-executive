// Fixed fictional fixtures only; no args, network, storage, user data or writes.
import { readFileSync } from "node:fs";
import { previewSyntheticProposalLifecycleHolds } from "./proposal-lifecycle-holds.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/proposal-lifecycle-holds-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const bundles = ["chatgpt", "claude"].map(name =>
      JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")));
    const result = previewSyntheticProposalLifecycleHolds(bundles);
    if (result.scenario_count !== 6 ||
        result.scenarios.filter(s => !s.candidate_pending_visible).length !== 3 ||
        result.scenarios.filter(s => s.candidate_pending_visible).length !== 3 ||
        result.real_entry_gates_unverified !== 6 ||
        result.actual_source_reads_performed !== 0 ||
        result.durable_lifecycle_events_written !== 0 ||
        result.actual_deletions_performed !== 0 ||
        result.review_outcomes_written !== 0 ||
        result.data_release_authorized !== false ||
        result.real_import_enabled !== false) {
      throw new Error("fictional lifecycle matrix failed");
    }
    console.log(JSON.stringify(result));
  } catch {
    console.error("Synthetic proposal lifecycle: fixture contract not satisfied");
    process.exitCode = 1;
  }
}
