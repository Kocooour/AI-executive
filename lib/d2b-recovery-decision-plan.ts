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

const HOLD: readonly RecoveryPreference[] = Object.freeze(["defer"]);
const ALREADY: readonly RecoveryPreference[] = Object.freeze(["defer", "prefer-server"]);
const EDITED: readonly RecoveryPreference[] = Object.freeze(["defer", "prefer-local", "prefer-server"]);

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
  return {
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
    candidates: assessment.candidates.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      reason: candidate.reason,
      preference: "defer" as const,
      availablePreferences: optionsFor(candidate.reason),
    })),
    unresolvedNonRecordWork: c.deletions > 0 || c.revivals > 0 || c.drafts > 0 ||
      bundle.changes.pendingSync,
  };
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
  if (!plan || plan.phase !== "local-preferences-only" || plan.canApply !== false ||
      plan.canReleaseHold !== false || plan.automaticReplayAllowed !== false ||
      plan.identity !== "unverified" || plan.membership !== "unverified" ||
      plan.areaPermission !== "unverified" || plan.consent !== "not-requested" ||
      !Array.isArray(plan.candidates)) throw new OfflineRecoveryInvalid();
  let found = 0;
  const candidates = plan.candidates.map((item) => {
    if (item.id !== id || item.kind !== kind) return item;
    found++;
    // Do not trust a tampered plan to expand the permitted actions.
    if (!optionsFor(item.reason).includes(preference))
      throw new OfflineRecoveryInvalid();
    return { ...item, preference };
  });
  if (found !== 1) throw new OfflineRecoveryInvalid();
  return { ...plan, candidates };
}
