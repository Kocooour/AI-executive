/**
 * R2d.3m.1 — canonical task-only global Vše / Osobní / Sdílené read.
 *
 * Global "all" is NOT My Plan. It includes every task the actor can READ:
 * own private tasks plus ALL tasks in shared Areas of which the actor is a
 * current member (viewer/editor/admin), regardless of assignee.
 *
 * Staging only. Caller must use one authenticated, canonical preflighted
 * read snapshot. No HTTP, UI, calendar data, or production activation here.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {MAX_SCOPED_READ_AREAS} from "./target-staging-read-limits";
import {eligibleScopedHomeSummaryAreas} from "./target-scoped-home-summary";
import {temporalCalendarOrdinal} from "./target-task-temporal-read-model";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";
import type {TargetReadLinearization} from "./target-task-read-model";

export type TargetGlobalTaskScope="all"|"personal"|"shared";
export type TargetGlobalTask={
  id:string;title:string;projectId:string|null;areaId:string;
  areaKind:"private"|"shared";status:"open"|"completed";dueOn:string|null;
  /** Only this actor's assignment, never another person's ID. */
  assignedToMe?:boolean;
};
export type TargetGlobalTaskPage={
  scope:TargetGlobalTaskScope;tasks:TargetGlobalTask[];
  hasMore:boolean;revision:string;
  /** SERVER ONLY — the complete current Area set, including empty Areas. */
  linearization:TargetReadLinearization;
  /** SERVER ONLY — must be rechecked along with session/ACL before HTTP. */
  areaEpochs:HomeSummaryAreaEpoch[];
};
type Row={
  id:string;title:string;projectId:string|null;areaId:string;
  areaKind:"private"|"shared";status:"open"|"completed";dueOn:string|null;
  assigned:number;
};
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validNonnegative=(n:unknown)=>typeof n==="number"&&
  Number.isSafeInteger(n)&&n>=0;

/** All readable Areas, even when empty. The full set catches a newly granted
 * Area, and monotone content revisions catch reassignment, reparenting, title,
 * status and deadline changes between a pinned read and live release.
 *
 * "all" is the UNION of the existing canonical private and shared policies,
 * including viewer memberships. Use UTF-8 BINARY ordering (not JS UTF-16)
 * to match the live Area enumeration and SQLite cursor stability.
 */
export function eligibleGlobalTaskAreas(
  db:DatabaseSync,actorUserId:string,scope:TargetGlobalTaskScope,
):HomeSummaryAreaEpoch[]|null{
  if(typeof actorUserId!=="string"||!ACTOR.test(actorUserId)||
    !["all","personal","shared"].includes(scope))return null;
  const privateAreas=scope==="shared"?[]:
    eligibleScopedHomeSummaryAreas(db,actorUserId,"personal");
  const sharedAreas=scope==="personal"?[]:
    eligibleScopedHomeSummaryAreas(db,actorUserId,"shared");
  if(!privateAreas||!sharedAreas||
    privateAreas.length+sharedAreas.length>MAX_SCOPED_READ_AREAS)return null;
  const result=[...privateAreas,...sharedAreas].sort((a,b)=>
    Buffer.compare(Buffer.from(a.areaId),Buffer.from(b.areaId)));
  if(new Set(result.map(x=>x.areaId)).size!==result.length||
     result.some(a=>!validNonnegative(a.policyRevision)||
       !validNonnegative(a.contentRevision)||
       !validNonnegative(a.projectContentRevision)||
       (a.areaKind==="private"&&a.access!=="private-owner")||
       (a.areaKind==="shared"&&!["viewer","editor","admin"].includes(a.access))))
    return null;
  return result;
}

export function readAuthorizedGlobalTaskPage(
  db:DatabaseSync,request:{
    actorUserId:string;scope:TargetGlobalTaskScope;
    limit:number;offset:number;restoreGeneration:string;
  },
):TargetGlobalTaskPage|null{
  if(!request||typeof request.actorUserId!=="string"||
    !ACTOR.test(request.actorUserId)||
    !["all","personal","shared"].includes(request.scope)||
    !Number.isSafeInteger(request.limit)||request.limit<1||request.limit>100||
    !validNonnegative(request.offset)||request.offset>1_000_000||
    typeof request.restoreGeneration!=="string"||
    !UUID.test(request.restoreGeneration))return null;
  try {
    const areaEpochs=eligibleGlobalTaskAreas(db,request.actorUserId,request.scope);
    if(!areaEpochs)return null;
    // Every predicate is applied in SQLite BEFORE LIMIT/OFFSET. A viewer sees
    // shared tasks, including unassigned and assigned-to-another-person rows,
    // but the only released assignee information is "assignedToMe".
    const rows=db.prepare(`SELECT t.id AS id,t.title AS title,
      t.project_id AS projectId,a.id AS areaId,a.kind AS areaKind,
      t.status AS status,t.due_on AS dueOn,
      CASE WHEN t.assignee_user_id=actor.id THEN 1 ELSE 0 END AS assigned
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
      JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
      JOIN workspaces w ON w.id=a.workspace_id
      JOIN identities actor ON actor.id=?
      LEFT JOIN area_members member
        ON member.area_id=a.id AND member.user_id=actor.id
      WHERE ((t.project_id IS NULL AND t.area_id IS NOT NULL)
          OR (t.project_id IS NOT NULL AND t.area_id IS NULL AND p.id IS NOT NULL))
        AND a.owner_user_id=w.owner_user_id
        AND ((a.kind='private' AND w.kind='personal' AND a.owner_user_id=actor.id)
          OR (a.kind='shared' AND w.kind='shared'
              AND member.role IN ('viewer','editor','admin')))
        AND (?='all' OR (?='personal' AND a.kind='private')
             OR (?='shared' AND a.kind='shared'))
      ORDER BY t.id COLLATE BINARY ASC,t.rowid ASC
      LIMIT ? OFFSET ?`).all(
        request.actorUserId,request.scope,request.scope,request.scope,
        request.limit+1,request.offset,
      ) as unknown as Row[];
    const available=new Map(areaEpochs.map(a=>[a.areaId,a]));
    if(rows.some(r=>
      typeof r.id!=="string"||typeof r.title!=="string"||
      (r.projectId!==null&&typeof r.projectId!=="string")||
      typeof r.areaId!=="string"||!available.has(r.areaId)||
      r.areaKind!==available.get(r.areaId)?.areaKind||
      (r.status!=="open"&&r.status!=="completed")||
      (r.dueOn!==null&&
        (typeof r.dueOn!=="string"||temporalCalendarOrdinal(r.dueOn)===null))||
      (r.assigned!==0&&r.assigned!==1)))return null;
    const hash=createHash("sha256")
      .update("lumi:r2d:global-task-index:v1\0")
      .update(JSON.stringify([
        request.actorUserId,request.scope,request.restoreGeneration,
      ]));
    for(const a of areaEpochs)hash.update("\0").update(JSON.stringify([
      a.areaId,a.areaKind,a.access,a.policyRevision,
      a.contentRevision,a.projectContentRevision,
    ]));
    const tasks:TargetGlobalTask[]=rows.slice(0,request.limit).map(r=>({
      id:r.id,title:r.title,projectId:r.projectId,areaId:r.areaId,
      areaKind:r.areaKind,status:r.status,dueOn:r.dueOn,
      ...(r.areaKind==="shared"?{assignedToMe:r.assigned===1}:{}),
    }));
    return {
      scope:request.scope,tasks,hasMore:rows.length>request.limit,
      revision:hash.digest("hex"),
      linearization:{actorUserId:request.actorUserId,
        areas:areaEpochs.map(a=>({
          areaId:a.areaId,areaKind:a.areaKind,
          access:a.access,policyRevision:a.policyRevision,
        }))},
      areaEpochs,
    };
  }catch{return null;}
}
