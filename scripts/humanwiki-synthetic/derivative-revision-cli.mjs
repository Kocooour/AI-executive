// Zero-argument, zero-write revision binding demonstration on fictional fixtures.
import { makeSyntheticRestoreFixture } from "./restore-preflight.mjs";
import { makeSyntheticDerivativeFixture } from "./derivative-impact-preview.mjs";
import {
  bindSyntheticDerivativeRevision,
  recheckSyntheticDerivativeRevision,
} from "./derivative-revision.mjs";

if (process.argv.length !== 2) {
  console.error("Usage: node scripts/humanwiki-synthetic/derivative-revision-cli.mjs");
  process.exitCode = 2;
} else {
  try {
    const state = makeSyntheticRestoreFixture();
    const graph = makeSyntheticDerivativeFixture();
    const bound = bindSyntheticDerivativeRevision(state, graph);
    const identical = recheckSyntheticDerivativeRevision(state, graph, bound);

    const reordered = structuredClone(graph);
    reordered.claims.reverse();
    reordered.artifacts.reverse();
    reordered.claims.forEach(claim => claim.evidence.reverse());
    reordered.artifacts.forEach(artifact => artifact.depends_on.reverse());
    const sameGraph = recheckSyntheticDerivativeRevision(state, reordered, bound);

    const advancedCursor = structuredClone(state);
    advancedCursor.snapshot = {
      applied_sequence: 1,
      applied_digest: advancedCursor.registry[0].digest,
    };
    const changedSnapshot = recheckSyntheticDerivativeRevision(advancedCursor, graph, bound);

    const changedGraph = structuredClone(graph);
    changedGraph.artifacts = changedGraph.artifacts.filter(
      artifact => artifact.id !== "fictional-link-a");
    const incomplete = recheckSyntheticDerivativeRevision(state, changedGraph, bound);
    const noWitness = recheckSyntheticDerivativeRevision({
      ...state, witness: null,
    }, graph, bound);

    if (identical.revision_status !== "toy_revision_matches_no_release" ||
        sameGraph.revision_status !== "toy_revision_matches_no_release" ||
        changedSnapshot.revision_status !== "stale_toy_revision_rejected" ||
        incomplete.revision_status !== "blocked_by_current_preflight_or_coverage" ||
        noWitness.revision_status !== "blocked_by_current_preflight_or_coverage") {
      throw new Error("Synthetic dependency revision check failed");
    }

    console.log(JSON.stringify({
      synthetic_fixture_only: true,
      unchanged_revision: identical.revision_status,
      reordered_graph: sameGraph.revision_status,
      changed_snapshot: changedSnapshot.revision_status,
      incomplete_graph: incomplete.revision_status,
      missing_witness: noWitness.revision_status,
      toy_binding_digest_served: false,
      data_release_authorized: false,
      real_graph_revision_authenticated: false,
      actual_witness_contacted: false,
      actual_invalidation_performed: 0,
      actual_replay_performed: false,
      real_import_enabled: false,
    }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
