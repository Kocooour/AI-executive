// Deterministic zero-argument, zero-write interleaving rehearsal; fictional only.
import { makeSyntheticRestoreFixture } from "./restore-preflight.mjs";
import {
  bindSyntheticEpochFence,
  makeSyntheticEpochFenceFixture,
  recheckSyntheticEpochFence,
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
    // A(epoch 1) → B(epoch 2, genuinely different but valid data)
    // → A(epoch 3, ORIGINAL data restored). Both input states stay fictional.
    const intermediateB = structuredClone(first);
    intermediateB.toy_epoch = 2;
    intermediateB.restore_state.snapshot = {
      applied_sequence: 1,
      applied_digest: first.restore_state.registry[0].digest,
    };
    const bBinding = bindSyntheticEpochFence(intermediateB);
    const bValidated = recheckSyntheticEpochFence(intermediateB, bBinding);
    const staleAtB = recheckSyntheticEpochFence(intermediateB, binding);
    const returnedA = structuredClone(first);
    returnedA.toy_epoch = 3;
    const aba = rehearseSyntheticFenceWindow(first, returnedA, binding);
    // Deliberately roll back the UNTRUSTED epoch as well: this false match
    // demonstrates the limit of the lab, NEVER a safe authorization.
    const rolledBackEpoch = structuredClone(first);
    const undetectedRollback = rehearseSyntheticFenceWindow(
      first, rolledBackEpoch, binding,
    );
    const staleBefore = rehearseSyntheticFenceWindow(intermediateB, first, binding);
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
        bValidated.fence_status !== "toy_fence_matches_no_release" ||
        staleAtB.fence_status !== "stale_toy_epoch_or_revision" ||
        JSON.stringify(intermediateB.restore_state) === JSON.stringify(first.restore_state) ||
        JSON.stringify(returnedA.restore_state) !== JSON.stringify(first.restore_state) ||
        JSON.stringify(returnedA.graph) !== JSON.stringify(first.graph) ||
        !(first.toy_epoch < intermediateB.toy_epoch &&
          intermediateB.toy_epoch < returnedA.toy_epoch) ||
        aba.window_status !== "would_abort_at_final_check" ||
        undetectedRollback.window_status !== "toy_checks_match_no_commit" ||
        staleBefore.window_status !== "would_abort_at_first_check" ||
        invalidWitness.window_status !== "would_abort_at_final_check" ||
        staleRestore.window_status !== "would_abort_at_final_check") {
      throw new Error("Fictional epoch fence rehearsal failed");
    }
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      unchanged_check_window: stable.window_status,
      aba_intermediate_b_validated: bValidated.fence_status,
      aba_original_binding_stale_at_b: staleAtB.fence_status,
      aba_a_to_b_to_a_with_advanced_epoch: aba.window_status,
      aba_epoch_rollback_undetectable_in_toy: undetectedRollback.window_status,
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
