/**
 * R2d.1b: project list over one preflighted, pinned staging snapshot.
 * Only server-verified principals may request their private or shared projects.
 * Area policy remains the sole source of visibility for project and children.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MAX_STAGING_PAGE_OFFSET } from "./target-task-read-model";
import { isReadableStagingProjectId } from "./target-project-id";
import { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";
import type { TargetReadLinearization, TargetReadAreaAccess } from "./target-task-read-model";
import type { TargetAuthorizedReadableProject } from "./target-project-task-read-model";

export type TargetProjectIndexScope = "personal" | "shared";
export type TargetProjectIndexGuardRow = { id: string; areaId: string };
export type TargetAuthorizedProjectIndexPage = {
  projects: TargetAuthorizedReadableProject[];
  hasMore: boolean;
  revision: string;
  linearization: TargetReadLinearization;
  /** Includes the lookahead row; checked against the LIVE store before HTTP release. */
  guardProjects: TargetProjectIndexGuardRow[];
};

const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
type AreaRow = {
  areaId: string; areaKind: "private" | "shared"; policyRevision: number;
  projectContentRevision: number; role: string | null;
};
type ProjectRow = TargetAuthorizedReadableProject;
const accessOf = (area: AreaRow): TargetReadAreaAccess | null =>
  area.areaKind === "private" ? "private-owner" :
    area.role === "viewer" || area.role === "editor" || area.role === "admin" ? area.role : null;

export function readAuthorizedProjectIndexPage(
  db: DatabaseSync, request: {
    actorUserId: string; scope: TargetProjectIndexScope;
    limit: number; offset: number; restoreGeneration: string;
  },
): TargetAuthorizedProjectIndexPage | null {
  if (!request || !ACTOR.test(request.actorUserId) ||
      (request.scope !== "personal" && request.scope !== "shared") ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100 ||
      !Number.isSafeInteger(request.offset) || request.offset < 0 ||
      request.offset > MAX_STAGING_PAGE_OFFSET ||
      typeof request.restoreGeneration !== "string" || !request.restoreGeneration) return null;
  try {
    const policy = request.scope === "personal"
      ? "a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id AND w.owner_user_id = actor.id"
      : "a.kind = 'shared' AND w.kind = 'shared' AND a.owner_user_id = w.owner_user_id AND member.role IN ('viewer', 'editor', 'admin')";
    const from = `FROM areas a
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN identities actor ON actor.id = ?
      LEFT JOIN area_members member ON member.area_id = a.id AND member.user_id = actor.id
      WHERE ${policy}`;
    // Project-list epochs come from all contributing, currently accessible Areas,
    // including Areas whose projects fall beyond the current page. No foreign
    // Area or private project is included in a cursor revision.
    const areas = db.prepare(`SELECT a.id AS areaId, a.kind AS areaKind,
      a.policy_revision AS policyRevision, a.project_content_revision AS projectContentRevision,
      member.role AS role ${from}
      AND EXISTS (SELECT 1 FROM projects p INDEXED BY projects_by_area WHERE p.area_id = a.id)
      ORDER BY a.id COLLATE BINARY ASC
      LIMIT ?`).all(request.actorUserId, MAX_SCOPED_READ_AREAS + 1) as AreaRow[];
    if (areas.length > MAX_SCOPED_READ_AREAS) return null;
    const linearization: TargetReadLinearization = { actorUserId: request.actorUserId, areas: [] };
    const hash = createHash("sha256").update("lumi:r2d:authorized-project-index:v1\0")
      .update(request.scope).update("\0").update(request.restoreGeneration).update("\0");
    for (const a of areas) {
      const access = accessOf(a);
      if (!access || !a.areaId ||
          a.areaKind !== (request.scope === "personal" ? "private" : "shared") ||
          !Number.isSafeInteger(a.policyRevision) || a.policyRevision < 0 ||
          !Number.isSafeInteger(a.projectContentRevision) || a.projectContentRevision < 0) return null;
      linearization.areas.push({
        areaId: a.areaId, areaKind: a.areaKind, policyRevision: a.policyRevision, access,
      });
      hash.update(JSON.stringify([a.areaId, a.areaKind, a.policyRevision, a.projectContentRevision, access]))
        .update("\0");
    }
    // Project mutation triggers bump each contributing Area's monotonic
    // project_content_revision. Cursor staleness is thus independent of the
    // number of project rows; LIMIT bounds the rows hydrated for each page.
    // This also avoids invalidating project cursors for task-only changes.
    const page = db.prepare(`SELECT p.id AS id, p.title AS title, a.id AS areaId,
      a.kind AS areaKind
      FROM projects p JOIN areas a ON a.id = p.area_id
      JOIN workspaces w ON w.id = a.workspace_id
      JOIN identities actor ON actor.id = ?
      LEFT JOIN area_members member ON member.area_id = a.id AND member.user_id = actor.id
      WHERE ${policy} ORDER BY p.id COLLATE BINARY ASC
      LIMIT ? OFFSET ?`).all(request.actorUserId, request.limit + 1, request.offset) as ProjectRow[];
    const knownAreas = new Set(linearization.areas.map(a => a.areaId));
    if (page.some(row =>
      !isReadableStagingProjectId(row.id) || typeof row.title !== "string" ||
      !knownAreas.has(row.areaId))) return null;
    return {
      projects: page.slice(0, request.limit).map(row => ({
        id: row.id, title: row.title, areaId: row.areaId, areaKind: row.areaKind,
      })),
      hasMore: page.length > request.limit, revision: hash.digest("hex"), linearization,
      guardProjects: page.map(row => ({ id: row.id, areaId: row.areaId })),
    };
  } catch {
    return null;
  }
}
