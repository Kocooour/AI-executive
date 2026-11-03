/**
 * R2d staging-only PROJECT STRUCTURAL relations (not reviewable claim edges).
 * Derives canonical project -> task/note parentage directly from current FKs,
 * from one preflighted, authenticated, pinned SQLite snapshot. This does not
 * grant access to any linked entity or expose note body/title or task title.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isReadableStagingProjectId } from "./target-project-id";
import { readAuthorizedProjectTasksPage } from "./target-project-task-read-model";
import { MAX_STAGING_PAGE_OFFSET, type TargetReadLinearization } from "./target-task-read-model";

export const PROJECT_RELATIONS_PAGE_LIMIT = 50;
export type TargetStructuralRelation = {
  predicate: "contains_note" | "contains_task";
  projectId: string;
  targetId: string;
};
export type TargetAuthorizedStructuralRelationsPage = {
  relations: TargetStructuralRelation[];
  hasMore: boolean;
  revision: string;
  linearization: TargetReadLinearization;
  /** Server-side live guard only; never part of external JSON. Includes lookahead task. */
  taskGuardIds: string[];
  /** Server-side note journal witness checked live before release. */
  stamp: { areaId: string; epoch: number; contentRevision: number; head: number };
};
export type TargetAuthorizedStructuralRelationsResult =
  | { ok: true; page: TargetAuthorizedStructuralRelationsPage }
  | { ok: false; reason: "inaccessible" | "unavailable" };

const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
type Row = { predicate: "contains_note" | "contains_task"; targetId: string };
const nonnegative = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Inaccessible/unknown project returns the same uninformative error. Offset
 * paging uses a signed caller-bound cursor at HTTP; offset itself is internal.
 */
export function readAuthorizedProjectStructuralRelations(
  db: DatabaseSync,
  request: { actorUserId: string; projectId: string; limit: number;
    offset: number; restoreGeneration: string },
): TargetAuthorizedStructuralRelationsResult | null {
  if (!request || !ACTOR.test(request.actorUserId) ||
      !isReadableStagingProjectId(request.projectId) ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 ||
      request.limit > PROJECT_RELATIONS_PAGE_LIMIT ||
      !Number.isSafeInteger(request.offset) || request.offset < 0 ||
      request.offset > MAX_STAGING_PAGE_OFFSET ||
      typeof request.restoreGeneration !== "string" || !request.restoreGeneration)
    return null;
  try {
    // Reuse already-reviewed parent ACL selector. Neither the caller's actor
    // nor a guessed project/Area match is an authorization proof.
    const authorized = readAuthorizedProjectTasksPage(db, {
      actorUserId: request.actorUserId, projectId: request.projectId,
      restoreGeneration: request.restoreGeneration, limit: 1, offset: 0,
    });
    if (!authorized) return null;
    if (!authorized.ok) return { ok: false, reason: "inaccessible" };
    const areaId = authorized.page.project.areaId;
    const snapshot = db.prepare(`SELECT p.revision AS projectRevision,
      a.content_revision AS taskRevision, a.project_content_revision AS projectContentRevision,
      a.policy_revision AS policyRevision,
      a.note_sync_revision AS noteRevision,
      COALESCE((SELECT MAX(j.seq) FROM note_change_journal j WHERE j.area_id=a.id),0) AS head,
      i.revocation_epoch AS epoch
      FROM projects p JOIN areas a ON a.id=p.area_id
      JOIN identities i ON i.id=? WHERE p.id=? AND a.id=? LIMIT 1`)
      .get(request.actorUserId, request.projectId, areaId) as
      ({ projectRevision: number; taskRevision: number; projectContentRevision: number;
        policyRevision: number; noteRevision: number; head: number; epoch: number }) | undefined;
    if (!snapshot || Object.values(snapshot).some(v => !nonnegative(v)) ||
        snapshot.head > snapshot.noteRevision) return null;
    // Canonical links only. A task/note attached to a project has no
    // independent Area; the target inherits the project's authorized Area.
    const rows = db.prepare(`SELECT 'contains_note' AS predicate, n.id AS targetId
      FROM notes n WHERE n.project_id=? AND n.area_id IS NULL
      UNION ALL
      SELECT 'contains_task' AS predicate, t.id AS targetId
      FROM tasks t WHERE t.project_id=? AND t.area_id IS NULL
      ORDER BY predicate COLLATE BINARY ASC, targetId COLLATE BINARY ASC
      LIMIT ? OFFSET ?`)
      .all(request.projectId, request.projectId, request.limit + 1, request.offset) as Row[];
    const allowed = rows.every(r => r && (r.predicate === "contains_note" ||
      r.predicate === "contains_task") &&
      typeof r.targetId === "string" && r.targetId.length > 0 &&
      Buffer.byteLength(r.targetId, "utf8") <= 512);
    if (!allowed) return null;
    // Guard includes lookahead task: otherwise a moved target could change
    // hasMore between snapshot and release without invalidating the response.
    const taskGuardIds = rows.filter(r => r.predicate === "contains_task").map(r => r.targetId);
    const relations = rows.slice(0, request.limit).map(r => ({
      predicate: r.predicate, projectId: request.projectId, targetId: r.targetId,
    }));
    const revision = createHash("sha256")
      .update("lumi:r2d:structural-project-relations:v1\\0")
      .update(JSON.stringify([
        request.restoreGeneration, request.projectId, areaId,
        authorized.page.linearization.areas[0]?.access,
        snapshot.policyRevision, snapshot.projectRevision,
        snapshot.taskRevision, snapshot.projectContentRevision,
        snapshot.noteRevision, snapshot.head,
      ])).digest("hex");
    return { ok: true, page: {
      relations, hasMore: rows.length > request.limit, revision,
      linearization: authorized.page.linearization, taskGuardIds,
      stamp: { areaId, epoch: snapshot.epoch,
        contentRevision: snapshot.noteRevision, head: snapshot.head },
    } };
  } catch {
    return null;
  }
}
