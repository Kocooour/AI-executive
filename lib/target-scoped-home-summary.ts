/**
 * R2d.3c staging Home inventory for Personal / Shared / My Plan.
 * Scope selects server-side policy, never actor/Area. This is NOT a
 * status, completion, Inbox, due, or attention summary.
 */
import { DatabaseSync } from "node:sqlite";
import { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";
import {
  HOME_SUMMARY_COUNT_CAP, eligibleMyPlanSummaryAreas,
  type HomeSummaryAreaEpoch,
} from "./target-my-plan-home-summary";
import type { TargetReadLinearization } from "./target-task-read-model";

export type TargetHomeScope = "personal" | "shared" | "my-plan";
export const SCOPED_HOME_KEYS = ["projects", "tasks"] as const;
export type ScopedHomeKey = typeof SCOPED_HOME_KEYS[number];
export type ScopedHomeValues = Record<ScopedHomeKey, number>;
export type ScopedHomeTruncated = Record<ScopedHomeKey, boolean>;
export type AuthorizedScopedHomeSummary = {
  scope: TargetHomeScope;
  counts: ScopedHomeValues;
  truncated: ScopedHomeTruncated;
  linearization: TargetReadLinearization;
  areaEpochs: HomeSummaryAreaEpoch[];
};
const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const safe = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

const privatePolicy = `a.kind='private' AND w.kind='personal'
  AND a.owner_user_id=actor.id AND w.owner_user_id=actor.id`;
const sharedPolicy = `a.kind='shared' AND w.kind='shared'
  AND a.owner_user_id=w.owner_user_id AND member.role IN ('viewer','editor','admin')`;
const writableSharedPolicy = `a.kind='shared' AND w.kind='shared'
  AND a.owner_user_id=w.owner_user_id AND member.role IN ('editor','admin')`;
const readableProject = `p.id NOT IN ('','.','..')
 AND length(CAST(p.id AS BLOB)) <= 512
 AND instr(CAST(p.id AS BLOB), x'00')=0
 AND p.id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')`;
const readableTask = `t.id NOT IN ('','.','..')
 AND length(CAST(t.id AS BLOB)) <= 512
 AND instr(CAST(t.id AS BLOB), x'00')=0
 AND t.id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')`;
type AreaRow = {
  areaId: string; areaKind: "private" | "shared";
  policyRevision: number; contentRevision: number; projectContentRevision: number;
  role: string | null;
};

/** Return ALL eligible Areas, even with no matching projects/tasks. */
export function eligibleScopedHomeSummaryAreas(
  db: DatabaseSync, actorUserId: string, scope: TargetHomeScope,
): HomeSummaryAreaEpoch[] | null {
  if (!ACTOR.test(actorUserId) ||
      (scope !== "personal" && scope !== "shared" && scope !== "my-plan"))
    return null;
  if (scope === "my-plan") return eligibleMyPlanSummaryAreas(db, actorUserId);
  try {
    const policy = scope === "personal" ? privatePolicy : sharedPolicy;
    const rows = db.prepare(`SELECT a.id AS areaId, a.kind AS areaKind,
      a.policy_revision AS policyRevision, a.content_revision AS contentRevision,
      a.project_content_revision AS projectContentRevision, member.role AS role
      FROM areas a JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members member ON member.area_id=a.id AND member.user_id=actor.id
      WHERE a.owner_user_id=w.owner_user_id AND (${policy})
      ORDER BY a.id COLLATE BINARY LIMIT ?`)
      .all(actorUserId, MAX_SCOPED_READ_AREAS + 1) as AreaRow[];
    if (rows.length > MAX_SCOPED_READ_AREAS) return null;
    const areas: HomeSummaryAreaEpoch[] = [];
    for (const row of rows) {
      if (typeof row.areaId !== "string" || !row.areaId ||
          row.areaKind !== (scope === "personal" ? "private" : "shared") ||
          !safe(row.policyRevision) || !safe(row.contentRevision) ||
          !safe(row.projectContentRevision)) return null;
      const access = row.areaKind === "private" ? "private-owner" :
        row.role === "viewer" || row.role === "editor" || row.role === "admin"
          ? row.role : null;
      if (!access) return null;
      areas.push({ areaId: row.areaId, areaKind: row.areaKind,
        policyRevision: row.policyRevision, contentRevision: row.contentRevision,
        projectContentRevision: row.projectContentRevision, access });
    }
    return areas;
  } catch {
    return null;
  }
}
const projectFrom = `FROM projects p JOIN areas a ON a.id=p.area_id
 JOIN workspaces w ON w.id=a.workspace_id
 JOIN identities actor ON actor.id=?
 LEFT JOIN area_members member ON member.area_id=a.id AND member.user_id=actor.id
 WHERE a.owner_user_id=w.owner_user_id AND ${readableProject}`;
const taskFrom = `FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
 JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
 JOIN workspaces w ON w.id=a.workspace_id
 JOIN identities actor ON actor.id=?
 LEFT JOIN area_members member ON member.area_id=a.id AND member.user_id=actor.id
 WHERE ((t.project_id IS NULL AND t.area_id IS NOT NULL)
 OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))
 AND a.owner_user_id=w.owner_user_id AND ${readableTask}`;
const sharedAssignedProject = `EXISTS (
 SELECT 1 FROM tasks child INDEXED BY tasks_by_project_assignee
 WHERE child.project_id=p.id AND child.area_id IS NULL
 AND child.assignee_user_id=actor.id)`;
const policies: Record<TargetHomeScope, Record<ScopedHomeKey, string>> = {
  personal: { projects: privatePolicy, tasks: privatePolicy },
  shared: { projects: sharedPolicy, tasks: sharedPolicy },
  "my-plan": {
    projects: `((${privatePolicy}) OR
      ((${writableSharedPolicy}) AND ${sharedAssignedProject}))`,
    tasks: `((${privatePolicy}) OR
      ((${writableSharedPolicy}) AND t.assignee_user_id=actor.id))`,
  },
};

/** Each COUNT reads at most 1001 authorized rows in the same pinned snapshot. */
export function readAuthorizedScopedHomeSummary(
  db: DatabaseSync, actorUserId: string, scope: TargetHomeScope,
): AuthorizedScopedHomeSummary | null {
  if (!ACTOR.test(actorUserId) ||
      (scope !== "personal" && scope !== "shared" && scope !== "my-plan"))
    return null;
  try {
    const areaEpochs = eligibleScopedHomeSummaryAreas(db, actorUserId, scope);
    if (!areaEpochs) return null;
    const counts = {} as ScopedHomeValues;
    const truncated = {} as ScopedHomeTruncated;
    for (const key of SCOPED_HOME_KEYS) {
      const from = key === "projects" ? projectFrom : taskFrom;
      const policy = policies[scope][key];
      const row = db.prepare(`SELECT COUNT(*) AS n FROM (
        SELECT 1 ${from} AND (${policy}) LIMIT ?)`)
        .get(actorUserId, HOME_SUMMARY_COUNT_CAP + 1) as { n: number } | undefined;
      if (!row || !safe(row.n) || row.n > HOME_SUMMARY_COUNT_CAP + 1)
        return null;
      counts[key] = Math.min(row.n, HOME_SUMMARY_COUNT_CAP);
      truncated[key] = row.n > HOME_SUMMARY_COUNT_CAP;
    }
    return {
      scope, counts, truncated, areaEpochs,
      linearization: { actorUserId, areas: areaEpochs.map(area => ({
        areaId: area.areaId, areaKind: area.areaKind,
        policyRevision: area.policyRevision, access: area.access,
      })) },
    };
  } catch {
    return null;
  }
}
