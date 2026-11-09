// Fixture-only dependency impact rehearsal. No graph persistence, AI, source data,
// source ACL decision, materialized deletions, or release authorization.
import { previewSyntheticRestoreReplayPlan } from "./restore-replay-plan.mjs";

const fail = () => { throw new Error("Synthetic dependency impact: invalid fictional graph"); };
const plain = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, fields) => plain(value) &&
  Reflect.ownKeys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const allowedSources = new Set([
  "fictional-source-a", "fictional-source-b", "fictional-source-c",
]);
const allowedClaims = new Set([
  "fictional-claim-a", "fictional-claim-ac", "fictional-claim-ab",
  "fictional-claim-b", "fictional-claim-bc", "fictional-claim-c",
]);
const allowedArtifacts = new Map([
  ["fictional-search-a", "search_index"],
  ["fictional-cache-ac", "cache"],
  ["fictional-embedding-bc", "embedding"],
  ["fictional-summary-mixed", "ai_summary"],
  ["fictional-export-mixed", "export"],
  ["fictional-link-a", "source_link"],
  ["fictional-autocomplete-c", "autocomplete"],
  ["fictional-search-c", "search_index"],
  ["fictional-cache-b", "cache"],
  ["fictional-export-ab", "export"],
]);

/** Only hardcoded fictional source, claim and artifact identifiers; no personal text. */
export function makeSyntheticDerivativeFixture() {
  return {
    claims: [
      { id: "fictional-claim-a", evidence: ["fictional-source-a"] },
      { id: "fictional-claim-ac", evidence: ["fictional-source-a", "fictional-source-c"] },
      { id: "fictional-claim-ab", evidence: ["fictional-source-a", "fictional-source-b"] },
      { id: "fictional-claim-b", evidence: ["fictional-source-b"] },
      { id: "fictional-claim-bc", evidence: ["fictional-source-b", "fictional-source-c"] },
      { id: "fictional-claim-c", evidence: ["fictional-source-c"] },
    ],
    artifacts: [
      { id: "fictional-search-a", kind: "search_index", depends_on: ["fictional-claim-a"] },
      { id: "fictional-cache-ac", kind: "cache", depends_on: ["fictional-claim-ac"] },
      { id: "fictional-embedding-bc", kind: "embedding", depends_on: ["fictional-claim-bc"] },
      { id: "fictional-summary-mixed", kind: "ai_summary",
        depends_on: ["fictional-cache-ac", "fictional-embedding-bc"] },
      { id: "fictional-export-mixed", kind: "export", depends_on: ["fictional-summary-mixed"] },
      { id: "fictional-link-a", kind: "source_link", depends_on: ["fictional-claim-a"] },
      { id: "fictional-autocomplete-c", kind: "autocomplete", depends_on: ["fictional-claim-c"] },
      { id: "fictional-search-c", kind: "search_index", depends_on: ["fictional-claim-c"] },
      { id: "fictional-cache-b", kind: "cache", depends_on: ["fictional-claim-b"] },
      { id: "fictional-export-ab", kind: "export", depends_on: ["fictional-claim-ab"] },
    ],
  };
}

function validatedGraph(graph) {
  if (!exact(graph, ["claims", "artifacts"]) ||
      !Array.isArray(graph.claims) || graph.claims.length > allowedClaims.size ||
      !Array.isArray(graph.artifacts) || graph.artifacts.length > allowedArtifacts.size) fail();
  const claims = new Map();
  for (const claim of graph.claims) {
    if (!exact(claim, ["id", "evidence"]) ||
        typeof claim.id !== "string" || !allowedClaims.has(claim.id) ||
        claims.has(claim.id) ||
        !Array.isArray(claim.evidence) || claim.evidence.length < 1 ||
        claim.evidence.length > allowedSources.size ||
        claim.evidence.some(id => typeof id !== "string" || !allowedSources.has(id)) ||
        new Set(claim.evidence).size !== claim.evidence.length) fail();
    claims.set(claim.id, { id: claim.id, evidence: [...claim.evidence].sort(compare) });
  }
  const artifacts = new Map();
  for (const artifact of graph.artifacts) {
    if (!exact(artifact, ["id", "kind", "depends_on"]) ||
        typeof artifact.id !== "string" || !allowedArtifacts.has(artifact.id) ||
        typeof artifact.kind !== "string" || artifact.kind !== allowedArtifacts.get(artifact.id) ||
        artifacts.has(artifact.id) ||
        !Array.isArray(artifact.depends_on) || artifact.depends_on.length < 1 ||
        artifact.depends_on.length > allowedClaims.size + allowedArtifacts.size ||
        artifact.depends_on.some(id => typeof id !== "string") ||
        new Set(artifact.depends_on).size !== artifact.depends_on.length) fail();
    artifacts.set(artifact.id, {
      id: artifact.id, kind: artifact.kind, depends_on: [...artifact.depends_on].sort(compare),
    });
  }
  for (const artifact of artifacts.values()) {
    if (artifact.depends_on.some(id => !claims.has(id) && !artifacts.has(id))) fail();
  }
  // Detect cycles in *every* artifact, not only those reached by impacted claims.
  const visited = new Set(), active = new Set();
  const visit = id => {
    if (claims.has(id) || visited.has(id)) return;
    if (active.has(id) || !artifacts.has(id)) fail();
    active.add(id);
    for (const dep of artifacts.get(id).depends_on) visit(dep);
    active.delete(id);
    visited.add(id);
  };
  for (const id of artifacts.keys()) visit(id);
  return { claims, artifacts };
}

// An independent, fixed EXPECTED toy inventory: allowlists above reject arbitrary
// IDs, while this manifest also rejects silently missing/repointed known edges.
// It is NOT authenticated provenance nor a complete inventory of real data.
const expectedClaimEvidence = new Map([
  ["fictional-claim-a", ["fictional-source-a"]],
  ["fictional-claim-ac", ["fictional-source-a", "fictional-source-c"]],
  ["fictional-claim-ab", ["fictional-source-a", "fictional-source-b"]],
  ["fictional-claim-b", ["fictional-source-b"]],
  ["fictional-claim-bc", ["fictional-source-b", "fictional-source-c"]],
  ["fictional-claim-c", ["fictional-source-c"]],
]);
const expectedArtifactDependencies = new Map([
  ["fictional-search-a", ["fictional-claim-a"]],
  ["fictional-cache-ac", ["fictional-claim-ac"]],
  ["fictional-embedding-bc", ["fictional-claim-bc"]],
  ["fictional-summary-mixed", ["fictional-cache-ac", "fictional-embedding-bc"]],
  ["fictional-export-mixed", ["fictional-summary-mixed"]],
  ["fictional-link-a", ["fictional-claim-a"]],
  ["fictional-autocomplete-c", ["fictional-claim-c"]],
  ["fictional-search-c", ["fictional-claim-c"]],
  ["fictional-cache-b", ["fictional-claim-b"]],
  ["fictional-export-ab", ["fictional-claim-ab"]],
]);
const sameEdges = (actual, expected) =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);
function hasCompleteToyCoverage(claims, artifacts) {
  if (claims.size !== expectedClaimEvidence.size ||
      artifacts.size !== expectedArtifactDependencies.size) return false;
  for (const [id, expected] of expectedClaimEvidence) {
    const claim = claims.get(id);
    if (!claim || !sameEdges(claim.evidence, [...expected].sort(compare))) return false;
  }
  for (const [id, expected] of expectedArtifactDependencies) {
    const artifact = artifacts.get(id);
    if (!artifact || !sameEdges(artifact.depends_on, [...expected].sort(compare))) return false;
  }
  return true;
}
const emptyReport = {
  synthetic_fixture_only: true,
  mode: "fictional_derivative_dependency_impact_only",
  production_dependency_coverage_verified: false,
  data_release_authorized: false,
  independently_authorized_evidence_proven: false,
  actual_deletions_performed: 0,
  actual_invalidation_performed: 0,
  actual_replay_performed: false,
  actual_witness_contacted: false,
  claims_created: 0,
  real_import_enabled: false,
};

/**
 * Analyze fictional links after rechecking the toy recovery preflight.
 * Uses ALL witnessed toy registry events even if the snapshot says applied:
 * apparent checkpoint completion must never bypass revalidation.
 */
export function previewSyntheticDerivativeImpact(restoreState, graph = makeSyntheticDerivativeFixture()) {
  const recovery = previewSyntheticRestoreReplayPlan(restoreState);
  if (recovery.plan_status === "blocked") {
    return {
      ...emptyReport,
      impact_status: "blocked",
      reason: recovery.reason,
      claim_impacts: [],
      artifact_impacts: [],
      source_specific_details_disclosed: false,
      fictional_fixture_manifest_matched: false,
    };
  }

  const { claims, artifacts } = validatedGraph(graph);
  if (!hasCompleteToyCoverage(claims, artifacts)) {
    return {
      ...emptyReport,
      impact_status: "blocked",
      reason: "fictional_dependency_coverage_incomplete",
      claim_impacts: [],
      artifact_impacts: [],
      source_specific_details_disclosed: false,
      fictional_fixture_manifest_matched: false,
    };
  }
  const erased = new Set(restoreState.registry
    .filter(event => event.action === "request_erasure")
    .map(event => event.opaque_source_id));
  const revoked = new Set(restoreState.registry
    .filter(event => event.action === "revoke_import_consent")
    .map(event => event.opaque_source_id));
  const claimImpacts = [...claims.values()].sort((a, b) => compare(a.id, b.id)).map(claim => {
    const erasedEvidence = claim.evidence.filter(id => erased.has(id));
    const revokedEvidence = claim.evidence.filter(id => !erased.has(id) && revoked.has(id));
    const unaffectedCandidates = claim.evidence.filter(id => !erased.has(id) && !revoked.has(id));
    let disposition = "unchanged_source_but_global_revalidation_required";
    if (erasedEvidence.length && !claim.evidence.some(id => !erased.has(id))) {
      disposition = "would_remove_exclusively_erased_claim";
    } else if (erasedEvidence.length) {
      disposition = "would_prune_erased_evidence_and_revalidate_all_remaining";
    } else if (revokedEvidence.length) {
      disposition = "would_hold_for_retention_and_consent_review";
    }
    return {
      claim_id: claim.id,
      disposition,
      erased_source_references: erasedEvidence,
      revoked_source_references: revokedEvidence,
      unaffected_source_candidates: unaffectedCandidates,
      independently_authorized_evidence_proven: false,
      would_invalidate_dependent_artifacts: erasedEvidence.length + revokedEvidence.length > 0,
      completed: false,
    };
  });
  const impacted = new Map(claimImpacts.map(item =>
    [item.claim_id, item.would_invalidate_dependent_artifacts]));
  const visit = id => {
    if (impacted.has(id)) return impacted.get(id);
    const artifact = artifacts.get(id);
    const affected = artifact.depends_on.some(visit);
    impacted.set(id, affected);
    return affected;
  };
  const artifactImpacts = [...artifacts.values()].sort((a, b) => compare(a.id, b.id))
    .map(artifact => ({
      artifact_id: artifact.id,
      kind: artifact.kind,
      dependency_ids: artifact.depends_on,
      would_invalidate: visit(artifact.id),
      must_revalidate_before_any_release: true,
      invalidation_completed: false,
      served: false,
    }));
  return {
    ...emptyReport,
    impact_status: "hypothetical_impacts_only",
    fictional_fixture_manifest_matched: true,
    reason: null,
    claim_impacts: claimImpacts,
    artifact_impacts: artifactImpacts,
    source_specific_details_disclosed: claimImpacts.length + artifactImpacts.length > 0,
  };
}
