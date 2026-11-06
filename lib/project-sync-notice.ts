import type { Entity } from "./db";

/** A pending-sync warning belongs to one locally committed project operation. */
export type ProjectSyncNotice =
  | { kind: "delete"; projectId: string; projectTitle?: string }
  | { kind: "status"; projectId: string; projectTitle?: string; status: string; updatedAt: number };

/** At most one outstanding warning per project; failures for other projects must survive. */
export type ProjectSyncNotices = Record<string, ProjectSyncNotice>;

/** The saved title is a display hint from the actor's own confirmed action, not ACL authority. */
export function projectSyncNoticeTitle(notice: ProjectSyncNotice): string {
  return notice.projectTitle?.trim() || notice.projectId;
}

export function withProjectSyncNotice(current: ProjectSyncNotices, warning: ProjectSyncNotice): ProjectSyncNotices {
  return { ...current, [warning.projectId]: warning };
}

export function withoutProjectSyncNotice(current: ProjectSyncNotices, projectId: string): ProjectSyncNotices {
  if (!Object.prototype.hasOwnProperty.call(current, projectId)) return current;
  const next = { ...current };
  delete next[projectId];
  return next;
}

/** Undo of B cannot erase another project's unsynchronized A. */
export function projectSyncNoticesAfterUndo(current: ProjectSyncNotices, projectId: string): ProjectSyncNotices {
  const warning = current[projectId];
  return warning?.kind === "delete" ? withoutProjectSyncNotice(current, projectId) : current;
}

/** Reconcile independent acknowledgements without removing newer in-flight warnings. */
export function withoutResolvedProjectSyncNotices(
  current: ProjectSyncNotices, resolved: ProjectSyncNotice[],
): ProjectSyncNotices {
  let next = current;
  for (const warning of resolved) {
    if (sameProjectSyncNotice(next[warning.projectId] ?? null, warning))
      next = withoutProjectSyncNotice(next, warning.projectId);
  }
  return next;
}

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
