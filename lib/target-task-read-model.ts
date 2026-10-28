/**
 * R1 -> R2 staging-only task read selectors over the isolated target schema.
 *
 * SYNTHETIC actorUserId is supplied by the caller, not authenticated. These
 * SELECT-only functions must NOT be connected to routes, startup, UI, sync,
 * integrations or AI until R2 enforces authenticated identity, revisions,
 * read/sync barriers and per-user cache invalidation. Caller must independently
 * preflight the isolated target store.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type TargetTaskScope = "my-plan" | "personal" | "shared";

export type TargetReadableTask = {
  id: string;
  title: string;
  projectId: string | null;
  effectiveAreaId: string;
  areaKind: "private" | "shared";
  assigneeUserId: string | null;
};

export interface TargetTaskListRequest {
  actorUserId: string;
  scope: TargetTaskScope;
  limit?: number;
  afterTaskId?: string | null;
}

export interface TargetTaskOffsetListRequest {
  actorUserId: string;
  scope: TargetTaskScope;
  limit?: number;
  offset: number;
}

export type TargetTaskOffsetListResult =
  | { ok: true; tasks: TargetReadableTask[]; hasMore: boolean }
  | { ok: false; reason: "invalid_request" | "query_failed"; tasks: []; hasMore: false };

/** Bound the staging-only signed page position; never accept it from a client request. */
export const MAX_STAGING_PAGE_OFFSET = 1_000_000;

export type TargetTaskListResult =
  | { ok: true; tasks: TargetReadableTask[]; nextCursor: string | null }
  | { ok: false; reason: "invalid_request" | "query_failed"; tasks: []; nextCursor: null };

export interface TargetTaskDetailRequest {
  actorUserId: string;
  taskId: string;
}

export type TargetTaskDetailResult =
  | { ok: true; task: TargetReadableTask }
  | { ok: false; reason: "invalid_request" | "unavailable" | "query_failed"; task: null };

type TaskRow = {
  id: string;
  title: string;
  projectId: string | null;
  effectiveAreaId: string;
  areaKind: "private" | "shared";
  assigneeUserId: string | null;
};

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.trim() === id;

const toTask = (row: TaskRow): TargetReadableTask => ({
  id: row.id,
  title: row.title,
  projectId: row.projectId,
  effectiveAreaId: row.effectiveAreaId,
  areaKind: row.areaKind,
  assigneeUserId: row.assigneeUserId,
});

// The same SQL authorization predicate protects both lists and direct detail
// reads. It uses the current Area membership row, not a client-supplied Area,
// project, workspace or visibility flag. It intentionally emits no membership
// lists and never selects information from inaccessible Areas.
const TASK_COLUMNS = `SELECT t.id AS id, t.title AS title, t.project_id AS projectId,
    a.id AS effectiveAreaId, a.kind AS areaKind,
    t.assignee_user_id AS assigneeUserId`;

const AUTHORIZED_TASK_FROM = `
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  JOIN areas a ON a.id = COALESCE(t.area_id, p.area_id)
  JOIN workspaces w ON w.id = a.workspace_id
  JOIN identities actor ON actor.id = ?
  LEFT JOIN area_members member ON member.area_id = a.id AND member.user_id = actor.id
  WHERE ((t.project_id IS NULL AND t.area_id IS NOT NULL)
      OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))
    AND a.owner_user_id = w.owner_user_id
    AND ((a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id)
      OR (a.kind = 'shared' AND w.kind = 'shared'
        AND member.role IN ('viewer', 'editor', 'admin')))
`;

/**
 * Opaque pagination revision for the *authenticated actor's* personal list.
 *
 * Hash only rows that the same list ACL permits the actor to read. Hashing
 * the whole staging SQLite file would disclose another person's task changes
 * via otherwise unchanged HTTP cursors. Task revisions also detect an ABA edit
 * (a title changed and then restored). The caller owns a private, preflighted
 * SQLite snapshot, so pagination and this digest observe identical contents.
 */
export function personalTaskListRevision(db: DatabaseSync, actorUserId: string): string | null {
  if (!validId(actorUserId)) return null;
  try {
    const hash = createHash("sha256").update("lumi:r2b:personal-task-list-revision:v1\0");
    const rows = db.prepare(`SELECT t.id AS id, t.title AS title,
        t.project_id AS projectId, a.id AS effectiveAreaId,
        a.kind AS areaKind, t.assignee_user_id AS assigneeUserId,
        t.revision AS revision
      ${AUTHORIZED_TASK_FROM}
      AND a.kind = 'private'
      ORDER BY t.id COLLATE BINARY ASC, t.rowid ASC`);
    for (const row of rows.iterate(actorUserId)) {
      hash.update(JSON.stringify([
        row.id, row.title, row.projectId, row.effectiveAreaId,
        row.areaKind, row.assigneeUserId, row.revision,
      ])).update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/**
 * Read one task if and only if its effective Area is readable by the actor.
 * An unknown actor, missing task and inaccessible task share one result.
 */
export function readIsolatedTargetTask(
  db: DatabaseSync, request: TargetTaskDetailRequest, personalOnly = false,
): TargetTaskDetailResult {
  if (!request || !validId(request.actorUserId) || !validId(request.taskId)) {
    return { ok: false, reason: "invalid_request", task: null };
  }
  try {
    const row = db.prepare(`${TASK_COLUMNS} ${AUTHORIZED_TASK_FROM}
      AND t.id = ? ${personalOnly ? "AND a.kind = 'private'" : ""}`)
      .get(request.actorUserId, request.taskId) as TaskRow | undefined;
    if (!row) return { ok: false, reason: "unavailable", task: null };
    return { ok: true, task: toTask(row) };
  } catch {
    return { ok: false, reason: "query_failed", task: null };
  }
}

/**
 * List tasks in a read scope, ordered by stable ID. A bounded keyset cursor
 * prevents unbounded reads, but it is not a revision-stable sync cursor: R2
 * must add its own snapshot/revision semantics before runtime activation.
 *
 * An unknown actor returns the same empty list as an actor with no tasks,
 * rather than disclosing identity existence.
 */
export function listIsolatedTargetTasks(
  db: DatabaseSync, request: TargetTaskListRequest,
): TargetTaskListResult {
  if (!request || !validId(request.actorUserId) ||
      !["my-plan", "personal", "shared"].includes(request.scope) ||
      (request.afterTaskId != null && !validId(request.afterTaskId)) ||
      (request.limit !== undefined && (!Number.isInteger(request.limit) ||
        request.limit < 1 || request.limit > 100))) {
    return { ok: false, reason: "invalid_request", tasks: [], nextCursor: null };
  }
  const limit = request.limit ?? 50;
  try {
    const rows = db.prepare(`${TASK_COLUMNS} ${AUTHORIZED_TASK_FROM}
      AND ((? = 'personal' AND a.kind = 'private')
        OR (? = 'shared' AND a.kind = 'shared')
        OR (? = 'my-plan' AND (a.kind = 'private'
          OR (a.kind = 'shared' AND t.assignee_user_id = actor.id
            AND member.role IN ('editor', 'admin')))))
      AND (? IS NULL OR t.id > ? COLLATE BINARY)
      ORDER BY t.id COLLATE BINARY ASC
      LIMIT ?`).all(
      request.actorUserId, request.scope, request.scope, request.scope,
      request.afterTaskId ?? null, request.afterTaskId ?? null, limit + 1,
    ) as TaskRow[];
    const hasMore = rows.length > limit;
    const tasks = rows.slice(0, limit).map(toTask);
    return { ok: true, tasks, nextCursor: hasMore ? tasks[tasks.length - 1].id : null };
  } catch {
    return { ok: false, reason: "query_failed", tasks: [], nextCursor: null };
  }
}

/**
 * Revision-stable staging pagination uses a bounded position, not a task ID.
 * The caller must authenticate, preflight and pin the revision on each page.
 * BINARY ID plus rowid breaks ties (including nullable TEXT PRIMARY KEY IDs)
 * without excluding valid IDs containing whitespace or long text.
 */
export function listIsolatedTargetTasksAtOffset(
  db: DatabaseSync, request: TargetTaskOffsetListRequest,
): TargetTaskOffsetListResult {
  if (!request || !validId(request.actorUserId) ||
      !["my-plan", "personal", "shared"].includes(request.scope) ||
      !Number.isSafeInteger(request.offset) || request.offset < 0 ||
      request.offset > MAX_STAGING_PAGE_OFFSET ||
      (request.limit !== undefined && (!Number.isInteger(request.limit) ||
        request.limit < 1 || request.limit > 100))) {
    return { ok: false, reason: "invalid_request", tasks: [], hasMore: false };
  }
  const limit = request.limit ?? 50;
  try {
    const rows = db.prepare(`${TASK_COLUMNS} ${AUTHORIZED_TASK_FROM}
      AND ((? = 'personal' AND a.kind = 'private')
        OR (? = 'shared' AND a.kind = 'shared')
        OR (? = 'my-plan' AND (a.kind = 'private'
          OR (a.kind = 'shared' AND t.assignee_user_id = actor.id
            AND member.role IN ('editor', 'admin')))))
      ORDER BY t.id COLLATE BINARY ASC, t.rowid ASC
      LIMIT ? OFFSET ?`).all(
      request.actorUserId, request.scope, request.scope, request.scope,
      limit + 1, request.offset,
    ) as TaskRow[];
    return { ok: true, tasks: rows.slice(0, limit).map(toTask), hasMore: rows.length > limit };
  } catch {
    return { ok: false, reason: "query_failed", tasks: [], hasMore: false };
  }
}


