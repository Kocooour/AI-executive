// D2b part 6 — an IN-MEMORY preference draft, not an executable restore plan.
// A v1 rescue SHA proves neither identity nor membership, and area partition/ACL
// are not active. Keep the recovery hold intact even for zero local changes.
// PRIVATE IDs are present in this return value. Never log, persist, transmit,
// add to a URL, or send this plan to an AI provider.
import type { OfflineRecoveryHold } from "./d2b-recovery-hold";
import { decodeOfflineRecoveryFile, type OfflineRecoveryServer } from "./d2b-offline-recovery-file";
import {
  OfflineRecoveryInvalid, type OfflineRecoveryAssessment,
} from "./d2b-offline-reconciliation";
import { assertOfflineRecoveryBundleMatchesHold } from "./d2b-recovery-review";

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

// v1 rescue files contain ONLY changed records and changed relations. Even if
// a task's projectId and areaId are unchanged, an unchanged belongs_to_project
// link can make it inherit the Area of a project whose belongs_to_area link
// changed locally or only on the server. Neither the old full relationship
// graph nor authoritative Area/membership evidence is available here.
//
// Therefore NO v1 candidate may express prefer-local/prefer-server yet.
// Adding selective preferences requires a versioned, authenticated *complete*
// before/after scope witness, with inherited Area and relation comparisons.
// This explicitly sacrifices convenience to avoid a misleading ACL-sensitive
// draft. It does not discard the export, permit execution or release the hold.
const HOLD: readonly RecoveryPreference[] = Object.freeze(["defer"]);

const issuedPlans = new WeakSet<OfflineRecoveryDecisionPlan>();

/** Freeze the private preference draft and refuse any caller-edited clone. */
function issuePlan(plan: OfflineRecoveryDecisionPlan): OfflineRecoveryDecisionPlan {
  Object.freeze(plan.counts);
  for (const candidate of plan.candidates) Object.freeze(candidate);
  Object.freeze(plan.candidates);
  Object.freeze(plan);
  issuedPlans.add(plan);
  return plan;
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
  // No known-complete pre-restore relation graph is present in v1. A changed
  // project/Area relationship can affect ANY task/note (including an unchanged
  // membership edge removed by a server-only move). Fail closed for all items.
  const candidates = assessment.candidates.map((candidate) => ({
    id: candidate.id,
    kind: candidate.kind,
    reason: candidate.reason,
    preference: "defer" as const,
    availablePreferences: HOLD,
  }));
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
    // Only options from the frozen, issued plan are permitted; v1 is defer-only.
    if (!item.availablePreferences.includes(preference))
      throw new OfflineRecoveryInvalid();
    return { ...item, preference };
  });
  if (found !== 1) throw new OfflineRecoveryInvalid();
  return issuePlan({ ...plan, candidates });
}
