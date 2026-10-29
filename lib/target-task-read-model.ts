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
 * R2-ID.2b scoped (shared / my-plan) read DTOs. Rows never carry another user's
 * ID, a member list or a count: only the actor's own assignment as a boolean.
 */
export type TargetScopedReadableTask = {
  id: string;
  title: string;
  projectId: string | null;
  effectiveAreaId: string;
  areaId: string;
  areaKind: "private" | "shared";
  /** Present on shared-Area rows only. */
  assignedToMe?: boolean;
};

/** How the actor's read access to a contributing Area was established. */
export type TargetReadAreaAccess = "private-owner" | "viewer" | "editor" | "admin";

export type TargetReadContributingArea = {
  areaId: string;
  areaKind: "private" | "shared";
  policyRevision: number;
  access: TargetReadAreaAccess;
};

/** What a snapshot read observed; re-verified on the LIVE store before release. */
export type TargetReadLinearization = {
  actorUserId: string;
  areas: TargetReadContributingArea[];
};

export type TargetScopedOffsetPage = {
  tasks: TargetScopedReadableTask[];
  hasMore: boolean;
  revision: string;
  linearization: TargetReadLinearization;
};

type ScopedRow = {
  id: string; title: string; projectId: string | null; areaId: string;
  areaKind: "private" | "shared"; assignedToMe: number; policyRevision: number;
  role: string | null; taskRevision: number;
};

const SCOPED_COLUMNS = `SELECT t.id AS id, t.title AS title, t.project_id AS projectId,
    a.id AS areaId, a.kind AS areaKind,
    CASE WHEN t.assignee_user_id = actor.id THEN 1 ELSE 0 END AS assignedToMe,
    a.policy_revision AS policyRevision, member.role AS role, t.revision AS taskRevision`;

const SCOPE_PREDICATE = `
  AND ((? = 'shared' AND a.kind = 'shared')
    OR (? = 'my-plan' AND (a.kind = 'private'
      OR (a.kind = 'shared' AND t.assignee_user_id = actor.id
        AND member.role IN ('editor', 'admin')))))`;

const toScopedTask = (row: ScopedRow): TargetScopedReadableTask => ({
  id: row.id, title: row.title, projectId: row.projectId,
  effectiveAreaId: row.areaId, areaId: row.areaId, areaKind: row.areaKind,
  ...(row.areaKind === "shared" ? { assignedToMe: row.assignedToMe === 1 } : {}),
});

const scopedAccess = (row: Pick<ScopedRow, "areaKind" | "role">): TargetReadAreaAccess | null =>
  row.areaKind === "private" ? "private-owner"
    : row.role === "viewer" || row.role === "editor" || row.role === "admin" ? row.role : null;

function linearizationOf(actorUserId: string, rows: ScopedRow[]): TargetReadLinearization | null {
  const areas = new Map<string, TargetReadContributingArea>();
  for (const row of rows) {
    const access = scopedAccess(row);
    if (!access) return null;
    areas.set(row.areaId, { areaId: row.areaId, areaKind: row.areaKind, policyRevision: row.policyRevision, access });
  }
  return { actorUserId, areas: [...areas.values()] };
}

/**
 * Per-Area cursor marker. Indexed EXISTS probes locate only Areas actually
 * contributing tasks to the requested authenticated view. No task titles or
 * complete task rows are read to calculate a page's revision; a single task
 * mutation increments the relevant Area epoch in the SAME SQLite transaction.
 *
 * A shared Area is included in my-plan only while at least one of its tasks
 * is assigned to the actor. This avoids stale cursors for invisible Areas.
 * Changes to other tasks in a visible shared Area may conservatively stale
 * my-plan, but cannot reveal activity in an Area the actor cannot read.
 */
type AreaRevisionRow = {
  areaId: string; areaKind: "private" | "shared"; policyRevision: number;
  contentRevision: number; role: string | null;
};

const AUTHORIZED_AREA_FROM = `
  FROM areas a
  JOIN workspaces w ON w.id = a.workspace_id
  JOIN identities actor ON actor.id = ?
  LEFT JOIN area_members member ON member.area_id = a.id AND member.user_id = actor.id
  WHERE a.owner_user_id = w.owner_user_id
    AND ((a.kind = 'private' AND w.kind = 'personal' AND a.owner_user_id = actor.id)
      OR (a.kind = 'shared' AND w.kind = 'shared'
        AND member.role IN ('viewer', 'editor', 'admin')))
`;
// Existing task/project indexes provide O(1)-style existence probes per Area.
// The more selective assigned-task indexes handle my-plan without iterating
// unrelated tasks inside a shared Area.
const areaHasTasks = (assigned: boolean): string => `(
  EXISTS (SELECT 1 FROM tasks t
    WHERE t.area_id = a.id AND t.project_id IS NULL
      ${assigned ? "AND t.assignee_user_id = actor.id" : ""})
  OR EXISTS (SELECT 1 FROM projects p JOIN tasks t ON t.project_id = p.id
    WHERE p.area_id = a.id AND t.area_id IS NULL
      ${assigned ? "AND t.assignee_user_id = actor.id" : ""})
)`;

function contributingAreaRows(
  db: DatabaseSync, actorUserId: string, scope: TargetTaskScope,
): AreaRevisionRow[] {
  const selector = scope === "personal"
    ? `a.kind = 'private' AND ${areaHasTasks(false)}`
    : scope === "shared"
      ? `a.kind = 'shared' AND ${areaHasTasks(false)}`
      : `((a.kind = 'private' AND ${areaHasTasks(false)})
        OR (a.kind = 'shared' AND member.role IN ('editor', 'admin')
          AND ${areaHasTasks(true)}))`;
  return db.prepare(`SELECT a.id AS areaId, a.kind AS areaKind,
      a.policy_revision AS policyRevision, a.content_revision AS contentRevision,
      member.role AS role
      ${AUTHORIZED_AREA_FROM} AND (${selector})
      ORDER BY a.id COLLATE BINARY ASC`).all(actorUserId) as AreaRevisionRow[];
}

function hashContributingAreas(
  rows: AreaRevisionRow[], scope: TargetTaskScope, restoreGeneration = "",
): string | null {
  const hash = createHash("sha256")
    .update("lumi:area-cursor-revision:v2\\0" + scope + "\\0" + restoreGeneration + "\\0");
  for (const row of rows) {
    const access = scopedAccess(row);
    if (!access || !Number.isSafeInteger(row.contentRevision) || row.contentRevision < 0 ||
        !Number.isSafeInteger(row.policyRevision) || row.policyRevision < 0) return null;
    hash.update(JSON.stringify([
      row.areaId, row.areaKind, access, row.policyRevision, row.contentRevision,
    ])).update("\\0");
  }
  return hash.digest("hex");
}

/** Used by direct selectors; page reads share the same Area query below. */
export function scopedTaskListRevision(
  db: DatabaseSync, actorUserId: string, scope: "shared" | "my-plan", restoreGeneration: string,
): string | null {
  if (!validId(actorUserId) || !validId(restoreGeneration) ||
      !["shared", "my-plan"].includes(scope)) return null;
  try {
    return hashContributingAreas(contributingAreaRows(db, actorUserId, scope), scope, restoreGeneration);
  } catch {
    return null;
  }
}

/** Offset page for scope shared or my-plan, with its linearization record. */
export function readScopedTaskOffsetPage(
  db: DatabaseSync,
  request: { actorUserId: string; scope: "shared" | "my-plan"; limit: number;
    offset: number; restoreGeneration: string },
): TargetScopedOffsetPage | null {
  if (!request || !validId(request.actorUserId) || !["shared", "my-plan"].includes(request.scope) ||
      !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100 ||
      !Number.isSafeInteger(request.offset) || request.offset < 0 ||
      request.offset > MAX_STAGING_PAGE_OFFSET) return null;
  try {
    const rows = db.prepare(`${SCOPED_COLUMNS} ${AUTHORIZED_TASK_FROM} ${SCOPE_PREDICATE}
      ORDER BY t.id COLLATE BINARY ASC, t.rowid ASC
      LIMIT ? OFFSET ?`).all(
      request.actorUserId, request.scope, request.scope, request.limit + 1, request.offset,
    ) as ScopedRow[];
    const page = rows.slice(0, request.limit);
    // EVERY Area behind anything released (page rows, look-ahead row, cursor revision):
    // all Areas of the actor's scope in this snapshot, not just the page's.
    const scopeRows = contributingAreaRows(db, request.actorUserId, request.scope);
    const linearization = linearizationOf(request.actorUserId, scopeRows);
    const revision = validId(request.restoreGeneration)
      ? hashContributingAreas(scopeRows, request.scope, request.restoreGeneration) : null;
    if (!linearization || !revision) return null;
    return { tasks: page.map(toScopedTask), hasMore: rows.length > request.limit, revision, linearization };
  } catch {
    return null;
  }
}

export type TargetSharedTaskDetail =
  | { ok: true; task: TargetScopedReadableTask; linearization: TargetReadLinearization }
  | { ok: false; reason: "unavailable" | "query_failed" };

/**
 * Detail of a task in a shared Area for any CURRENT member (viewer, editor,
 * admin). Unknown, foreign-private and non-member tasks share one result.
 */
export function readSharedTargetTask(
  db: DatabaseSync, request: TargetTaskDetailRequest,
): TargetSharedTaskDetail {
  if (!request || !validId(request.actorUserId) || !validId(request.taskId)) {
    return { ok: false, reason: "unavailable" };
  }
  try {
    const row = db.prepare(`${SCOPED_COLUMNS} ${AUTHORIZED_TASK_FROM}
      AND a.kind = 'shared' AND t.id = ?`).get(request.actorUserId, request.taskId) as ScopedRow | undefined;
    if (!row) return { ok: false, reason: "unavailable" };
    const linearization = linearizationOf(request.actorUserId, [row]);
    if (!linearization) return { ok: false, reason: "query_failed" };
    return { ok: true, task: toScopedTask(row), linearization };
  } catch {
    return { ok: false, reason: "query_failed" };
  }
}

/**
 * Personal cursor revision uses only this actor's contributing private Area
 * epochs. The HTTP cursor itself remains identity- and generation-bound.
 * No private task of a different owner (or any shared task) contributes.
 */
export function personalTaskListRevision(db: DatabaseSync, actorUserId: string): string | null {
  if (!validId(actorUserId)) return null;
  try {
    return hashContributingAreas(contributingAreaRows(db, actorUserId, "personal"), "personal");
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



/** Content-free, bounded audit timeline for a currently authorized private task.
 * The caller MUST hold a canonical preflighted, read-only staging snapshot. */
export type TargetPrivateTaskTitleAuditEvent = {
  revisionBefore: number;
  revisionAfter: number;
  committedAtMs: number;
};

export type TargetPrivateTaskTitleAuditResult =
  | { ok: true; events: TargetPrivateTaskTitleAuditEvent[] }
  | { ok: false; reason: "invalid_request" | "unavailable" | "query_failed" };

export function readPrivateTaskTitleAudit(
  db: DatabaseSync,
  actorUserId: string,
  taskId: string,
  expectedRestoreGeneration: string,
): TargetPrivateTaskTitleAuditResult {
  if (!validId(actorUserId) || !validId(taskId) || !validId(expectedRestoreGeneration)) {
    return { ok: false, reason: "invalid_request" };
  }
  // Current authorization is checked before the audit table can be queried.
  const detail = readIsolatedTargetTask(db, { actorUserId, taskId }, true);
  if (detail.ok === false) {
    return { ok: false, reason: detail.reason === "query_failed" ? "query_failed" : "unavailable" };
  }
  try {
    const rows = db.prepare(`
      SELECT revision_before AS revisionBefore, revision_after AS revisionAfter,
             committed_at_ms AS committedAtMs
      FROM task_title_audit
      WHERE task_id = ? AND actor_user_id = ? AND area_id = ? AND restore_generation = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(taskId, actorUserId, detail.task.effectiveAreaId, expectedRestoreGeneration) as
      TargetPrivateTaskTitleAuditEvent[];
    const events: TargetPrivateTaskTitleAuditEvent[] = [];
    for (const event of rows) {
      if (!Number.isSafeInteger(event.revisionBefore) || event.revisionBefore < 0 ||
          !Number.isSafeInteger(event.revisionAfter) ||
          event.revisionAfter !== event.revisionBefore + 1 ||
          !Number.isSafeInteger(event.committedAtMs) || event.committedAtMs <= 0) {
        return { ok: false, reason: "query_failed" };
      }
      events.push({
        revisionBefore: event.revisionBefore,
        revisionAfter: event.revisionAfter,
        committedAtMs: event.committedAtMs,
      });
    }
    return { ok: true, events };
  } catch {
    return { ok: false, reason: "query_failed" };
  }
}
