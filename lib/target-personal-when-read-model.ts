/** R2d.3k.2 private planned-day read, staging-only; caller MUST authenticate actor
 * using one canonical preflighted pinned snapshot. Not an HTTP read or cursor. */
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {temporalCalendarOrdinal} from "./target-task-temporal-read-model";
import {MAX_SCOPED_READ_AREAS} from "./target-staging-read-limits";
import type {TargetReadLinearization} from "./target-task-read-model";

export type PersonalWhenWindow = "all" | "on-day" | "upcoming";
export type PersonalWhenItem = {taskId:string;whenOn:string;revision:number};
export type PersonalWhenPage = {
  plans:PersonalWhenItem[];hasMore:boolean;revision:string;privateEpoch:number;
  linearization:TargetReadLinearization;window:PersonalWhenWindow;
  evaluationDate:string|null;throughDate:string|null;
};
type Area={areaId:string;areaKind:"private"|"shared";
  access:"private-owner"|"editor"|"admin";policyRevision:number};
type Row=PersonalWhenItem & {areaId:string};
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const epoch=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;

/** Page filters are in SQL BEFORE pagination, with actor+ACL checks on every row.
 * The result is a private ID/day-only DTO; do not join shared task titles. */
export function readAuthorizedPersonalWhenPage(db:DatabaseSync,request:{
  actorUserId:string;window:PersonalWhenWindow;evaluationDate:string|null;
  throughDate:string|null;limit:number;offset:number;restoreGeneration:string;
}):PersonalWhenPage|null {
  if(!request||typeof request.actorUserId!=="string"||!ACTOR.test(request.actorUserId)||
    !["all","on-day","upcoming"].includes(request.window)||
    !Number.isSafeInteger(request.limit)||request.limit<1||request.limit>100||
    !Number.isSafeInteger(request.offset)||request.offset<0||request.offset>1_000_000||
    typeof request.restoreGeneration!=="string"||!UUID.test(request.restoreGeneration))
    return null;
  const day=request.evaluationDate===null?null:temporalCalendarOrdinal(request.evaluationDate);
  const end=request.throughDate===null?null:temporalCalendarOrdinal(request.throughDate);
  if(request.window==="all"?
      request.evaluationDate!==null||request.throughDate!==null:
     request.window==="on-day"?day===null||request.throughDate!==null:
     day===null||end===null||end-day<1||end-day>90) return null;
  try{
    const privateRow=db.prepare("SELECT revision FROM personal_plan_epochs WHERE user_id=?")
      .get(request.actorUserId) as {revision:number}|undefined;
    if(!privateRow||!epoch(privateRow.revision))return null;
    const areas=db.prepare("SELECT a.id AS areaId,a.kind AS areaKind,"+
      " CASE WHEN a.kind='private' THEN 'private-owner' ELSE m.role END AS access,"+
      " a.policy_revision AS policyRevision FROM areas a"+
      " JOIN workspaces w ON w.id=a.workspace_id"+
      " JOIN identities actor ON actor.id=?"+
      " LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=actor.id"+
      " WHERE a.owner_user_id=w.owner_user_id AND"+
      " ((a.kind='private' AND w.kind='personal' AND a.owner_user_id=actor.id) OR"+
      " (a.kind='shared' AND w.kind='shared' AND m.role IN ('editor','admin')))"+
      " ORDER BY a.id COLLATE BINARY LIMIT ?")
      .all(request.actorUserId,MAX_SCOPED_READ_AREAS+1) as Area[];
    if(!areas.length||areas.length>MAX_SCOPED_READ_AREAS||
      areas.some(a=>typeof a.areaId!=="string"||!a.areaId||!epoch(a.policyRevision)||
        (a.areaKind==="private"&&a.access!=="private-owner")||
        (a.areaKind==="shared"&&!["editor","admin"].includes(a.access))))return null;
    const predicate=request.window==="all"?"":request.window==="on-day"?
      " AND plan.when_on=?":" AND plan.when_on>? AND plan.when_on<=?";
    const dates=request.window==="all"?[]:request.window==="on-day"?
      [request.evaluationDate]:[request.evaluationDate,request.throughDate];
    const rows=db.prepare("SELECT plan.task_id AS taskId,plan.when_on AS whenOn,"+
      " plan.revision AS revision,a.id AS areaId FROM personal_task_plans plan"+
      " JOIN identities actor ON actor.id=plan.user_id"+
      " JOIN tasks t ON t.id=plan.task_id"+
      " LEFT JOIN projects p ON p.id=t.project_id"+
      " JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)"+
      " JOIN workspaces w ON w.id=a.workspace_id AND w.owner_user_id=a.owner_user_id"+
      " LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=actor.id"+
      " WHERE plan.user_id=? AND t.status='open' AND"+
      " ((a.kind='private' AND w.kind='personal' AND a.owner_user_id=actor.id) OR"+
      " (a.kind='shared' AND w.kind='shared' AND t.assignee_user_id=actor.id"+
      " AND m.role IN ('editor','admin')))"+predicate+
      " ORDER BY plan.when_on COLLATE BINARY ASC,plan.task_id COLLATE BINARY ASC"+
      " LIMIT ? OFFSET ?").all(request.actorUserId,...dates,request.limit+1,request.offset) as Row[];
    const allowed=new Set(areas.map(a=>a.areaId));
    if(rows.some(r=>typeof r.taskId!=="string"||temporalCalendarOrdinal(r.whenOn)===null||
      !epoch(r.revision)||!allowed.has(r.areaId)))return null;
    const hash=createHash("sha256").update("lumi:private-when-page:v1\0")
      .update(JSON.stringify([request.restoreGeneration,request.actorUserId,request.window,
        request.evaluationDate,request.throughDate,privateRow.revision]));
    for(const a of areas)hash.update("\0").update(JSON.stringify([
      a.areaId,a.areaKind,a.access,a.policyRevision]));
    return {plans:rows.slice(0,request.limit).map(r=>({
      taskId:r.taskId,whenOn:r.whenOn,revision:r.revision})),
      hasMore:rows.length>request.limit,revision:hash.digest("hex"),
      privateEpoch:privateRow.revision,window:request.window,
      evaluationDate:request.evaluationDate,throughDate:request.throughDate,
      linearization:{actorUserId:request.actorUserId,
        areas:areas.map(a=>({areaId:a.areaId,areaKind:a.areaKind,
          access:a.access,policyRevision:a.policyRevision}))}};
  }catch{return null;}
}
