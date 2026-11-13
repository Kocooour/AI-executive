/**
 * R2 staging-only policy probe for a *future* single-task title mutation.
 *
 * This module never writes to a database. A positive answer is valid only for
 * the currently pinned, preflighted SQLite snapshot. A future write command
 * MUST repeat identity, ACL, schema, generation and revision checks atomically
 * inside its own write transaction; do not trust this preview as a capability.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export interface TargetTaskTitleEditPreviewRequest {
  readonly taskId: string;
  /** SHA-256 of target task state, policy epoch and restore generation. */
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
 * Staging task + policy CAS token. It covers the task revision (which also
 * moves on reassignment), the effective Area's policy_revision, the restore
 * generation and the task/Area identity columns. Task revisions and
 * policy_revision are monotonically bumped by canonical SQLite triggers (also
 * when values change and then revert); any membership or role change in the
 * Area invalidates the token conservatively for all of its tasks.
 *
 * The token is a CAS precondition, never authorization: the caller must run
 * canonical preflight and the writer re-checks the write ACL inside
 * BEGIN IMMEDIATE. It does not expose title, actor or task content.
 */
export function targetTaskTitleEditRevision(
  db: DatabaseSync, taskId: string, revisionOverride?: number,
): string | null {
  if(revisionOverride!==undefined&&(!Number.isSafeInteger(revisionOverride)||
    revisionOverride<0))return null;
  try {
    const row = db.prepare(`
      SELECT t.id AS id, t.revision AS task_revision,
        t.project_id AS project_id, t.area_id AS area_id,
        t.assignee_user_id AS assignee_user_id,
        a.id AS effective_area_id, a.policy_revision AS policy_revision,
        a.kind AS area_kind, a.workspace_id AS workspace_id, a.owner_user_id AS owner_user_id,
        (SELECT value FROM metadata WHERE key='restore_generation') AS restore_generation
      FROM tasks t
      LEFT JOIN projects p ON p.id=t.project_id
      JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
      WHERE t.id=?
    `).get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return createHash("sha256").update(JSON.stringify([
      "lumi:r2:task-title-cas:v2", row.restore_generation,
      row.id, revisionOverride??row.task_revision, row.project_id, row.area_id, row.assignee_user_id,
      row.effective_area_id, row.policy_revision, row.area_kind,
      row.workspace_id, row.owner_user_id,
    ])).digest("hex");
  } catch {
    return null;
  }
}

/** R2c.1 delete commands use the very same CAS token as title edits. */
export const targetTaskWriteRevision = targetTaskTitleEditRevision;

/**
 * Conflate missing, unreadable and read-only tasks. Viewer membership grants
 * reading but not writing. Project tasks inherit the project's Area. Only
 * current private owners and shared editors/admins can edit a title.
 */
export function canEditIsolatedTargetTaskTitle(
  db: DatabaseSync, actorUserId: string, taskId: string, privateOnly = false,
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
        AND (? = 0 OR (a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id))
        AND ((a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id)
          OR (a.kind = 'shared' AND w.kind = 'shared'
            AND m.role IN ('editor', 'admin')))
      LIMIT 1
    `).get(actorUserId, taskId, privateOnly ? 1 : 0) !== undefined;
  } catch {
    return false; // No task information escapes a failed query.
  }
}


/**
 * R2c.1: the same write right (private owner of the Area, or shared
 * editor/admin) evaluated against the Area a TOMBSTONE records, with the
 * actor's CURRENT role there. This only answers "may this actor write that
 * Area"; a caller must additionally require an actor-owned receipt before it
 * reveals anything, so an editor of the Area learns nothing about tombstones of
 * commands issued by others. A viewer, non-member, foreign private owner and a
 * never-existing ID are all `false`.
 */
export function canWriteIsolatedTargetTaskTombstone(
  db: DatabaseSync, actorUserId: string, taskId: string, privateOnly = false,
): boolean {
  try {
    return db.prepare(`
      SELECT 1
      FROM task_tombstones ts
      JOIN areas a ON a.id = ts.area_id
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN identities actor ON actor.id = ?
      LEFT JOIN area_members m ON m.area_id = a.id AND m.user_id = actor.id
      WHERE ts.id = ?
        AND a.owner_user_id = w.owner_user_id
        AND (? = 0 OR (a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id))
        AND ((a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id)
          OR (a.kind = 'shared' AND w.kind = 'shared'
            AND m.role IN ('editor', 'admin')))
      LIMIT 1
    `).get(actorUserId, taskId, privateOnly ? 1 : 0) !== undefined;
  } catch {
    return false; // No task information escapes a failed query.
  }
}

/** Live task with write right, or a tombstoned ID in an Area the actor can write; else null. */
export function targetTaskWriteTarget(
  db: DatabaseSync, actorUserId: string, taskId: string, privateOnly = false,
): "live" | "tombstone" | null {
  if (canEditIsolatedTargetTaskTitle(db, actorUserId, taskId, privateOnly)) return "live";
  return canWriteIsolatedTargetTaskTombstone(db, actorUserId, taskId, privateOnly) ? "tombstone" : null;
}

/**
 * R2c.3: the same write right evaluated against an Area named by the client
 * (`writeAreaId`). A non-existent Area, a viewer, a non-member and a foreign
 * private Area are all `false`, so a caller can map them to one indistinguishable
 * denial.
 */
export function canWriteIsolatedTargetArea(
  db: DatabaseSync, actorUserId: string, areaId: string, privateOnly = false,
): boolean {
  try {
    return db.prepare(`
      SELECT 1
      FROM areas a
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN identities actor ON actor.id = ?
      LEFT JOIN area_members m ON m.area_id = a.id AND m.user_id = actor.id
      WHERE a.id = ?
        AND a.owner_user_id = w.owner_user_id
        AND (? = 0 OR (a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id))
        AND ((a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id)
          OR (a.kind = 'shared' AND w.kind = 'shared'
            AND m.role IN ('editor', 'admin')))
      LIMIT 1
    `).get(actorUserId, areaId, privateOnly ? 1 : 0) !== undefined;
  } catch {
    return false;
  }
}

/** The store's current restore generation (lower-cased), or null if unreadable. */
export function targetStoreRestoreGeneration(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
      .get() as { value: string } | undefined;
    return row && typeof row.value === "string" ? row.value.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type TargetTaskWriteContractCheck =
  | { ok: true; target: "live" | "tombstone" }
  | { ok: false; reason: "resync_required" | "unavailable" | "write_area_mismatch" };

/**
 * R2c.3 fixed check order for every task write command and its status
 * verification (inside the write transaction / pinned snapshot, before any
 * mutation or receipt lookup):
 *   1. `restoreGeneration` differs from the store's        -> resync_required
 *      (store-level, reveals nothing about tasks);
 *   2. actor write access to the task (live task; for delete also the
 *      tombstone's Area)                                    -> unavailable
 *   3. actor write right in `writeAreaId` (the Area need not exist)
 *                                                            -> the SAME unavailable
 *   4. `writeAreaId` is the task's effective Area (or the tombstone's Area)
 *                                                            -> write_area_mismatch
 * Only an actor who may write the task AND the named Area can ever see (4).
 */
export function checkTargetTaskWriteContract(
  db: DatabaseSync, actorUserId: string,
  request: { readonly taskId: string; readonly writeAreaId: string; readonly restoreGeneration: string },
  privateOnly = false, allowTombstone = false,
): TargetTaskWriteContractCheck {
  const generation = targetStoreRestoreGeneration(db);
  if (generation === null || generation !== request.restoreGeneration.toLowerCase()) {
    return { ok: false, reason: "resync_required" };
  }
  const target = allowTombstone
    ? targetTaskWriteTarget(db, actorUserId, request.taskId, privateOnly)
    : (canEditIsolatedTargetTaskTitle(db, actorUserId, request.taskId, privateOnly) ? "live" : null);
  if (!target) return { ok: false, reason: "unavailable" };
  if (!canWriteIsolatedTargetArea(db, actorUserId, request.writeAreaId, privateOnly)) {
    return { ok: false, reason: "unavailable" };
  }
  let taskArea: string | undefined;
  try {
    const row = (target === "live"
      ? db.prepare(`SELECT COALESCE(t.area_id,p.area_id) AS area_id
          FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?`)
      : db.prepare("SELECT area_id FROM task_tombstones WHERE id=?")
    ).get(request.taskId) as { area_id: string } | undefined;
    taskArea = row?.area_id;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (taskArea === undefined) return { ok: false, reason: "unavailable" };
  return taskArea === request.writeAreaId
    ? { ok: true, target } : { ok: false, reason: "write_area_mismatch" };
}
