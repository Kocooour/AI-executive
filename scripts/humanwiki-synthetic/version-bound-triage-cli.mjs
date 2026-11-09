// Fixed fictional fixture smoke-check for content-version binding, no user inputs.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { previewSyntheticReviewQueue } from "./review-preview.mjs";
import {
  bindSyntheticTriageIntents,
  rehearseVersionBoundSyntheticTriage,
} from "./version-bound-triage.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/version-bound-triage-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const paths = ["chatgpt", "claude"].map(name =>
      fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));
    const bundles = await Promise.all(paths.map(async path =>
      JSON.parse(await readFile(path, "utf8"))));
    const first = previewSyntheticReviewQueue(bundles).entries[0];
    const intents = bindSyntheticTriageIntents(bundles, [
      { locator: first.locator, choice: "consider" },
    ]);
    const valid = rehearseVersionBoundSyntheticTriage(bundles, intents);

    // Simulate one content change while retaining the exact same source locator.
    const edited = structuredClone(bundles);
    const target = edited.find(source => source.source_id === first.locator.source_id);
    if (target.format === "chatgpt-mapping-v1") {
      target.conversations[0].mapping.a.message.content.parts[0] += " (fictional edit)";
    } else {
      target.conversations[0].chat_messages[0].content[0].text += " (fictional edit)";
    }
    let staleRejected = false;
    try {
      rehearseVersionBoundSyntheticTriage(edited, intents);
    } catch (error) {
      if (!/stale or missing synthetic source version/.test(error.message)) throw error;
      staleRejected = true;
    }
    if (!staleRejected) throw new Error("stale synthetic intent unexpectedly accepted");
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      source_version_binding: valid.source_version_binding,
      bound_intents_checked: valid.source_version_checks,
      stale_intent_rejected: staleRejected,
      claims_created: valid.claims_created,
      review_outcomes_written: valid.review_outcomes_written,
      real_import_enabled: valid.real_import_enabled,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
