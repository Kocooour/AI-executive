/**
 * R2d.5a — authorized, actor-scoped Attention candidates (staging only).
 *
 * Internal, read-only selector: no HTTP, UI, schema change or push. It derives
 * deadline / planned-date candidates for ONE actor from exactly the My Plan
 * population (own private Areas + shared Areas where the actor is
 * editor/admin AND the task is assigned to the actor). Lifecycle state
 * (snooze/dismiss) is a later slice. One SQL statement applies ACL, rules,
 * ordering and pagination before any row is released.
 *
 * R2d.5b.1 adds the actor's own lifecycle state (snooze/dismiss, schema v22):
 * a `view` of "active" or "hidden" is applied in the same SQL BEFORE
 * ordering and pagination, joined strictly on the actor, so hidden items never
 * count towards paging or `hasMore` in the active view.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {MAX_SCOPED_READ_AREAS} from "./target-staging-read-limits";
import {temporalCalendarOrdinal} from "./target-task-temporal-read-model";
import type {TargetReadLinearization} from "./target-task-read-model";
import type {HomeSummaryAreaEpoch} from "./target-my-plan-home-summary";
import {endOfLocalDate,localDate} from "./attention";

export type AttentionAreaFilter="all"|"personal"|"shared";
export type AttentionView="active"|"hidden";
export type AttentionLifecycle="active"|"snoozed"|"dismissed";
export type AttentionRuleId="deadline_overdue"|"deadline_soon"|"planned_date_passed";
export type AttentionCandidate={
  attentionKey:string;subjectType:"task";taskId:string;title:string;
  projectId:string|null;areaId:string;areaKind:"private"|"shared";
  assignedToMe?:true;
  ruleId:AttentionRuleId;ruleVersion:1;severity:1|2|5;reasonCode:AttentionRuleId;
  relevantOn:string;relevantAt:number;dueOn:string|null;
  /** Only the actor's own planned day. */
  whenOn:string|null;thresholdHours:0|48;sourceRevision:number;
  /** Actor's own lifecycle; an expired snooze is "active" again. */
  lifecycle:AttentionLifecycle;
  /** Only for a currently snoozed item, else null. */
  snoozedUntilMs:number|null;
  /** State-row revision whenever the actor's row exists (incl. expired snooze), else null. */
  lifecycleRevision:number|null;
};
export type AttentionCandidatePage={
  items:AttentionCandidate[];hasMore:boolean;revision:string;
  evaluatedAtMs:number;timeZone:string;evaluationDate:string;
  soonThroughDate:string|null;areaFilter:AttentionAreaFilter;
  view:AttentionView;
  /** Internal-only: actor's attention epoch (live-guard witness). */
  attentionEpoch:number;
  /** Internal-only (never sent to clients): live session+Area+private-epoch check. */
  privateEpoch:number;linearization:TargetReadLinearization;
  areaEpochs:HomeSummaryAreaEpoch[];
};
type Area={areaId:string;areaKind:"private"|"shared";
  access:"private-owner"|"editor"|"admin";
  policyRevision:number;contentRevision:number;projectContentRevision:number};
type Row={taskId:string;title:string;projectId:string|null;areaId:string;
  areaKind:"private"|"shared";dueOn:string|null;whenOn:string|null;
  ruleId:string;severity:number;relevantOn:string;sourceRevision:number;
  lifeState:string|null;lifeUntil:number|null;lifeRevision:number|null};
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TZ=/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
const HOUR=3_600_000;
const safeInt=(n:unknown):n is number=>
  typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const addDays=(date:string,n:number)=>
  new Date(Date.parse(date+"T00:00:00Z")+n*86_400_000).toISOString().slice(0,10);

export type AttentionEvaluationWindow={evaluationDate:string;soonThroughDate:string|null};
/** Local evaluation date D and the largest date S whose all-day deadline ends
 * within 48 h (DST-correct). Shared by the selector and the lifecycle writer. */
export function attentionEvaluationWindow(nowMs:number,timeZone:string):AttentionEvaluationWindow|null {
  try {
    if(!safeInt(nowMs)||typeof timeZone!=="string"||timeZone.length<1||
      timeZone.length>64||!TZ.test(timeZone))return null;
    new Intl.DateTimeFormat("en-US",{timeZone});
    const D=localDate(nowMs,timeZone);
    if(temporalCalendarOrdinal(D)===null)return null;
    let S:string|null=null;
    for(const n of [0,1,2]){
      const d=addDays(D,n),end=endOfLocalDate(d,timeZone);
      if(end===null)return null;
      if(end-nowMs>=0&&end-nowMs<=48*HOUR)S=d;
    }
    return {evaluationDate:D,soonThroughDate:S};
  }catch{return null;}
}
/** Which rule (if any) currently fires for one task — the same CASE as the selector SQL. */
export function currentAttentionRule(dueOn:string|null,whenOn:string|null,
  w:AttentionEvaluationWindow):AttentionRuleId|null {
  const D=w.evaluationDate,S=w.soonThroughDate;
  if(dueOn!==null&&dueOn<D)return "deadline_overdue";
  if(dueOn!==null&&S!==null&&dueOn>=D&&dueOn<=S)return "deadline_soon";
  if(whenOn!==null&&whenOn<D&&!(dueOn!==null&&S!==null&&dueOn<=S))
    return "planned_date_passed";
  return null;
}

/** Stable per rule+task+occurrence; deliberately no actor/area/title/revision. */
export function attentionKey(ruleId:string,taskId:string,relevantOn:string):string {
  return "tatt1:"+createHash("sha256").update("lumi:r2d5:attention:v1\0")
    .update(JSON.stringify([ruleId,1,taskId,"date-"+relevantOn])).digest("hex");
}

export function readAuthorizedAttentionCandidatePage(db:DatabaseSync,request:{
  actorUserId:string;areaFilter:AttentionAreaFilter;view:AttentionView;
  evaluatedAtMs:number;
  timeZone:string;limit:number;offset:number;restoreGeneration:string;
}):AttentionCandidatePage|null {
  try {
    if(!request||typeof request.actorUserId!=="string"||!ACTOR.test(request.actorUserId)||
      !["all","personal","shared"].includes(request.areaFilter)||
      (request.view!=="active"&&request.view!=="hidden")||
      !safeInt(request.evaluatedAtMs)||
      typeof request.timeZone!=="string"||request.timeZone.length<1||
      request.timeZone.length>64||!TZ.test(request.timeZone)||
      !safeInt(request.limit)||request.limit<1||request.limit>100||
      !safeInt(request.offset)||request.offset>10_000||
      typeof request.restoreGeneration!=="string"||!UUID.test(request.restoreGeneration))
      return null;
    const tz=request.timeZone,now=request.evaluatedAtMs;
    const window=attentionEvaluationWindow(now,tz);
    if(!window)return null;
    const D=window.evaluationDate,S=window.soonThroughDate;
    const privateRow=db.prepare(
      "SELECT revision FROM personal_plan_epochs WHERE user_id=?"
    ).get(request.actorUserId) as {revision:number}|undefined;
    if(!privateRow||!safeInt(privateRow.revision))return null;
    // Missing or malformed attention epoch fails closed (as the plan epoch).
    const attRow=db.prepare(
      "SELECT revision FROM personal_attention_epochs WHERE user_id=?"
    ).get(request.actorUserId) as {revision:number}|undefined;
    if(!attRow||!safeInt(attRow.revision))return null;
    const attentionEpoch=attRow.revision;
    // A malformed own lifecycle row would match neither view and silently drop
    // a candidate: fail the whole read closed instead (preflight also rejects).
    const badLife=db.prepare(`SELECT COUNT(*) AS n FROM personal_attention_states
      WHERE user_id=? AND NOT (
        (state='dismissed' AND snoozed_until_ms IS NULL) OR
        (state='snoozed' AND typeof(snoozed_until_ms)='integer'
          AND snoozed_until_ms > 0 AND snoozed_until_ms <= 9007199254740991))
        OR (user_id=? AND (typeof(revision)<>'integer' OR revision < 0))`)
      .get(request.actorUserId,request.actorUserId) as {n:number}|undefined;
    if(!badLife||badLife.n!==0)return null;
    // Includes EMPTY accessible Areas so revocation during paging is detected.
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

    // $d = evaluation date, $s = soon-through date (or NULL: no soon items).
    const q=`WITH eligible AS (
      SELECT t.id AS taskId,t.title AS title,t.project_id AS projectId,
        a.id AS areaId,a.kind AS areaKind,t.due_on AS dueOn,
        plan.when_on AS whenOn,t.revision AS sourceRevision
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
    ), ruled AS (
      SELECT *,CASE
        WHEN dueOn IS NOT NULL AND dueOn < ? THEN 'deadline_overdue'
        WHEN dueOn IS NOT NULL AND ? IS NOT NULL AND dueOn >= ? AND dueOn <= ?
          THEN 'deadline_soon'
        WHEN whenOn IS NOT NULL AND whenOn < ? AND NOT
          (dueOn IS NOT NULL AND ? IS NOT NULL AND dueOn <= ?)
          THEN 'planned_date_passed' END AS ruleId
      FROM eligible
    ), keyed AS (
      SELECT taskId,title,projectId,areaId,areaKind,dueOn,whenOn,sourceRevision,ruleId,
        CASE ruleId WHEN 'deadline_overdue' THEN 1 WHEN 'deadline_soon' THEN 2
          ELSE 5 END AS severity,
        CASE ruleId WHEN 'planned_date_passed' THEN whenOn ELSE dueOn END AS relevantOn
      FROM ruled WHERE ruleId IS NOT NULL
    ), lifed AS (
      SELECT k.*,s.user_id AS lifeUser,s.state AS lifeState,
        s.snoozed_until_ms AS lifeUntil,s.revision AS lifeRevision
      FROM keyed k LEFT JOIN personal_attention_states s
        ON s.user_id=? AND s.task_id=k.taskId AND s.rule_id=k.ruleId
          AND s.occurrence_on=k.relevantOn
    ) SELECT taskId,title,projectId,areaId,areaKind,dueOn,whenOn,sourceRevision,ruleId,
        severity,relevantOn,lifeState,lifeUntil,lifeRevision
      FROM lifed
      WHERE (?='active' AND (lifeUser IS NULL OR
              (lifeState='snoozed' AND lifeUntil <= ?)))
         OR (?='hidden' AND (lifeState='dismissed' OR
              (lifeState='snoozed' AND lifeUntil > ?)))
      ORDER BY severity ASC,relevantOn COLLATE BINARY ASC,taskId COLLATE BINARY ASC
      LIMIT ? OFFSET ?`;
    const rows=db.prepare(q).all(request.actorUserId,
      request.areaFilter,request.areaFilter,request.areaFilter,
      D,S,D,S,D,S,S,request.actorUserId,request.view,now,request.view,now,
      request.limit+1,request.offset) as unknown as Row[];
    const available=new Set(areas.map(a=>a.areaId));
    const RULES:Record<string,number>={deadline_overdue:1,deadline_soon:2,planned_date_passed:5};
    const iso=(d:unknown):d is string=>typeof d==="string"&&temporalCalendarOrdinal(d)!==null;
    if(rows.some(r=>
      typeof r.taskId!=="string"||typeof r.title!=="string"||
      (r.projectId!==null&&typeof r.projectId!=="string")||
      !available.has(r.areaId)||(r.areaKind!=="private"&&r.areaKind!=="shared")||
      (r.dueOn!==null&&!iso(r.dueOn))||(r.whenOn!==null&&!iso(r.whenOn))||
      !safeInt(r.sourceRevision)||RULES[r.ruleId]!==r.severity||
      !iso(r.relevantOn)||
      r.relevantOn!==(r.ruleId==="planned_date_passed"?r.whenOn:r.dueOn)||
      !(r.lifeState===null?r.lifeUntil===null&&r.lifeRevision===null:
        safeInt(r.lifeRevision)&&(
          (r.lifeState==="dismissed"&&r.lifeUntil===null)||
          (r.lifeState==="snoozed"&&safeInt(r.lifeUntil)&&r.lifeUntil>0)))))
      return null;
    const lifecycleOf=(r:Row):AttentionLifecycle=>
      r.lifeState==="dismissed"?"dismissed":
      r.lifeState==="snoozed"&&(r.lifeUntil as number)>now?"snoozed":"active";
    if(rows.some(r=>(lifecycleOf(r)==="active")!==(request.view==="active")))
      return null;
    const items:AttentionCandidate[]=[];
    for(const r of rows.slice(0,request.limit)){
      const at=endOfLocalDate(r.relevantOn,tz);
      if(at===null)return null;
      const ruleId=r.ruleId as AttentionRuleId;
      items.push({
        attentionKey:attentionKey(ruleId,r.taskId,r.relevantOn),subjectType:"task",
        taskId:r.taskId,title:r.title,projectId:r.projectId,areaId:r.areaId,
        areaKind:r.areaKind,
        ...(r.areaKind==="shared"?{assignedToMe:true as const}:{}),
        ruleId,ruleVersion:1,severity:r.severity as 1|2|5,reasonCode:ruleId,
        relevantOn:r.relevantOn,relevantAt:at,dueOn:r.dueOn,whenOn:r.whenOn,
        thresholdHours:ruleId==="deadline_soon"?48:0,sourceRevision:r.sourceRevision,
        lifecycle:lifecycleOf(r),
        snoozedUntilMs:lifecycleOf(r)==="snoozed"?r.lifeUntil:null,
        // Any existing row (also an expired snooze) is the writer's CAS input.
        lifecycleRevision:r.lifeState===null?null:r.lifeRevision,
      });
    }
    const hash=createHash("sha256").update("lumi:r2d5:attention-candidates:v2\0")
      .update(JSON.stringify([
        request.restoreGeneration,request.actorUserId,request.areaFilter,
        request.view,now,tz,D,S,privateRow.revision,attentionEpoch,
      ]));
    for(const a of areas)hash.update("\0").update(JSON.stringify([
      a.areaId,a.areaKind,a.access,a.policyRevision,a.contentRevision,
      a.projectContentRevision,
    ]));
    return {
      items,hasMore:rows.length>request.limit,revision:hash.digest("hex"),
      evaluatedAtMs:now,timeZone:tz,evaluationDate:D,soonThroughDate:S,
      areaFilter:request.areaFilter,view:request.view,attentionEpoch,privateEpoch:privateRow.revision,
      linearization:{actorUserId:request.actorUserId,
        areas:areas.map(a=>({areaId:a.areaId,areaKind:a.areaKind,
          access:a.access,policyRevision:a.policyRevision}))},
      areaEpochs:areas.map(a=>({areaId:a.areaId,areaKind:a.areaKind,
        access:a.access,policyRevision:a.policyRevision,
        contentRevision:a.contentRevision,projectContentRevision:a.projectContentRevision})),
    };
  }catch{return null;}
}
