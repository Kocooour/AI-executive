/**
 * R2d.3l.1 — task-only, actor-private My Plan day buckets (staging only).
 *
 * This is not the full Today/Upcoming screen: calendar events, approved work
 * blocks and capacity are intentionally outside this canonical task selector.
 * One SQL statement applies ACL, date predicates, de-duplication and
 * pagination before any result is released.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {MAX_SCOPED_READ_AREAS} from "./target-staging-read-limits";
import {temporalCalendarOrdinal} from "./target-task-temporal-read-model";
import type {TargetReadLinearization} from "./target-task-read-model";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";

export type MyPlanTaskDayWindow="today"|"upcoming";
export type MyPlanTaskAreaFilter="all"|"personal"|"shared";
export type MyPlanDayTask={
  taskId:string;title:string;projectId:string|null;
  areaId:string;areaKind:"private"|"shared";
  /** Shared task has been assigned to this actor (never another actor ID). */
  assignedToMe?:true;
  dueOn:string|null;whenOn:string|null;
  /** Earliest deadline or the actor's personal planned day. */
  attentionOn:string;
};
export type MyPlanDayTaskPage={
  tasks:MyPlanDayTask[];hasMore:boolean;revision:string;
  window:MyPlanTaskDayWindow;areaFilter:MyPlanTaskAreaFilter;
  evaluationDate:string;throughDate:string|null;
  /** Internal-only: requires a LIVE session+Area+private-epoch check before HTTP. */
  privateEpoch:number;linearization:TargetReadLinearization;
  /** Full eligible My Plan Area content/policy epochs, for atomic live-release guard. */
  areaEpochs:HomeSummaryAreaEpoch[];
};
type Area={areaId:string;areaKind:"private"|"shared";
  access:"private-owner"|"editor"|"admin";
  policyRevision:number;contentRevision:number;projectContentRevision:number};
type Row=MyPlanDayTask & {plannedRevision:number|null};
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeInt=(n:unknown):n is number=>
  typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;

/** A task may be scheduled privately and have a different shared deadline.
 * The earlier date is its FIRST attention bucket, so it appears only once and
 * a future private plan cannot conceal a previously due shared deadline. */
const ATTENTION_DAY=`CASE
  WHEN plan.when_on IS NULL THEN t.due_on
  WHEN t.due_on IS NULL THEN plan.when_on
  WHEN plan.when_on <= t.due_on THEN plan.when_on
  ELSE t.due_on END`;

export function readAuthorizedMyPlanDayTaskPage(db:DatabaseSync,request:{
  actorUserId:string;areaFilter:MyPlanTaskAreaFilter;
  window:MyPlanTaskDayWindow;evaluationDate:string;throughDate:string|null;
  limit:number;offset:number;restoreGeneration:string;
}):MyPlanDayTaskPage|null {
  if(!request||typeof request.actorUserId!=="string"||!ACTOR.test(request.actorUserId)||
    !["all","personal","shared"].includes(request.areaFilter)||
    !["today","upcoming"].includes(request.window)||
    !safeInt(request.limit)||request.limit<1||request.limit>100||
    !safeInt(request.offset)||request.offset>1_000_000||
    typeof request.restoreGeneration!=="string"||!UUID.test(request.restoreGeneration))
    return null;
  const day=temporalCalendarOrdinal(request.evaluationDate);
  const end=request.throughDate===null?null:temporalCalendarOrdinal(request.throughDate);
  if(day===null||(request.window==="today"
    ?request.throughDate!==null
    :end===null||end-day<1||end-day>90))return null;
  try {
    const privateRow=db.prepare(
      "SELECT revision FROM personal_plan_epochs WHERE user_id=?"
    ).get(request.actorUserId) as {revision:number}|undefined;
    if(!privateRow||!safeInt(privateRow.revision))return null;
    // Covers EMPTY currently accessible Areas: joining only matching rows
    // would lose a revocation/reassignment during pagination.
    const areas=db.prepare(`SELECT a.id AS areaId,a.kind AS areaKind,
        CASE WHEN a.kind='private' THEN 'private-owner' ELSE m.role END AS access,
        a.policy_revision AS policyRevision,a.content_revision AS contentRevision,
        a.project_content_revision AS projectContentRevision
      FROM areas a JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=actor.id
      WHERE a.owner_user_id=w.owner_user_id AND
        ((a.kind='private' AND w.kind='personal' AND a.owner_user_id=actor.id)
         OR (a.kind='shared' AND w.kind='shared'
             AND m.role IN ('editor','admin')))
      ORDER BY a.id COLLATE BINARY LIMIT ?`)
      .all(request.actorUserId,MAX_SCOPED_READ_AREAS+1) as Area[];
    if(areas.length>MAX_SCOPED_READ_AREAS||
      areas.some(a=>typeof a.areaId!=="string"||!a.areaId||
        !safeInt(a.policyRevision)||!safeInt(a.contentRevision)||
        !safeInt(a.projectContentRevision)||
        (a.areaKind==="private"&&a.access!=="private-owner")||
        (a.areaKind==="shared"&&!["editor","admin"].includes(a.access))))
      return null;

    // One filtered SQL query: no offset paging independently over due and when,
    // no leaking a shared deadline of an unassigned task into My Plan.
    const q=`WITH eligible AS (
      SELECT t.id AS taskId,t.title AS title,t.project_id AS projectId,
        a.id AS areaId,a.kind AS areaKind,t.due_on AS dueOn,
        plan.when_on AS whenOn,plan.revision AS plannedRevision,
        ${ATTENTION_DAY} AS attentionOn
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
      JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
      JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=actor.id
      LEFT JOIN personal_task_plans plan
        ON plan.task_id=t.id AND plan.user_id=actor.id
      WHERE t.status='open'
        AND ((t.project_id IS NULL AND t.area_id IS NOT NULL)
          OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))
        AND ((a.kind='private' AND w.kind='personal' AND a.owner_user_id=actor.id)
          OR (a.kind='shared' AND w.kind='shared' AND
              m.role IN ('editor','admin') AND t.assignee_user_id=actor.id))
        AND (?='all' OR (?='personal' AND a.kind='private')
             OR (?='shared' AND a.kind='shared'))
    ) SELECT * FROM eligible
      WHERE attentionOn IS NOT NULL AND
        ${request.window==="today" ? "attentionOn <= ?" :
          "attentionOn > ? AND attentionOn <= ?"}
      ORDER BY attentionOn COLLATE BINARY ASC,taskId COLLATE BINARY ASC
      LIMIT ? OFFSET ?`;
    const dates=request.window==="today"
      ?[request.evaluationDate]
      :[request.evaluationDate,request.throughDate];
    const rows=db.prepare(q).all(request.actorUserId,
      request.areaFilter,request.areaFilter,request.areaFilter,
      ...dates,request.limit+1,request.offset) as unknown as Row[];
    const available=new Set(areas.map(a=>a.areaId));
    if(rows.some(row=>
      typeof row.taskId!=="string"||typeof row.title!=="string"||
      (row.projectId!==null&&typeof row.projectId!=="string")||
      !available.has(row.areaId)||
      (row.areaKind!=="private"&&row.areaKind!=="shared")||
      (row.dueOn!==null&&temporalCalendarOrdinal(row.dueOn)===null)||
      (row.whenOn!==null&&temporalCalendarOrdinal(row.whenOn)===null)||
      temporalCalendarOrdinal(row.attentionOn)===null||
      (row.whenOn===null?row.plannedRevision!==null:
        !safeInt(row.plannedRevision))||
      row.attentionOn!==[row.dueOn,row.whenOn]
        .filter((d):d is string=>d!==null).sort()[0]))
      return null;

    // A project-only content epoch must invalidate signed HTTP continuations,
    // even if this Area's task-content epoch did not change.
    const hash=createHash("sha256").update("lumi:r2d:my-plan-day-tasks:v2\0")
      .update(JSON.stringify([
        request.restoreGeneration,request.actorUserId,request.areaFilter,
        request.window,request.evaluationDate,request.throughDate,
        privateRow.revision,
      ]));
    for(const a of areas)hash.update("\0").update(JSON.stringify([
      a.areaId,a.areaKind,a.access,a.policyRevision,a.contentRevision,
      a.projectContentRevision,
    ]));
    return {
      tasks:rows.slice(0,request.limit).map(r=>({
        taskId:r.taskId,title:r.title,projectId:r.projectId,areaId:r.areaId,
        areaKind:r.areaKind,dueOn:r.dueOn,whenOn:r.whenOn,attentionOn:r.attentionOn,
        ...(r.areaKind==="shared"?{assignedToMe:true as const}:{}),
      })),
      hasMore:rows.length>request.limit,revision:hash.digest("hex"),
      privateEpoch:privateRow.revision,
      window:request.window,areaFilter:request.areaFilter,
      evaluationDate:request.evaluationDate,throughDate:request.throughDate,
      linearization:{actorUserId:request.actorUserId,
        areas:areas.map(a=>({areaId:a.areaId,areaKind:a.areaKind,
          access:a.access,policyRevision:a.policyRevision}))},
      areaEpochs:areas.map(a=>({areaId:a.areaId,areaKind:a.areaKind,
        access:a.access,policyRevision:a.policyRevision,
        contentRevision:a.contentRevision,projectContentRevision:a.projectContentRevision})),
    };
  }catch{return null;}
}
