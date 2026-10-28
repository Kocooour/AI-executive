/** Staging-only owner-private project selector. Never expose shared projects or aggregates. */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MAX_STAGING_PAGE_OFFSET } from "./target-task-read-model";

export type TargetReadableProject = {
  id: string;
  title: string;
  areaId: string;
  areaKind: "private";
};

export type TargetPrivateProjectPage = {
  projects: TargetReadableProject[];
  hasMore: boolean;
  revision: string;
};

type ProjectRow = TargetReadableProject & { policyRevision: number; projectRevision: number };

const actorPattern = /^[A-Za-z0-9_.:@-]{1,120}$/;
const authorizedFrom = `
  FROM projects p
  JOIN areas a ON a.id = p.area_id
  JOIN workspaces w ON w.id = a.workspace_id
  JOIN identities actor ON actor.id = ?
  WHERE a.kind = 'private' AND w.kind = 'personal'
    AND a.owner_user_id = actor.id AND w.owner_user_id = actor.id`;
const columns = `SELECT p.id AS id, p.title AS title, a.id AS areaId,
    a.kind AS areaKind, a.policy_revision AS policyRevision,
    p.revision AS projectRevision`;

/** Call only on the same pinned, preflighted, read-only SQLite snapshot. */
export function readPrivateProjectsAtOffset(
  db: DatabaseSync, actorUserId: string, restoreGeneration: string,
  limit: number, offset: number,
): TargetPrivateProjectPage | null {
  if (!actorPattern.test(actorUserId) || typeof restoreGeneration !== "string" ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 ||
      offset > MAX_STAGING_PAGE_OFFSET) return null;
  try {
    // Both queries run on the same private SQLite copy. The revision deliberately
    // excludes other owners, shared projects, tasks, and unrelated metadata.
    const hash = createHash("sha256").update("lumi:r2b:private-project-list-revision:v2\0")
      .update(JSON.stringify(restoreGeneration)).update("\0");
    const revisionRows = db.prepare(`${columns} ${authorizedFrom}
      ORDER BY p.id COLLATE BINARY ASC`);
    for (const row of revisionRows.iterate(actorUserId) as Iterable<ProjectRow>) {
      hash.update(JSON.stringify([
        row.id, row.title, row.areaId, row.areaKind, row.policyRevision,
        row.projectRevision,
      ])).update("\0");
    }
    const rows = db.prepare(`${columns} ${authorizedFrom}
      ORDER BY p.id COLLATE BINARY ASC LIMIT ? OFFSET ?`)
      .all(actorUserId, limit + 1, offset) as ProjectRow[];
    return {
      revision: hash.digest("hex"),
      hasMore: rows.length > limit,
      projects: rows.slice(0, limit).map(row => ({
        id: row.id, title: row.title, areaId: row.areaId, areaKind: "private",
      })),
    };
  } catch {
    return null;
  }
}

/** Owner-private direct lookup. The actor and project ID are both SQL parameters. */
export function readPrivateProjectById(
  db: DatabaseSync, actorUserId: string, projectId: string,
): TargetReadableProject | null {
  if (!actorPattern.test(actorUserId) || typeof projectId !== "string" ||
      projectId.length === 0 ||
      Buffer.byteLength(projectId, "utf8") > 512 ||
      /[\u0000-\u001f\u007f]/.test(projectId)) return null;
  try {
    const row = db.prepare(columns + " " + authorizedFrom + " AND p.id = ? LIMIT 1")
      .get(actorUserId, projectId) as ProjectRow | undefined;
    if (!row || row.id !== projectId) return null;
    return { id: row.id, title: row.title, areaId: row.areaId, areaKind: "private" };
  } catch {
    return null;
  }
}
