/**
 * R2d default-off: content-free, actor-scoped canonical parent backlinks.
 * A backlink is not a semantic Context Graph relation or an access grant.
 * Must run in a pinned/preflighted, read-only snapshot with a verified actor.
 */
import { DatabaseSync } from "node:sqlite";
import type { TargetReadAreaAccess, TargetReadLinearization } from "./target-task-read-model";

export type TargetBacklinkKind = "task" | "note";
export type TargetBacklink = {
  predicate: "belongs_to_project"; sourceKind: TargetBacklinkKind;
  sourceId: string; projectId: string;
};
export type TargetTaskBacklinkLiveGuard = {
  taskId: string; projectId: string | null; areaId: string;
  taskRevision: number; parentRevision: number | null;
};
export type TargetAuthorizedBacklink = {
  relations: TargetBacklink[];
  linearization: TargetReadLinearization;
  taskGuard: TargetTaskBacklinkLiveGuard | null;
  noteGuard: { noteId: string; projectId: string | null; areaId: string;
    noteRevision: number; parentRevision: number | null } | null;
};
const USER = /^[A-Za-z0-9_.:@-]{1,120}$/;
export const validBacklinkId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  value !== "." && value !== ".." && value.isWellFormed() &&
  Buffer.byteLength(value, "utf8") <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
type Row = {
  id: string; projectId: string | null; directAreaId: string | null;
  areaId: string; areaKind: "private" | "shared"; areaOwner: string;
  workspaceOwner: string; workspaceKind: string; policyRevision: number;
  role: string | null; revision: number; parentRevision: number | null;
};
const positive = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/** Fails closed and makes foreign/unknown entities indistinguishable. */
export function readAuthorizedTargetParentBacklink(
  db: DatabaseSync, request: { actorUserId: string;
    kind: TargetBacklinkKind; id: string },
): TargetAuthorizedBacklink | null {
  if (!request || !USER.test(request.actorUserId) ||
      (request.kind !== "task" && request.kind !== "note") ||
      !validBacklinkId(request.id)) return null;
  try {
    const table = request.kind === "task" ? "tasks" : "notes";
    // The table identifier is selected ONLY from the closed trusted enum,
    // never from the URL; actor ACL and project parentage share one statement.
    const row = db.prepare(`SELECT child.id AS id, child.project_id AS projectId,
      child.area_id AS directAreaId, a.id AS areaId, a.kind AS areaKind,
      a.owner_user_id AS areaOwner, w.owner_user_id AS workspaceOwner,
      w.kind AS workspaceKind, a.policy_revision AS policyRevision,
      member.role AS role, child.revision AS revision,
      p.revision AS parentRevision
      FROM ${table} child
      LEFT JOIN projects p ON p.id=child.project_id
      JOIN areas a ON a.id=COALESCE(child.area_id,p.area_id)
      JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members member ON member.area_id=a.id
        AND member.user_id=actor.id
      WHERE child.id=?
        AND ((child.project_id IS NULL AND child.area_id IS NOT NULL)
          OR (child.project_id IS NOT NULL AND child.area_id IS NULL AND p.id IS NOT NULL))
        AND a.owner_user_id=w.owner_user_id
        AND ((a.kind='private' AND w.kind='personal'
             AND a.owner_user_id=actor.id AND w.owner_user_id=actor.id)
          OR (a.kind='shared' AND w.kind='shared'
             AND member.role IN ('viewer','editor','admin')))
      LIMIT 1`).get(request.actorUserId, request.id) as Row | undefined;
    if (!row || row.id !== request.id || !validBacklinkId(row.areaId) ||
        !positive(row.policyRevision) || !positive(row.revision) ||
        (row.projectId !== null && !validBacklinkId(row.projectId)) ||
        (row.projectId === null
          ? row.directAreaId !== row.areaId || row.parentRevision !== null
          : row.directAreaId !== null || !positive(row.parentRevision as number)) ||
        row.areaOwner !== row.workspaceOwner) return null;
    let access: TargetReadAreaAccess;
    if (row.areaKind === "private" && row.workspaceKind === "personal" &&
        row.areaOwner === request.actorUserId) {
      access = "private-owner";
    } else if (row.areaKind === "shared" && row.workspaceKind === "shared" &&
        (row.role === "viewer" || row.role === "editor" || row.role === "admin")) {
      access = row.role;
    } else return null;
    const relations: TargetBacklink[] = row.projectId === null ? [] : [{
      predicate: "belongs_to_project", sourceKind: request.kind,
      sourceId: row.id, projectId: row.projectId,
    }];
    const linearization: TargetReadLinearization = {
      actorUserId: request.actorUserId, areas: [{
        areaId: row.areaId, areaKind: row.areaKind,
        policyRevision: row.policyRevision, access,
      }],
    };
    return {
      relations, linearization,
      taskGuard: request.kind === "task" ? {
        taskId: row.id, projectId: row.projectId, areaId: row.areaId,
        taskRevision: row.revision, parentRevision: row.parentRevision,
      } : null,
      noteGuard: request.kind === "note" ? {
        noteId: row.id, projectId: row.projectId, areaId: row.areaId,
        noteRevision: row.revision, parentRevision: row.parentRevision,
      } : null,
    };
  } catch {
    return null;
  }
}
