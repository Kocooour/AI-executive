// Fixed fictional fixture lifecycle comparison; no arguments or data writes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { previewSyntheticSourceLifecycle } from "./lifecycle-preview.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/lifecycle-preview-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const paths = ["chatgpt", "claude"].map(name =>
      fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)));
    const bundles = await Promise.all(paths.map(async path =>
      JSON.parse(await readFile(path, "utf8"))));
    const first = previewSyntheticSourceLifecycle(bundles).source_states[0].source_id;
    const actions = [
      "pause_sync", "disconnect_source", "revoke_import_consent", "request_erasure",
    ];
    const scenarios = actions.map(action => {
      const report = previewSyntheticSourceLifecycle(bundles, [
        { source_id: first, action },
      ]);
      const selected = report.source_states.find(item => item.source_id === first);
      return {
        action,
        would_allow_new_source_reads: selected.would_allow_new_source_reads,
        would_allow_pending_review: selected.would_allow_pending_review,
        would_invalidate_source_derivatives: selected.would_invalidate_source_derivatives,
        retention_recheck_required: selected.retention_recheck_required,
        independent_witness_required: selected.independent_witness_required,
        operation_completed: selected.operation_completed,
        visible_segments: selected.visible_segments,
        suppressed_segments: selected.suppressed_segments,
      };
    });
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      source_id: first,
      scenarios,
      actual_source_reads_performed: 0,
      durable_lifecycle_events_written: 0,
      tombstones_written: 0,
      real_import_enabled: false,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
