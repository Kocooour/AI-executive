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
export type TemporalTaskDetail = { task: TemporalTask; linearization: TargetReadLinearization };

type Row = {
  id: string; title: string; projectId: string | null;
  areaId: string; areaKind: "private" | "shared";
  status: "open" | "completed"; completedAtMs: number | null; dueOn: string | null;
  assignedToMe: number; role: string | null; policyRevision: number;
};
type AreaRow = {
  areaId: string; areaKind: "private" | "shared";
  access: "private-owner" | "viewer" | "editor" | "admin";
  policyRevision: number; contentRevision: number;
};

const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const validActor = (id: unknown): id is string => typeof id === "string" && ACTOR.test(id);
const validTaskId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.trim() === id &&
  Buffer.byteLength(id, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/.test(id);
const validGeneration = (g: unknown): g is string =>
  typeof g === "string" && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(g);
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
    member.role AS role,a.policy_revision AS policyRevision ${FROM}`;

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
  return (row.areaKind === "private" || row.areaKind === "shared") &&
    (row.status === "open" || row.status === "completed") &&
    ((row.status === "open" && row.completedAtMs === null) ||
      (row.status === "completed" && typeof row.completedAtMs === "number" &&
        finiteEpoch(row.completedAtMs))) &&
    (row.dueOn === null || (typeof row.dueOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.dueOn))) &&
    (row.assignedToMe === 0 || row.assignedToMe === 1) && finiteEpoch(row.policyRevision);
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
    } };
  } catch { return null; }
}
