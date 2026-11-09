// Read-only demonstration of recovering fictional registry metadata after restore.
// No arguments, real exports, files written, external witness, or production routes.
import { makeSyntheticRestoreFixture, previewSyntheticRestorePreflight } from "./restore-preflight.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/restore-preflight-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const state = makeSyntheticRestoreFixture();
    const oldSnapshot = previewSyntheticRestorePreflight(state);
    const rollback = structuredClone(state);
    rollback.registry = rollback.registry.slice(0, 1);
    const staleRegistry = previewSyntheticRestorePreflight(rollback);
    const witnessOffline = previewSyntheticRestorePreflight({ ...state, witness: null });
    const missingKey = previewSyntheticRestorePreflight({ ...state, toy_key_available: false });
    const current = previewSyntheticRestorePreflight({
      ...state,
      snapshot: { applied_sequence: state.witness.sequence, applied_digest: state.witness.digest },
    });
    if (oldSnapshot.preflight_status !== "requires_replay_and_revalidation" ||
        staleRegistry.reason !== "registry_behind_external_witness" ||
        witnessOffline.reason !== "witness_unavailable_or_invalid" ||
        missingKey.reason !== "key_unavailable" ||
        current.preflight_status !== "checks_passed_in_toy_only") {
      throw new Error("Synthetic restore preflight did not exercise expected gates");
    }
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      old_snapshot_status: oldSnapshot.preflight_status,
      toy_pending_replay_events: oldSnapshot.pending_replay_count,
      old_registry_rollback: staleRegistry.reason,
      missing_witness: witnessOffline.reason,
      missing_key: missingKey.reason,
      current_snapshot_status: current.preflight_status,
      data_release_authorized: false,
      actual_witness_contacted: false,
      actual_restore_applied: false,
      durable_events_written: 0,
      tombstones_written: 0,
      real_import_enabled: false,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
