// Deterministic zero-argument, zero-write interleaving rehearsal; fictional only.
import { makeSyntheticRestoreFixture } from "./restore-preflight.mjs";
import {
  bindSyntheticEpochFence,
  makeSyntheticEpochFenceFixture,
  rehearseSyntheticFenceWindow,
} from "./epoch-fence-rehearsal.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/epoch-fence-rehearsal-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const first = makeSyntheticEpochFenceFixture(makeSyntheticRestoreFixture(), 1);
    const binding = bindSyntheticEpochFence(first);
    const stable = rehearseSyntheticFenceWindow(first, first, binding);
    const sameDataNewEpoch = { ...first, toy_epoch: 2 };
    const aba = rehearseSyntheticFenceWindow(first, sameDataNewEpoch, binding);
    const staleBefore = rehearseSyntheticFenceWindow(sameDataNewEpoch, first, binding);
    const revokedWitness = {
      ...first,
      restore_state: { ...first.restore_state, witness: null },
    };
    const invalidWitness = rehearseSyntheticFenceWindow(first, revokedWitness, binding);
    const changedSnapshot = structuredClone(first);
    changedSnapshot.restore_state.snapshot = {
      applied_sequence: 1,
      applied_digest: first.restore_state.registry[0].digest,
    };
    const staleRestore = rehearseSyntheticFenceWindow(first, changedSnapshot, binding);
    if (stable.window_status !== "toy_checks_match_no_commit" ||
        aba.window_status !== "would_abort_at_final_check" ||
        staleBefore.window_status !== "would_abort_at_first_check" ||
        invalidWitness.window_status !== "would_abort_at_final_check" ||
        staleRestore.window_status !== "would_abort_at_final_check") {
      throw new Error("Fictional epoch fence rehearsal failed");
    }
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      unchanged_check_window: stable.window_status,
      same_data_changed_epoch_aba: aba.window_status,
      stale_first_check: staleBefore.window_status,
      witness_missing_at_final_check: invalidWitness.window_status,
      changed_snapshot_at_final_check: staleRestore.window_status,
      actual_compare_and_swap_performed: false,
      real_monotonic_epoch_authenticated: false,
      actual_witness_contacted: false,
      data_release_authorized: false,
      real_import_enabled: false,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
