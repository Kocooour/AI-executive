/**
 * R2d.3e — v20 temporal reads on isolated staging only.
 * TRUSTED CALLER CONTRACT: use a preflighted, pinned read-only snapshot and a
 * session-verified actor. Do not expose this low-level selector directly to HTTP.
 * The returned Area witness MUST be checked against the live store before any
 * HTTP release. No write, UI, user-private today/when or production activation.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";
import type { TargetReadLinearization, TargetReadContributingArea } from "./target-task-read-model";

export type TemporalScope = "personal" | "shared" | "my-plan";
export type TemporalStatus = "all" | "open" | "completed";
export type TemporalTask = {
  id: string; title: string; projectId: string | null;
  areaId: string; areaKind: "private" | "shared";
  status: "open" | "completed"; completedAtMs: number | null; dueOn: string | null;
  /** Only present for shared tasks. Never disclose another member's user ID. */
  assignedToMe?: boolean;
};
export type TemporalTaskPage = {
  tasks: TemporalTask[]; hasMore: boolean; revision: string;
  linearization: TargetReadLinearization;
};
/** Internal snapshot-only witness, never returned to HTTP clients. */
export type TargetTemporalTaskLiveGuard = {
  taskId: string; projectId: string | null; areaId: string;
  taskRevision: number; parentRevision: number | null;
};
export type TemporalTaskDetail = {
  task: TemporalTask; linearization: TargetReadLinearization;
  guard: TargetTemporalTaskLiveGuard;
};

type Row = {
  id: string; title: string; projectId: string | null;
  areaId: string; areaKind: "private" | "shared";
  status: "open" | "completed"; completedAtMs: number | null; dueOn: string | null;
  assignedToMe: number; role: string | null; policyRevision: number;
  taskRevision: number; parentRevision: number | null;
};
type AreaRow = {
  areaId: string; areaKind: "private" | "shared";
  access: "private-owner" | "viewer" | "editor" | "admin";
  policyRevision: number; contentRevision: number;
};

const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validActor = (id: unknown): id is string => typeof id === "string" && ACTOR.test(id);
// v20 task IDs are SQLite TEXT primary keys, not constrained to opaque slugs.
// Previous R2 cursor/sync APIs already support leading/trailing whitespace,
// arbitrary Unicode, empty strings and multi-kilobyte IDs. Do not impose a new
// global store restriction through the temporal read path; SQL remains bound.
const validTaskId = (id: unknown): id is string => typeof id === "string";
const validGeneration = (g: unknown): g is string =>
  typeof g === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(g);
const finiteEpoch = (n: number) => Number.isSafeInteger(n) && n >= 0;

const FROM = `FROM tasks t
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
        AND member.role IN ('viewer','editor','admin')))`;

const SELECT = `SELECT t.id AS id,t.title AS title,t.project_id AS projectId,
    a.id AS areaId,a.kind AS areaKind,t.status AS status,
    t.completed_at_ms AS completedAtMs,t.due_on AS dueOn,
    CASE WHEN t.assignee_user_id = actor.id THEN 1 ELSE 0 END AS assignedToMe,
    member.role AS role,a.policy_revision AS policyRevision,
    t.revision AS taskRevision,p.revision AS parentRevision ${FROM}`;

const SCOPE = `AND ((? = 'personal' AND a.kind = 'private')
  OR (? = 'shared' AND a.kind = 'shared')
  OR (? = 'my-plan' AND (a.kind = 'private' OR
    (a.kind = 'shared' AND t.assignee_user_id = actor.id
      AND member.role IN ('editor','admin')))))`;

function taskFrom(row: Row): TemporalTask {
  return {
    id: row.id, title: row.title, projectId: row.projectId,
    areaId: row.areaId, areaKind: row.areaKind, status: row.status,
    completedAtMs: row.completedAtMs, dueOn: row.dueOn,
    ...(row.areaKind === "shared" ? { assignedToMe: row.assignedToMe === 1 } : {}),
  };
}
function validRow(row: Row): boolean {
  return validTaskId(row.id) && typeof row.title === "string" &&
    (row.projectId === null || typeof row.projectId === "string") &&
    typeof row.areaId === "string" && row.areaId.length > 0 &&
    (row.areaKind === "private" || row.areaKind === "shared") &&
    (row.status === "open" || row.status === "completed") &&
    ((row.status === "open" && row.completedAtMs === null) ||
      (row.status === "completed" && typeof row.completedAtMs === "number" &&
        finiteEpoch(row.completedAtMs))) &&
    (row.dueOn === null || (typeof row.dueOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.dueOn))) &&
    (row.assignedToMe === 0 || row.assignedToMe === 1) && finiteEpoch(row.policyRevision) &&
    finiteEpoch(row.taskRevision) && (row.projectId === null
      ? row.parentRevision === null : typeof row.parentRevision === "number" &&
        finiteEpoch(row.parentRevision));
}

/** Broad, conservative Area witness: includes empty authorized Areas.
 * This avoids omitting an Area if its last matching item is removed mid-page.
 */
function witness(db: DatabaseSync, actorId: string, scope: TemporalScope):
  { areas: AreaRow[]; linearization: TargetReadLinearization } | null {
  const result = db.prepare(`SELECT a.id AS areaId,a.kind AS areaKind,
      CASE WHEN a.kind='private' THEN 'private-owner' ELSE m.role END AS access,
      a.policy_revision AS policyRevision,a.content_revision AS contentRevision
    FROM areas a
    JOIN workspaces w ON w.id=a.workspace_id
    JOIN identities actor ON actor.id=?
    LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=actor.id
    WHERE a.owner_user_id=w.owner_user_id AND
      ((a.kind='private' AND w.kind='personal' AND a.owner_user_id=actor.id
          AND ? <> 'shared')
        OR (a.kind='shared' AND w.kind='shared'
          AND m.role IN ('viewer','editor','admin') AND ? <> 'personal'
          AND (? <> 'my-plan' OR m.role IN ('editor','admin'))))
    ORDER BY a.id COLLATE BINARY LIMIT ?`)
    .all(actorId, scope, scope, scope, MAX_SCOPED_READ_AREAS + 1) as AreaRow[];
  if (result.length > MAX_SCOPED_READ_AREAS || result.some(a =>
    !finiteEpoch(a.policyRevision) || !finiteEpoch(a.contentRevision) ||
    (a.areaKind === "private" && a.access !== "private-owner") ||
    (a.areaKind === "shared" && !["viewer","editor","admin"].includes(a.access)))) return null;
  const areas: TargetReadContributingArea[] = result.map(a => ({
    areaId: a.areaId, areaKind: a.areaKind, policyRevision: a.policyRevision, access: a.access,
  }));
  return { areas: result, linearization: { actorUserId: actorId, areas } };
}

/** Strictly bounded server-side page; offset is never an untrusted HTTP cursor. */
export function readAuthorizedTemporalTaskPage(db: DatabaseSync, request: {
  actorUserId: string; scope: TemporalScope; status: TemporalStatus;
  limit: number; offset: number; restoreGeneration: string;
}): TemporalTaskPage | null {
  if (!request || !validActor(request.actorUserId) ||
    !["personal","shared","my-plan"].includes(request.scope) ||
    !["all","open","completed"].includes(request.status) ||
    !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100 ||
    !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 1_000_000 ||
    !validGeneration(request.restoreGeneration)) return null;
  try {
    const observed = witness(db, request.actorUserId, request.scope);
    if (!observed) return null;
    const rows = db.prepare(`${SELECT} ${SCOPE}
      AND (? = 'all' OR t.status = ?)
      ORDER BY t.id COLLATE BINARY ASC, t.rowid ASC LIMIT ? OFFSET ?`)
      .all(request.actorUserId,request.scope,request.scope,request.scope,
        request.status,request.status,request.limit + 1,request.offset) as Row[];
    if (rows.some(row => !validRow(row))) return null;
    const authorized = new Set(observed.areas.map(a => a.areaId));
    if (rows.some(row => !authorized.has(row.areaId))) return null;
    const hash = createHash("sha256").update("lumi:r2d:temporal-page:v1\0")
      .update(JSON.stringify([request.restoreGeneration,request.scope,request.status]));
    for (const a of observed.areas) hash.update("\0").update(JSON.stringify([
      a.areaId,a.areaKind,a.access,a.policyRevision,a.contentRevision,
    ]));
    return {
      tasks: rows.slice(0,request.limit).map(taskFrom),hasMore:rows.length > request.limit,
      revision:hash.digest("hex"),linearization:observed.linearization,
    };
  } catch { return null; }
}

/** Single-task detail for any currently authorized member; no owner/other assignee leaks. */
export function readAuthorizedTemporalTaskDetail(
  db: DatabaseSync, actorUserId: string, taskId: string,
): TemporalTaskDetail | null {
  if (!validActor(actorUserId) || !validTaskId(taskId)) return null;
  try {
    const row = db.prepare(`${SELECT} AND t.id=? LIMIT 1`)
      .get(actorUserId,taskId) as Row | undefined;
    if (!row || !validRow(row)) return null;
    const access = row.areaKind === "private" ? "private-owner" : row.role;
    if (access !== "private-owner" && access !== "viewer" &&
      access !== "editor" && access !== "admin") return null;
    return { task: taskFrom(row), linearization: {
      actorUserId,areas:[{
        areaId:row.areaId,areaKind:row.areaKind,policyRevision:row.policyRevision,access,
      }],
    }, guard: {
      taskId:row.id,projectId:row.projectId,areaId:row.areaId,
      taskRevision:row.taskRevision,parentRevision:row.parentRevision,
    } };
  } catch { return null; }
}

/**
 * R2d.3j.1 — due-date-only deadline buckets. These are NOT the full product
 * Today/Upcoming views: personal user-private "when"/planned-day and calendar
 * commitments are intentionally absent. Caller supplies an explicit local
 * calendar date chosen in the actor's timezone; no server UTC clock or
 * untrusted timezone conversion occurs in this reader.
 */
export type TemporalDueWindow = "overdue" | "due-today" | "upcoming";
export type TemporalDueWindowPage = TemporalTaskPage & {
  window: TemporalDueWindow; evaluationDate: string; throughDate: string | null;
};

/** Gregorian calendar ordinal. Strict YYYY-MM-DD; no Date.parse rollovers. */
export function temporalCalendarOrdinal(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))
    return null;
  const year=Number(value.slice(0,4)), month=Number(value.slice(5,7));
  const day=Number(value.slice(8,10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1)
    return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if (day > monthDays[month-1]) return null;
  const y=year-1;
  return y*365 + Math.floor(y/4)-Math.floor(y/100)+Math.floor(y/400)
    + monthDays.slice(0,month-1).reduce((a,b)=>a+b,0) + day;
}

/**
 * A fully SQL-filtered, canonical bounded page of OPEN tasks with deadlines.
 * Overdue: due_on < evaluationDate; due-today: equal;
 * upcoming: evaluationDate < due_on <= throughDate (1–90 days ahead).
 * No post-pagination filtering, which could silently omit matching tasks.
 * Uses identical live Area witnesses and my-plan assignment gates as R2d.3e.
 */
export function readAuthorizedTemporalDueWindowPage(db: DatabaseSync, request: {
  actorUserId: string; scope: TemporalScope; window: TemporalDueWindow;
  evaluationDate: string; throughDate: string | null;
  limit: number; offset: number; restoreGeneration: string;
}): TemporalDueWindowPage | null {
  if (!request || !validActor(request.actorUserId) ||
      !["personal","shared","my-plan"].includes(request.scope) ||
      !["overdue","due-today","upcoming"].includes(request.window) ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100 ||
      !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 1_000_000 ||
      !validGeneration(request.restoreGeneration)) return null;
  const todayOrdinal=temporalCalendarOrdinal(request.evaluationDate);
  if (todayOrdinal===null) return null;
  const throughOrdinal=request.throughDate===null ? null :
    temporalCalendarOrdinal(request.throughDate);
  if (request.window==="upcoming"
      ? throughOrdinal===null || throughOrdinal-todayOrdinal<1 ||
        throughOrdinal-todayOrdinal>90
      : request.throughDate!==null) return null;
  try {
    const observed=witness(db,request.actorUserId,request.scope);
    if (!observed) return null;
    // Lexical comparison is correct for validated, zero-padded ISO dates.
    const predicate=request.window==="overdue" ? "t.due_on < ?" :
      request.window==="due-today" ? "t.due_on = ?" :
        "t.due_on > ? AND t.due_on <= ?";
    const parameters=request.window==="upcoming"
      ? [request.evaluationDate,request.throughDate]
      : [request.evaluationDate];
    const rows=db.prepare(SELECT+" "+SCOPE+
      " AND t.status='open' AND t.due_on IS NOT NULL AND "+predicate+
      " ORDER BY t.due_on COLLATE BINARY ASC,t.id COLLATE BINARY ASC,t.rowid ASC"+
      " LIMIT ? OFFSET ?").all(
        request.actorUserId,request.scope,request.scope,request.scope,
        ...parameters,request.limit+1,request.offset) as Row[];
    if (rows.some(row=>!validRow(row) || row.status!=="open" ||
        row.dueOn===null)) return null;
    const authorized=new Set(observed.areas.map(a=>a.areaId));
    if (rows.some(row=>!authorized.has(row.areaId))) return null;
    const hash=createHash("sha256").update("lumi:r2d:due-window-page:v1\0")
      .update(JSON.stringify([request.restoreGeneration,request.scope,request.window,
        request.evaluationDate,request.throughDate]));
    for (const a of observed.areas) hash.update("\0").update(JSON.stringify([
      a.areaId,a.areaKind,a.access,a.policyRevision,a.contentRevision,
    ]));
    return {
      tasks:rows.slice(0,request.limit).map(taskFrom),
      hasMore:rows.length>request.limit,
      revision:hash.digest("hex"),linearization:observed.linearization,
      window:request.window,evaluationDate:request.evaluationDate,
      throughDate:request.throughDate,
    };
  } catch { return null; }
}
