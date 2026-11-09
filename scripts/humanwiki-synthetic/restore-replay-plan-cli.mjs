// Fixed nonpersonal fixture. Outputs dry-run obligations, never executes replay.
import { makeSyntheticRestoreFixture } from "./restore-preflight.mjs";
import { previewSyntheticRestoreReplayPlan } from "./restore-replay-plan.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/restore-replay-plan-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const fixture = makeSyntheticRestoreFixture();
    const pending = previewSyntheticRestoreReplayPlan(fixture);
    const rollback = structuredClone(fixture);
    rollback.registry.pop();
    const blocked = previewSyntheticRestoreReplayPlan(rollback);
    const reconciled = previewSyntheticRestoreReplayPlan({
      ...fixture,
      snapshot: {
        applied_sequence: fixture.witness.sequence,
        applied_digest: fixture.witness.digest,
      },
    });
    if (pending.plan_status !== "requires_hypothetical_replay" ||
        pending.pending_events_to_reconcile !== 2 ||
        blocked.plan_status !== "blocked" ||
        blocked.event_obligations.length !== 0 ||
        reconciled.plan_status !== "preflight_passed_revalidation_still_required") {
      throw new Error("Synthetic replay obligations smoke check failed");
    }
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      pending_replay_obligations: pending.event_obligations,
      blocked_rollback_reason: blocked.reason,
      blocked_reveals_event_details: blocked.source_specific_work_disclosed,
      matched_snapshot_still_requires_revalidation: !reconciled.all_release_gates_satisfied,
      global_release_gates: pending.global_release_gates,
      data_release_authorized: false,
      replay_completed: false,
      actual_witness_contacted: false,
      durable_events_written: 0,
      tombstones_written: 0,
      real_import_enabled: false,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
