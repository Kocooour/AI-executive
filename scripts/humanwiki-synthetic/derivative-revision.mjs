// Fictional data ONLY: bind a dry-run impact observation to a toy graph and
// restore-registry revision. SHA-256 is unkeyed and is NOT a security token.
// No persistence, external witness, authentic signature, AI or data release.
import { createHash } from "node:crypto";
import {
  makeSyntheticDerivativeFixture,
  previewSyntheticDerivativeImpact,
} from "./derivative-impact-preview.mjs";

const fail = detail => { throw new Error("Synthetic dependency revision: " + detail); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => createHash("sha256").update(value).digest("hex");
const hex = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const plain = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
   Object.getPrototypeOf(value) === null);
const exact = (value, names) => plain(value) &&
  Reflect.ownKeys(value).length === names.length &&
  names.every(key => Object.hasOwn(value, key));
const schema = "fictional_dependency_revision_v1";

// Only invoked AFTER the upstream preflight and fictional manifest pass.
// Explicit arrays encode all toy metadata, independent of graph/edge ordering.
function currentToyDigests(state, graph) {
  const preview = previewSyntheticDerivativeImpact(state, graph);
  if (preview.impact_status !== "hypothetical_impacts_only" ||
      !preview.fictional_fixture_manifest_matched) return null;

  const registry = state.registry.map(event => [
    event.sequence, event.opaque_source_id, event.action,
    event.previous_digest, event.digest,
  ]);
  const restore = [
    state.snapshot.applied_sequence, state.snapshot.applied_digest,
    state.witness.sequence, state.witness.digest,
    state.toy_key_available, state.toy_independent_witness_verified,
    registry,
  ];
  const claims = graph.claims.map(claim => [
    claim.id, [...claim.evidence].sort(compare),
  ]).sort((a, b) => compare(a[0], b[0]));
  const artifacts = graph.artifacts.map(artifact => [
    artifact.id, artifact.kind, [...artifact.depends_on].sort(compare),
  ]).sort((a, b) => compare(a[0], b[0]));
  return {
    toy_restore_digest: digest(JSON.stringify(["restore-v1", restore])),
    toy_graph_digest: digest(JSON.stringify(["graph-v1", claims, artifacts])),
  };
}

/**
 * Capture the exact *fictional* versions used in a read-only preview.
 * All inputs are checked through the existing toy preflight and coverage gate.
 * Returned raw hashes are NOT safe for real exports, identifiers, or logs.
 */
export function bindSyntheticDerivativeRevision(
  state, graph = makeSyntheticDerivativeFixture()
) {
  const current = currentToyDigests(state, graph);
  if (!current) fail("cannot bind blocked preflight or incomplete graph");
  return { schema, ...current };
}

const emptyReport = {
  synthetic_fixture_only: true,
  mode: "fictional_dependency_revision_recheck_only",
  graph_content_or_hash_disclosed: false,
  source_specific_details_disclosed: false,
  actual_witness_contacted: false,
  real_graph_revision_authenticated: false,
  actual_invalidation_performed: 0,
  actual_replay_performed: false,
  data_release_authorized: false,
  real_import_enabled: false,
};

/**
 * Re-evaluate the CURRENT fake state + graph synchronously, then compare with
 * the earlier digest-bearing toy binding. Never accept a cached "green" result.
 * "matched" only means consistent inputs in this untrusted offline lab.
 */
export function recheckSyntheticDerivativeRevision(
  state, graph = makeSyntheticDerivativeFixture(), binding
) {
  if (!exact(binding, ["schema", "toy_restore_digest", "toy_graph_digest"]) ||
      binding.schema !== schema ||
      !hex(binding.toy_restore_digest) || !hex(binding.toy_graph_digest)) {
    fail("malformed toy revision binding");
  }

  const current = currentToyDigests(state, graph);
  if (!current) {
    return {
      ...emptyReport,
      revision_status: "blocked_by_current_preflight_or_coverage",
      toy_binding_matches_current: false,
    };
  }
  const matches =
    current.toy_restore_digest === binding.toy_restore_digest &&
    current.toy_graph_digest === binding.toy_graph_digest;
  return {
    ...emptyReport,
    revision_status: matches ? "toy_revision_matches_no_release" : "stale_toy_revision_rejected",
    toy_binding_matches_current: matches,
  };
}
