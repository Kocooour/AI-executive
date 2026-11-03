/**
 * R2d.3b: isolated staging Home "My Plan" inventory summary.
 * Counters are not due/active/completed totals (fields do not exist yet).
 * This selector receives a verified actor from the pinned read gateway ONLY.
 */
import { DatabaseSync } from "node:sqlite";
import { MAX_SCOPED_READ_AREAS } from "./target-staging-read-limits";
import type { TargetReadLinearization, TargetReadAreaAccess } from "./target-task-read-model";

export const HOME_SUMMARY_COUNT_CAP = 1000;
export const HOME_SUMMARY_KEYS = [
  "privateProjects", "assignedSharedProjects", "privateTasks", "assignedSharedTasks",
] as const;
export type HomeSummaryKey = typeof HOME_SUMMARY_KEYS[number];
export type HomeSummaryCounts = Record<HomeSummaryKey, number>;
export type HomeSummaryTruncated = Record<HomeSummaryKey, boolean>;
export type HomeSummaryAreaEpoch = {
  areaId: string; areaKind: "private" | "shared";
  policyRevision: number; contentRevision: number; projectContentRevision: number;
  access: TargetReadAreaAccess;
};
export type AuthorizedMyPlanHomeSummary = {
  counts: HomeSummaryCounts;
  truncated: HomeSummaryTruncated;
  linearization: TargetReadLinearization;
  areaEpochs: HomeSummaryAreaEpoch[];
};

const ACTOR = /^[A-Za-z0-9_.:@-]{1,120}$/;
const safe = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const privateAcl = `a.kind='private' AND w.kind='personal'
  AND a.owner_user_id=actor.id AND w.owner_user_id=actor.id`;
const sharedAcl = `a.kind='shared' AND w.kind='shared'
  AND a.owner_user_id=w.owner_user_id AND member.role IN ('editor','admin')`;
const acl = `a.owner_user_id=w.owner_user_id
  AND ((${privateAcl}) OR (${sharedAcl}))`;
const readableProject = `p.id NOT IN ('','.','..')
 AND length(CAST(p.id AS BLOB)) <= 512
 AND instr(CAST(p.id AS BLOB), x'00')=0
 AND p.id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')`;

type AreaRow = {
  areaId: string; areaKind: "private" | "shared";
  policyRevision: number; contentRevision: number; projectContentRevision: number;
  role: string | null;
};

/** Canonical authorized Area set is also re-read by the live HTTP release gate. */
export function eligibleMyPlanSummaryAreas(
  db: DatabaseSync, actorUserId: string,
): HomeSummaryAreaEpoch[] | null {
  if (!ACTOR.test(actorUserId)) return null;
  try {
    const areas = db.prepare(`SELECT a.id AS areaId, a.kind AS areaKind,
      a.policy_revision AS policyRevision, a.content_revision AS contentRevision,
      a.project_content_revision AS projectContentRevision, member.role AS role
      FROM areas a JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members member ON member.area_id=a.id AND member.user_id=actor.id
      WHERE ${acl} ORDER BY a.id COLLATE BINARY LIMIT ?`)
      .all(actorUserId, MAX_SCOPED_READ_AREAS + 1) as AreaRow[];
    if (areas.length > MAX_SCOPED_READ_AREAS) return null;
    const result: HomeSummaryAreaEpoch[] = [];
    for (const row of areas) {
      const access: TargetReadAreaAccess | null = row.areaKind === "private"
        ? "private-owner"
        : row.role === "editor" || row.role === "admin" ? row.role : null;
      if (!access || typeof row.areaId !== "string" || !row.areaId ||
          (row.areaKind !== "private" && row.areaKind !== "shared") ||
          !safe(row.policyRevision) || !safe(row.contentRevision) ||
          !safe(row.projectContentRevision)) return null;
      result.push({
        areaId: row.areaId, areaKind: row.areaKind,
        policyRevision: row.policyRevision,
        contentRevision: row.contentRevision,
        projectContentRevision: row.projectContentRevision, access,
      });
    }
    return result;
  } catch {
    return null;
  }
}

const areaOfTask = `FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
 JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
 JOIN workspaces w ON w.id=a.workspace_id
 JOIN identities actor ON actor.id=?
 LEFT JOIN area_members member ON member.area_id=a.id AND member.user_id=actor.id
 WHERE ((t.project_id IS NULL AND t.area_id IS NOT NULL)
   OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))
   AND a.owner_user_id=w.owner_user_id`;
const areaOfProject = `FROM projects p
 JOIN areas a ON a.id=p.area_id JOIN workspaces w ON w.id=a.workspace_id
 JOIN identities actor ON actor.id=?
 LEFT JOIN area_members member ON member.area_id=a.id AND member.user_id=actor.id
 WHERE a.owner_user_id=w.owner_user_id AND ${readableProject}`;
const queries: Record<HomeSummaryKey, string> = {
  privateProjects: `${areaOfProject} AND ${privateAcl}`,
  assignedSharedProjects: `${areaOfProject} AND ${sharedAcl}
    AND EXISTS (SELECT 1 FROM tasks t INDEXED BY tasks_by_project_assignee
      WHERE t.project_id=p.id AND t.area_id IS NULL
        AND t.assignee_user_id=actor.id)`,
  privateTasks: `${areaOfTask} AND ${privateAcl}`,
  assignedSharedTasks: `${areaOfTask} AND ${sharedAcl}
    AND t.assignee_user_id=actor.id`,
};

/** Every COUNT is capped at 1001 records; totals above 1000 are lower bounds. */
export function readAuthorizedMyPlanHomeSummary(
  db: DatabaseSync, actorUserId: string,
): AuthorizedMyPlanHomeSummary | null {
  if (!ACTOR.test(actorUserId)) return null;
  try {
    const areaEpochs = eligibleMyPlanSummaryAreas(db, actorUserId);
    if (!areaEpochs) return null;
    const counts = {} as HomeSummaryCounts;
    const truncated = {} as HomeSummaryTruncated;
    for (const key of HOME_SUMMARY_KEYS) {
      const result = db.prepare(`SELECT COUNT(*) AS n FROM (
        SELECT 1 ${queries[key]} LIMIT ?)`)
        .get(actorUserId, HOME_SUMMARY_COUNT_CAP + 1) as { n: number } | undefined;
      if (!result || !safe(result.n) || result.n > HOME_SUMMARY_COUNT_CAP + 1)
        return null;
      counts[key] = Math.min(result.n, HOME_SUMMARY_COUNT_CAP);
      truncated[key] = result.n > HOME_SUMMARY_COUNT_CAP;
    }
    return {
      counts, truncated, areaEpochs,
      linearization: { actorUserId, areas: areaEpochs.map(a => ({
        areaId: a.areaId, areaKind: a.areaKind, policyRevision: a.policyRevision,
        access: a.access,
      })) },
    };
  } catch {
    return null;
  }
}
