// Read-only inspection of a privately selected D2b recovery file.
// NEVER replay, upload, cache or log the file. Even "no-local-changes" is
// diagnostic only: membership, Area ACL and owner consent remain unresolved.
import { decodeOfflineRecoveryFile, type OfflineRecoveryServer } from "./d2b-offline-recovery-file";
import { OfflineRecoveryInvalid, type OfflineRecoveryAssessment } from "./d2b-offline-reconciliation";
import type { OfflineRecoveryHold } from "./d2b-recovery-hold";

export type OfflineRecoveryReason = OfflineRecoveryAssessment["candidates"][number]["reason"];
export type OfflineRecoveryReviewSummary = Readonly<{
  status: OfflineRecoveryAssessment["status"];
  autoResumeAllowed: false;
  requiresSeparateMembershipReview: true;
  serverGeneration: number;
  counts: OfflineRecoveryAssessment["counts"];
  totalCandidates: number;
  reasons: Record<OfflineRecoveryReason, number>;
}>;

export function inspectOfflineRecoveryBytes(
  bytes: Uint8Array, server: OfflineRecoveryServer, hold: OfflineRecoveryHold,
): OfflineRecoveryReviewSummary {
  // Full v1 schema, hash, size and generation validation must precede any
  // diagnostic. Only aggregate counts leave this function, never record IDs.
  // v1 bundles do not carry a signed hold identity. Refuse any file whose
  // generation and creation time cannot belong to the currently active hold.
  // This is a consistency check, NOT proof of file authenticity or ownership.
  if (!hold || hold.version !== 1 ||
      !(hold.knownGeneration === null || (Number.isSafeInteger(hold.knownGeneration) && hold.knownGeneration >= 0)) ||
      !Number.isSafeInteger(hold.observedGeneration) || hold.observedGeneration < 0 ||
      !Number.isSafeInteger(hold.createdAt) || hold.createdAt < 0) throw new OfflineRecoveryInvalid();
  const { bundle, assessment } = decodeOfflineRecoveryFile(bytes, server);
  if (bundle.oldRestoreGeneration !== (hold.knownGeneration ?? 0) ||
      bundle.observedRestoreGeneration < hold.observedGeneration ||
      bundle.createdAt < hold.createdAt) throw new OfflineRecoveryInvalid();
  const reasons: Record<OfflineRecoveryReason, number> = {
    "remote-missing": 0, "workspace-changed": 0, "remote-diverged": 0,
    "local-change": 0, "already-present": 0, "id-collision": 0,
    "already-deleted": 0,
  };
  for (const item of assessment.candidates) reasons[item.reason] += 1;
  return {
    status: assessment.status,
    autoResumeAllowed: false,
    requiresSeparateMembershipReview: true,
    serverGeneration: server.restoreGeneration,
    counts: { ...assessment.counts },
    totalCandidates: assessment.candidates.length,
    reasons,
  };
}
