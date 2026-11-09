// Fixed, committed fictional fixtures only. No user paths, checkpoints,
// providers, network, database, or persistent output.
import { readFileSync } from "node:fs";
import { previewSyntheticHumanWikiAcceptance } from "./acceptance-matrix.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/acceptance-matrix-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const sources = ["chatgpt", "claude"].map(name =>
      JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")));
    const report = previewSyntheticHumanWikiAcceptance(sources);
    if (report.synthetic_status !== "toy_checks_passed" ||
        report.h1_real_entry_gates.some(gate => gate.result !== "not_verified_blocked") ||
        report.data_release_authorized !== false ||
        report.real_import_enabled !== false) {
      throw new Error("fictional readiness check failed");
    }
    console.log(JSON.stringify(report));
  } catch {
    console.error("Synthetic acceptance: fixture contract not satisfied");
    process.exitCode = 1;
  }
}
