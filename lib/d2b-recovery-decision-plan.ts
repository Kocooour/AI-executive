// D2b part 6 — an IN-MEMORY preference draft, not an executable restore plan.
// A v1 rescue SHA proves neither identity nor membership, and area partition/ACL
// are not active. Keep the recovery hold intact even for zero local changes.
// PRIVATE IDs are present in this return value. Never log, persist, transmit,
// add to a URL, or send this plan to an AI provider.
import type { OfflineRecoveryHold } from "./d2b-recovery-hold";
import { decodeOfflineRecoveryFile, type OfflineRecoveryServer } from "./d2b-offline-recovery-file";
import {
  OfflineRecoveryInvalid, type OfflineRecoveryAssessment, type OfflineChange,
} from "./d2b-offline-reconciliation";
import { assertOfflineRecoveryBundleMatchesHold } from "./d2b-recovery-review";
import type { Entity } from "./db";

export type RecoveryPreference = "defer" | "prefer-local" | "prefer-server";
export type RecoveryReason = OfflineRecoveryAssessment["candidates"][number]["reason"];
export type RecoveryCandidate = Readonly<{
  id: string;
  kind: "entity" | "relation";
  reason: RecoveryReason;
  preference: RecoveryPreference;
  availablePreferences: readonly RecoveryPreference[];
}>;

// These fields are permanently conservative in D2b/6. No client-supplied
// Boolean, checksum, snapshot generation or user click can turn them into ACL.
export type OfflineRecoveryDecisionPlan = Readonly<{
  phase: "local-preferences-only";
  identity: "unverified";
  membership: "unverified";
  areaPermission: "unverified";
  consent: "not-requested";
  automaticReplayAllowed: false;
  canApply: false;
  canReleaseHold: false;
  sourceSha256: string; // integrity only; not a signed authority token
  serverGeneration: number;
  serverRevision: number; // diagnostic snapshot only; can become stale
  counts: OfflineRecoveryAssessment["counts"];
  candidates: readonly RecoveryCandidate[];
  unresolvedNonRecordWork: boolean;
}>;

const HOLD: readonly RecoveryPreference[] = Object.freeze(["defer"]);
const ALREADY: readonly RecoveryPreference[] = Object.freeze(["defer", "prefer-server"]);
const EDITED: readonly RecoveryPreference[] = Object.freeze(["defer", "prefer-local", "prefer-server"]);

/** An issued draft is a volatile capability for editing *preferences only*.
 * Object identity plus deep freezing of the plan's mutable surface prevents
 * callers from reclassifying a collision by cloning/editing the plan.
 * This is NOT a credential, ACL proof or permission to execute a recovery.
 */
const issuedPlans = new WeakSet<OfflineRecoveryDecisionPlan>();

function issuePlan(plan: OfflineRecoveryDecisionPlan): OfflineRecoveryDecisionPlan {
  Object.freeze(plan.counts);
  for (const candidate of plan.candidates) Object.freeze(candidate);
  Object.freeze(plan.candidates);
  Object.freeze(plan);
  issuedPlans.add(plan);
  return plan;
}

/** Without a proven Area membership map, changes to scopes/relationships
 * remain deferred, including reassignment within the SAME workspace.
 * Even text edits are deferred if the server changed the stored scope in
 * parallel. Other preferences are provisional and never executable.
 */
function needsScopeReview(change: OfflineChange<Entity>, remote?: Entity): boolean {
  const { before, after } = change;
  if (!before || !after || !remote) return true;
  if (before.type !== after.type || before.type !== remote.type) return true;
  if (before.type !== "task" && before.type !== "note") return true;
  if (before.workspaceId !== after.workspaceId || before.workspaceId !== remote.workspaceId) return true;
  if (!before.properties || !after.properties || !remote.properties) return true;
  return (["projectId", "areaId"] as const).some((key) =>
    !Object.is(before.properties[key], after.properties[key]) ||
    !Object.is(before.properties[key], remote.properties[key]));
}


function optionsFor(reason: RecoveryReason): readonly RecoveryPreference[] {
  switch (reason) {
    // A collision or workspace move cannot be solved by picking a value.
    // It needs ID mapping / Area boundary / ownership review first.
    case "id-collision":
    case "workspace-changed":
      return HOLD;
    case "already-present":
    case "already-deleted":
      return ALREADY;
    case "remote-missing":
    case "remote-diverged":
    case "local-change":
      return EDITED;
    default:
      // Exhaustiveness at compile time, and fail closed at runtime.
      throw new OfflineRecoveryInvalid();
  }
}

/**
 * Must be called only with the CURRENT authenticated store GET from the same
 * owner browser session, never from untrusted storage or an external service.
 * This function itself cannot authenticate the actor, verify membership or
 * make an Area ACL decision; those server-issued proofs do not exist yet.
 * Every output is provisional, and no output may be submitted as a write.
 */
export function draftOfflineRecoveryDecisions(
  bytes: Uint8Array,
  server: OfflineRecoveryServer & { revision: number },
  hold: OfflineRecoveryHold,
): OfflineRecoveryDecisionPlan {
  if (!server || !Number.isSafeInteger(server.revision) || server.revision < 0)
    throw new OfflineRecoveryInvalid();
  const { bundle, assessment } = decodeOfflineRecoveryFile(bytes, server);
  assertOfflineRecoveryBundleMatchesHold(bundle, hold);
  const c = assessment.counts;
  const remoteEntities = new Map(server.entities.map((entity) => [entity.id, entity]));
  const scopeAffectedIds = new Set<string>();
  // A changed edge may change effective Area without touching the entity.
  // Hold all relation decisions and their directly referenced entities.
  for (const change of bundle.changes.relations) {
    for (const edge of [change.before, change.after]) {
      if (edge) {
        scopeAffectedIds.add(edge.sourceEntityId);
        scopeAffectedIds.add(edge.targetEntityId);
      }
    }
  }
  const candidates = assessment.candidates.map((candidate, index) => {
    const change = candidate.kind === "entity"
      ? bundle.changes.entities[index]
      : bundle.changes.relations[index - bundle.changes.entities.length];
    if (!change || change.id !== candidate.id) throw new OfflineRecoveryInvalid();
    const requiresReview = candidate.kind === "relation" ||
      scopeAffectedIds.has(candidate.id) ||
      needsScopeReview(change as OfflineChange<Entity>, remoteEntities.get(candidate.id));
    return {
      id: candidate.id,
      kind: candidate.kind,
      reason: candidate.reason,
      preference: "defer" as const,
      availablePreferences: requiresReview ? HOLD : optionsFor(candidate.reason),
    };
  });
  return issuePlan({
    phase: "local-preferences-only",
    identity: "unverified",
    membership: "unverified",
    areaPermission: "unverified",
    consent: "not-requested",
    automaticReplayAllowed: false,
    canApply: false,
    canReleaseHold: false,
    sourceSha256: bundle.contentSha256,
    serverGeneration: server.restoreGeneration,
    serverRevision: server.revision,
    counts: { ...c },
    candidates,
    unresolvedNonRecordWork: c.deletions > 0 || c.revivals > 0 || c.drafts > 0 ||
      bundle.changes.pendingSync,
  });
}

/**
 * In-memory, non-authoritative expression of a preference, NOT owner consent.
 * Calling it never modifies any record, rescue file, hold or server state.
 * Explicit confirmation and fresh server ACL checks belong to a future step.
 */
export function preferOfflineRecoveryOutcome(
  plan: OfflineRecoveryDecisionPlan,
  kind: RecoveryCandidate["kind"],
  id: string,
  preference: RecoveryPreference,
): OfflineRecoveryDecisionPlan {
  if (!plan || !issuedPlans.has(plan) || plan.phase !== "local-preferences-only" || plan.canApply !== false ||
      plan.canReleaseHold !== false || plan.automaticReplayAllowed !== false ||
      plan.identity !== "unverified" || plan.membership !== "unverified" ||
      plan.areaPermission !== "unverified" || plan.consent !== "not-requested" ||
      !Array.isArray(plan.candidates)) throw new OfflineRecoveryInvalid();
  let found = 0;
  const candidates = plan.candidates.map((item) => {
    if (item.id !== id || item.kind !== kind) return item;
    found++;
    // Only the frozen options derived from the validated bundle are permitted.
    if (!item.availablePreferences.includes(preference))
      throw new OfflineRecoveryInvalid();
    return { ...item, preference };
  });
  if (found !== 1) throw new OfflineRecoveryInvalid();
  return issuePlan({ ...plan, candidates });
}
