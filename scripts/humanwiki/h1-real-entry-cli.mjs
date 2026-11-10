// H1-real preflight status, not an import command. No arguments or files.
import { humanWikiH1RealEntryReadiness } from "../../lib/humanwiki-h1-real-entry.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki/h1-real-entry-cli.mjs");
  process.exitCode = 2;
} else {
  const report = humanWikiH1RealEntryReadiness();
  if (report.result !== "blocked_not_enabled" ||
      report.enabled !== false ||
      report.prerequisites.length !== 6 ||
      report.prerequisites.some(item => item.status !== "not_verified_blocked") ||
      report.real_data_accepted !== false ||
      report.real_data_read !== false ||
      report.data_stored !== false ||
      report.external_model_egress !== false) {
    throw new Error("H1-real import preflight must fail closed");
  }
  // Requirements only, never source content, identity, paths or consent IDs.
  process.stdout.write(JSON.stringify(report) + "\n");
}
