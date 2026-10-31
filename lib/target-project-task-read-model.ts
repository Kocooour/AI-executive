/**
 * R2d.1a staging-only project detail and child task page. Both are selected
 * from a single preflighted SQLite snapshot by the trusted read gateway.
 * The project's Area is the SOLE source of task ACL (project tasks have no
 * independent area_id). A live membership/policy check is required by HTTP.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isReadableStagingProjectId } from "./target-project-id";
import { MAX_STAGING_PAGE_OFFSET } from "./target-task-read-model";
import type { TargetReadAreaAccess, TargetReadLinearization, TargetScopedReadableTask } from "./target-task-read-model";

export type TargetAuthorizedReadableProject = {
  id: string; title: string; areaId: string; areaKind: "private" | "shared";
};

export type TargetAuthorizedProjectTasksPage = {
  project: TargetAuthorizedReadableProject;
  tasks: TargetScopedReadableTask[];
  hasMore: boolean;
  revision: string;
  linearization: TargetReadLinearization;
};

export type TargetAuthorizedProjectTasksResult =
  | { ok: true; page: TargetAuthorizedProjectTasksPage }
  | { ok: false; reason: "unavailable" };

type ProjectRow = {
  id: string; title: string; areaId: string; areaKind: "private" | "shared";
  policyRevision: number; contentRevision: number; projectRevision: number;
  role: string | null;
};

type TaskRow = { id: string; title: string; assignedToMe: number };

const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const denied = (): TargetAuthorizedProjectTasksResult => ({ ok: false, reason: "unavailable" });

/**
 * No actor, Area or workspace selector is accepted from HTTP. The only request
 * selector is the project ID; actor comes from an authenticated server session.
 * Unknown/inaccessible project identities are deliberately indistinguishable.
 */
export function readAuthorizedProjectTasksPage(
  db: DatabaseSync, request: {
    actorUserId: string; projectId: string; limit: number; offset: number;
    restoreGeneration: string;
  },
): TargetAuthorizedProjectTasksResult | null {
  if (!request || !ACTOR.test(request.actorUserId) ||
      !isReadableStagingProjectId(request.projectId) ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100 ||
      !Number.isSafeInteger(request.offset) || request.offset < 0 ||
      request.offset > MAX_STAGING_PAGE_OFFSET ||
      typeof request.restoreGeneration !== "string" || !request.restoreGeneration) return null;
  try {
    const project = db.prepare(`SELECT p.id AS id, p.title AS title,
      a.id AS areaId, a.kind AS areaKind, a.policy_revision AS policyRevision,
      a.content_revision AS contentRevision, p.revision AS projectRevision,
      member.role AS role
      FROM projects p
      JOIN areas a ON a.id = p.area_id
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN identities actor ON actor.id = ?
      LEFT JOIN area_members member ON member.area_id = a.id AND member.user_id = actor.id
      WHERE p.id = ? AND a.owner_user_id = w.owner_user_id
        AND ((a.kind = 'private' AND w.kind = 'personal'
              AND a.owner_user_id = actor.id AND w.owner_user_id = actor.id)
          OR (a.kind = 'shared' AND w.kind = 'shared'
              AND member.role IN ('viewer', 'editor', 'admin')))
      LIMIT 1`).get(request.actorUserId, request.projectId) as ProjectRow | undefined;
    if (!project) return denied();
    const access: TargetReadAreaAccess | null =
      project.areaKind === "private" ? "private-owner"
      : project.role === "viewer" || project.role === "editor" || project.role === "admin"
        ? project.role : null;
    if (!access || !Number.isSafeInteger(project.policyRevision) || project.policyRevision < 0 ||
        !Number.isSafeInteger(project.contentRevision) || project.contentRevision < 0 ||
        !Number.isSafeInteger(project.projectRevision) || project.projectRevision < 0) return null;

    // Project children MUST inherit the project Area. A malformed explicit
    // task.area_id is not silently accepted as an alternative authorization.
    const rows = db.prepare(`SELECT t.id AS id, t.title AS title,
      CASE WHEN t.assignee_user_id = ? THEN 1 ELSE 0 END AS assignedToMe
      FROM tasks t
      WHERE t.project_id = ? AND t.area_id IS NULL
      ORDER BY t.id COLLATE BINARY ASC
      LIMIT ? OFFSET ?`).all(
        request.actorUserId, project.id, request.limit + 1, request.offset,
      ) as TaskRow[];
    const pageRows = rows.slice(0, request.limit);
    const revision = createHash("sha256").update("lumi:r2d:project-tasks:v1\0")
      .update(JSON.stringify([
        request.restoreGeneration, project.id, project.areaId, project.areaKind,
        access, project.policyRevision, project.contentRevision, project.projectRevision,
      ])).digest("hex");
    return { ok: true, page: {
      project: { id: project.id, title: project.title, areaId: project.areaId, areaKind: project.areaKind },
      tasks: pageRows.map(row => ({
        id: row.id, title: row.title, projectId: project.id, areaId: project.areaId,
        effectiveAreaId: project.areaId, areaKind: project.areaKind,
        ...(project.areaKind === "shared" ? { assignedToMe: row.assignedToMe === 1 } : {}),
      })),
      hasMore: rows.length > request.limit, revision,
      linearization: { actorUserId: request.actorUserId, areas: [{
        areaId: project.areaId, areaKind: project.areaKind,
        policyRevision: project.policyRevision, access,
      }] },
    } };
  } catch {
    return null;
  }
}
