/**
 * R2 staging-only policy probe for a *future* single-task title mutation.
 *
 * This module never writes to a database. A positive answer is valid only for
 * the currently pinned, preflighted SQLite snapshot. A future write command
 * MUST repeat identity, ACL, schema, generation and revision checks atomically
 * inside its own write transaction; do not trust this preview as a capability.
 */
import { DatabaseSync } from "node:sqlite";

export interface TargetTaskTitleEditPreviewRequest {
  readonly taskId: string;
  /** SHA-256 fingerprint returned by a prior successful preview. */
  readonly expectedRevision?: string;
}

export type TargetTaskTitleEditPreviewResult =
  | { ok: true; snapshotRevision: string }
  | { ok: false;
      reason: "unauthorized" | "unavailable" | "invalid_request" | "stale_revision";
      snapshotRevision: null };

const REVISION = /^[a-f0-9]{64}$/;

export function validTargetTaskTitleEditPreviewRequest(
  value: unknown,
): value is TargetTaskTitleEditPreviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      "actorUserId" in value || "scope" in value || "areaId" in value ||
      "workspaceId" in value) return false;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => key !== "taskId" && key !== "expectedRevision")) return false;
  return typeof request.taskId === "string" && request.taskId.length > 0 &&
    request.taskId.length <= 4096 &&
    (request.expectedRevision === undefined ||
      (typeof request.expectedRevision === "string" && REVISION.test(request.expectedRevision)));
}

/**
 * Conflate missing, unreadable and read-only tasks. Viewer membership grants
 * reading but not writing. Project tasks inherit the project's Area. Only
 * current private owners and shared editors/admins can edit a title.
 */
export function canEditIsolatedTargetTaskTitle(
  db: DatabaseSync, actorUserId: string, taskId: string,
): boolean {
  try {
    return db.prepare(`
      SELECT 1
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      JOIN areas a ON a.id = COALESCE(t.area_id, p.area_id)
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN identities actor ON actor.id = ?
      LEFT JOIN area_members m ON m.area_id = a.id AND m.user_id = actor.id
      WHERE t.id = ?
        AND ((t.project_id IS NULL AND t.area_id IS NOT NULL)
          OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))
        AND a.owner_user_id = w.owner_user_id
        AND ((a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id)
          OR (a.kind = 'shared' AND w.kind = 'shared'
            AND m.role IN ('editor', 'admin')))
      LIMIT 1
    `).get(actorUserId, taskId) !== undefined;
  } catch {
    return false; // No task information escapes a failed query.
  }
}
