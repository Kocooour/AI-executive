import type { Entity } from "./db";

/** A pending-sync warning belongs to one locally committed project operation. */
export type ProjectSyncNotice =
  | { kind: "delete"; projectId: string }
  | { kind: "status"; projectId: string; status: string; updatedAt: number };

/** Prevent stale asynchronous reconciliation from clearing a newer warning. */
export function sameProjectSyncNotice(a: ProjectSyncNotice | null, b: ProjectSyncNotice): boolean {
  return a !== null && a.kind === b.kind && a.projectId === b.projectId &&
    (a.kind !== "status" || (b.kind === "status" && a.status === b.status && a.updatedAt === b.updatedAt));
}

/** Undo makes a local deletion warning obsolete without claiming the restore was synced. */
export function projectSyncNoticeAfterUndo(notice: ProjectSyncNotice | null, projectId: string): ProjectSyncNotice | null {
  return notice?.kind === "delete" && notice.projectId === projectId ? null : notice;
}

/** Only server-acknowledged base data and consumed delete markers prove sync. */
export function projectSyncNoticeResolved(
  notice: ProjectSyncNotice,
  local: Pick<Entity, "id" | "type" | "status" | "updatedAt"> | undefined,
  base: Pick<Entity, "id" | "type" | "status" | "updatedAt"> | undefined,
  pendingDeletion: boolean,
): boolean {
  if (notice.kind === "delete") {
    // A restored record supersedes the deletion (even if that restore is offline).
    if (local) return true;
    return !pendingDeletion && !base;
  }
  if (!local) return true; // A later local deletion supersedes the old status warning.
  if (!base || base.id !== notice.projectId || base.type !== "project") return false;
  if (base.status === notice.status && base.updatedAt >= notice.updatedAt) return true;
  // A newer status has been synchronized: the old pending operation no longer applies.
  return base.status === local.status && base.updatedAt >= local.updatedAt;
}
