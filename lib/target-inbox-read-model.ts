/**
 * C-3a authorized target Inbox SELECT model.
 * Call only with a verified actor and a canonical-preflighted SQLite snapshot.
 * The caller must revalidate its identity/session generation before releasing
 * titles or counts. There is no legacy Inbox fallback.
 */
import type { DatabaseSync } from "node:sqlite";
import { eligibleGlobalTaskAreas } from "./target-global-task-read-model";
import {targetStoreRestoreGeneration} from "./target-task-write-preflight";
import {issueTargetInboxRevision} from "./target-inbox-command-identity";
import type { HomeSummaryAreaEpoch } from "./target-my-plan-home-summary";
import type { TargetReadLinearization } from "./target-task-read-model";

export type TargetInboxItem = {
  id: string;
  title: string;
  /** Completion does not change membership of the unprocessed Inbox. */
  status: "open" | "completed";
  triageRevision: number;
  taskRevision: number;
  effectiveAreaId: string;
  canProcess: boolean;
  /** Only actor-owned private open tasks can receive a C-3b proposal. */
  canSuggest: boolean;
  /** Actor-authorized CAS witness, never a capability. Viewers receive null. */
  expectedRevision: string | null;
};
export type TargetInboxPage = {
  items: TargetInboxItem[];
  count: number;
  nextCursor: string | null;
  /** INTERNAL: complete eligible Area set (including empty), checked before HTTP release. */
  linearization: TargetReadLinearization;
  areaEpochs: HomeSummaryAreaEpoch[];
};
export type TargetInboxPageRequest = {
  actorUserId: string;
  limit?: number;
  afterTaskId?: string | null;
};
type Row = {
  id: string; title: string; status: "open" | "completed"; triageRevision: number; taskRevision: number;
  effectiveAreaId: string; areaKind: "private" | "shared";
  ownerUserId: string; memberRole: string | null;
};
const actorIdOk = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 120 &&
  value.trim() === value && /^[A-Za-z0-9_.:@-]+$/.test(value);
const cursorOk = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && Buffer.byteLength(value,"utf8") <= 512 &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);

/**
 * Project tasks inherit the project's effective Area. A shared viewer is
 * counted and listed but has no action rights. Cross-actor private data and
 * post-revocation shared data are excluded by the identical SQL predicate
 * used in both the list and aggregate count.
 */
const AUTHORIZED_INBOX_FROM = [
  "FROM tasks t",
  "LEFT JOIN projects p ON p.id=t.project_id",
  "JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)",
  "JOIN workspaces w ON w.id=a.workspace_id",
  "JOIN identities actor ON actor.id=?",
  "LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=actor.id",
  "WHERE t.triage_state='unprocessed'",
  "AND ((t.project_id IS NULL AND t.area_id IS NOT NULL)",
  "  OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))",
  "AND w.owner_user_id=a.owner_user_id",
  "AND ((a.kind='private' AND w.kind='personal' AND a.owner_user_id=actor.id)",
  " OR (a.kind='shared' AND w.kind='shared' AND m.role IN ('viewer','editor','admin')))",
].join(" ");

const ROW_COLUMNS = [
  "SELECT t.id AS id,t.title AS title,t.status AS status,t.triage_revision AS triageRevision,",
  "t.revision AS taskRevision,a.id AS effectiveAreaId,a.kind AS areaKind,",
  "a.owner_user_id AS ownerUserId,m.role AS memberRole",
].join(" ");

export function readAuthorizedTargetInboxPage(
  db: DatabaseSync, request: TargetInboxPageRequest,
): TargetInboxPage | null {
  if (!request || !actorIdOk(request.actorUserId) ||
      (request.limit !== undefined &&
        (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) ||
      (request.afterTaskId != null && !cursorOk(request.afterTaskId))) return null;
  const limit = request.limit ?? 50;
  try {
    const areaEpochs = eligibleGlobalTaskAreas(db, request.actorUserId, "all");
    if (!areaEpochs) return null;
    const linearization: TargetReadLinearization = {
      actorUserId: request.actorUserId,
      areas: areaEpochs.map(a => ({areaId:a.areaId,areaKind:a.areaKind,
        access:a.access,policyRevision:a.policyRevision})),
    };
    const count = db.prepare(
      "SELECT COUNT(*) AS n " + AUTHORIZED_INBOX_FROM,
    ).get(request.actorUserId) as {n: number} | undefined;
    if (!count || !Number.isSafeInteger(count.n) || count.n < 0) return null;
    const cursorClause = request.afterTaskId ? " AND t.id COLLATE BINARY > ?" : "";
    const rows = db.prepare(
      ROW_COLUMNS + " " + AUTHORIZED_INBOX_FROM + cursorClause +
        " ORDER BY t.id COLLATE BINARY LIMIT ?",
    ).all(
      request.actorUserId,
      ...(request.afterTaskId ? [request.afterTaskId] : []),
      limit + 1,
    ) as Row[];
    const generation=targetStoreRestoreGeneration(db);
    if(!generation)return null;
    const items: TargetInboxItem[] = [];
    for (const row of rows.slice(0, limit)) {
      if (!row || typeof row.id !== "string" || typeof row.title !== "string" ||
          (row.status !== "open" && row.status !== "completed") ||
          typeof row.effectiveAreaId !== "string" ||
          !Number.isSafeInteger(row.triageRevision) || row.triageRevision < 0 ||
          !Number.isSafeInteger(row.taskRevision) || row.taskRevision < 0) return null;
      const canProcess = row.areaKind === "private" ||
        row.memberRole === "editor" || row.memberRole === "admin";
      const expectedRevision=canProcess?issueTargetInboxRevision(db,
        request.actorUserId,row.id,row.triageRevision,row.effectiveAreaId,generation):null;
      if (canProcess && !expectedRevision) return null;
      items.push({
        id: row.id, title: row.title, status: row.status,
        triageRevision: row.triageRevision, taskRevision: row.taskRevision,
        effectiveAreaId: row.effectiveAreaId,
        canProcess, canSuggest:canProcess&&row.areaKind==="private"&&row.status==="open", expectedRevision,
      });
    }
    return {items, count: count.n,
      nextCursor: rows.length > limit ? items[items.length - 1]?.id ?? null : null,
      linearization, areaEpochs};
  } catch { return null; }
}
