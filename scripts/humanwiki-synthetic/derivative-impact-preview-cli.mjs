// Fixed fictional graph + restore state only; no user inputs or data stores.
import { makeSyntheticRestoreFixture } from "./restore-preflight.mjs";
import {
  makeSyntheticDerivativeFixture,
  previewSyntheticDerivativeImpact,
} from "./derivative-impact-preview.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/derivative-impact-preview-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const state = makeSyntheticRestoreFixture();
    const graph = makeSyntheticDerivativeFixture();
    const impacts = previewSyntheticDerivativeImpact(state, graph);
    const rollback = structuredClone(state);
    rollback.registry.pop();
    const blocked = previewSyntheticDerivativeImpact(rollback, graph);
    const incompleteGraph = structuredClone(graph);
    incompleteGraph.artifacts = incompleteGraph.artifacts.filter(
      artifact => artifact.id !== "fictional-link-a");
    const incomplete = previewSyntheticDerivativeImpact(state, incompleteGraph);
    const atWitness = previewSyntheticDerivativeImpact({
      ...state,
      snapshot: {
        applied_sequence: state.witness.sequence,
        applied_digest: state.witness.digest,
      },
    }, graph);
    if (impacts.impact_status !== "hypothetical_impacts_only" ||
        atWitness.impact_status !== "hypothetical_impacts_only" ||
        JSON.stringify(atWitness.claim_impacts) !== JSON.stringify(impacts.claim_impacts) ||
        blocked.impact_status !== "blocked" ||
        blocked.claim_impacts.length || blocked.artifact_impacts.length ||
        incomplete.reason !== "fictional_dependency_coverage_incomplete" ||
        incomplete.claim_impacts.length || incomplete.artifact_impacts.length) {
      throw new Error("Synthetic impact preview preflight mismatch");
    }
    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      claim_impacts: impacts.claim_impacts,
      artifact_impacts: impacts.artifact_impacts,
      blocked_rollback_reason: blocked.reason,
      blocked_disclosed_sources: blocked.source_specific_details_disclosed,
      incomplete_graph_reason: incomplete.reason,
      incomplete_graph_disclosed_sources: incomplete.source_specific_details_disclosed,
      fictional_fixture_manifest_matched: impacts.fictional_fixture_manifest_matched,
      production_dependency_coverage_verified: impacts.production_dependency_coverage_verified,
      witness_current_does_not_waive_revalidation: true,
      data_release_authorized: false,
      actual_deletions_performed: 0,
      actual_invalidation_performed: 0,
      actual_replay_performed: false,
      actual_witness_contacted: false,
      real_import_enabled: false,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
