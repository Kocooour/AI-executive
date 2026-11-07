/**
 * R2d.5b.0 — content-free, pure Attention lifecycle plan for the v22 schema.
 *
 * This is NOT an authorization check, writer, receipt, audit journal, HTTP
 * handler, or source of time/identity. The future pinned writer MUST fetch a
 * fresh eligible candidate and the raw v22 state row inside the same guarded
 * transaction, then check actor/session/Area/private epoch, restore generation,
 * source revision, attention epoch and row revision before applying any plan.
 *
 * Absence of a v22 state row means active, NOT an inferred persisted active
 * record. Absence of a candidate page entry is never resolution proof.
 */
import {attentionKey, type AttentionRuleId} from "./target-attention-read-model";
import {temporalCalendarOrdinal} from "./target-task-temporal-read-model";

export type TargetAttentionLifecycleState="active"|"snoozed"|"dismissed";
/** Exactly the state/revision fields stored by v22 for a hidden occurrence. */
export type TargetAttentionLifecycleRow={
  state:"snoozed"|"dismissed";
  snoozedUntilMs:number|null;
  revision:number;
};
/** Authoritative read snapshot; null row is the ONLY active representation. */
export type TargetAttentionLifecycleSnapshot={
  actorUserId:string;
  restoreGeneration:string;
  attentionKey:string;
  taskId:string;
  ruleId:AttentionRuleId;
  relevantOn:string;
  attentionEpoch:number;
  row:TargetAttentionLifecycleRow|null;
};
export type TargetAttentionLifecycleWitness={
  actorUserId:string;
  restoreGeneration:string;
  attentionEpoch:number;
  candidate:{
    attentionKey:string;taskId:string;ruleId:AttentionRuleId;
    relevantOn:string;sourceRevision:number;
  };
};
type Expected={
  nowMs:number;
  expectedSourceRevision:number;
  expectedAttentionEpoch:number;
  expectedLifecycleRevision:number|null;
};
export type TargetAttentionLifecycleAction=
  |(Expected&{kind:"snooze";untilMs:number})
  |(Expected&{kind:"dismiss"})
  |(Expected&{kind:"restore"})
  |(Expected&{kind:"recheck"});

export type TargetAttentionLifecycleAudit={
  fromState:TargetAttentionLifecycleState;
  toState:TargetAttentionLifecycleState;
  reason:"user_snoozed"|"user_dismissed"|"user_restored"|"snooze_expired";
  atMs:number;
};
/** An insert uses v22 revision=0; a delete removes the hidden row. There is
 * NO mutation that inserts an active row or writes sourceRevision/changedAtMs.
 * CAS captures the EXACT row + per-actor epoch observed by the trusted reader.
 * The writer MUST compare them again, in its own transaction; this plan proves
 * nothing about authorization or about the current state of the database. */
export type TargetAttentionLifecycleOutcome=
  |{ok:true;operation:"none"|"insert"|"delete";
    row:TargetAttentionLifecycleRow|null;
    visible:boolean;
    cas:{attentionEpoch:number;lifecycleRevision:number|null;sourceRevision:number};
    audit:TargetAttentionLifecycleAudit|null}
  |{ok:false;reason:"invalid"|"unavailable"|"stale"|"not-active"};

const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^tatt1:[a-f0-9]{64}$/;
const DAY=86_400_000;
const MAX_SNOOZE_MS=30*DAY;
const validRevision=(v:unknown):v is number=>
  typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&
  v<Number.MAX_SAFE_INTEGER;
const validMs=(v:unknown):v is number=>
  validRevision(v)&&v<=8_640_000_000_000_000;
// v22 permits the maximum safe integer for a stored snooze_until_ms,
// even though the JavaScript Date domain for a new command is narrower.
const validStoredUntil=(v:unknown):v is number=>
  typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
const validId=(v:unknown):v is string=>
  typeof v==="string"&&v.length>0&&v!=="."&&v!==".."&&
  Buffer.byteLength(v,"utf8")<=512&&!/[\u0000-\u001f\u007f]/.test(v);
const validRule=(v:unknown):v is AttentionRuleId=>
  v==="deadline_overdue"||v==="deadline_soon"||v==="planned_date_passed";
const obj=(v:unknown):v is Record<string,unknown>=>
  typeof v==="object"&&v!==null&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,expected:readonly string[]):boolean=>{
  const a=Object.keys(v).sort(),b=[...expected].sort();
  return a.length===b.length&&a.every((key,i)=>key===b[i]);
};
const snapshotFields=["actorUserId","restoreGeneration","attentionKey","taskId",
  "ruleId","relevantOn","attentionEpoch","row"] as const;
const rowFields=["state","snoozedUntilMs","revision"] as const;
const witnessFields=["actorUserId","restoreGeneration","attentionEpoch","candidate"] as const;
const candidateFields=["attentionKey","taskId","ruleId","relevantOn","sourceRevision"] as const;
const expectedFields=["kind","nowMs","expectedSourceRevision","expectedAttentionEpoch",
  "expectedLifecycleRevision"] as const;

function validBinding(snapshot:unknown,witness:unknown):boolean {
  if(!obj(snapshot)||!obj(witness)||!exact(snapshot,snapshotFields)||
    !exact(witness,witnessFields)||!obj(witness.candidate)||
    !exact(witness.candidate,candidateFields))return false;
  const c=witness.candidate,r=snapshot.row;
  if(typeof snapshot.actorUserId!=="string"||!ACTOR.test(snapshot.actorUserId)||
    typeof witness.actorUserId!=="string"||!ACTOR.test(witness.actorUserId)||
    typeof snapshot.restoreGeneration!=="string"||!UUID.test(snapshot.restoreGeneration)||
    typeof witness.restoreGeneration!=="string"||!UUID.test(witness.restoreGeneration)||
    !validId(snapshot.taskId)||!validId(c.taskId)||
    !validRule(snapshot.ruleId)||!validRule(c.ruleId)||
    typeof snapshot.relevantOn!=="string"||
    temporalCalendarOrdinal(snapshot.relevantOn)===null||
    typeof c.relevantOn!=="string"||temporalCalendarOrdinal(c.relevantOn)===null||
    typeof snapshot.attentionKey!=="string"||!KEY.test(snapshot.attentionKey)||
    typeof c.attentionKey!=="string"||!KEY.test(c.attentionKey)||
    !validRevision(snapshot.attentionEpoch)||!validRevision(witness.attentionEpoch)||
    !validRevision(c.sourceRevision))return false;
  if(r!==null&&(!obj(r)||!exact(r,rowFields)||
    !validRevision(r.revision)||
    !(r.state==="snoozed"||r.state==="dismissed")||
    (r.state==="snoozed"?
      !validStoredUntil(r.snoozedUntilMs):
      r.snoozedUntilMs!==null)))return false;
  return snapshot.attentionKey===attentionKey(snapshot.ruleId,snapshot.taskId,snapshot.relevantOn)&&
    c.attentionKey===attentionKey(c.ruleId,c.taskId,c.relevantOn);
}

/** No SQL runs here. The action and witnesses are server-created, not a
 * client-supplied actor, clock or permission. Epoch + nullable row revision
 * must be compared inside the future pinned writer (including after a delete
 * and reinsert where the row revision goes back to zero). */
export function planTargetAttentionLifecycle(
  snapshot:TargetAttentionLifecycleSnapshot,
  witness:TargetAttentionLifecycleWitness,
  action:TargetAttentionLifecycleAction,
):TargetAttentionLifecycleOutcome {
  if(!validBinding(snapshot,witness)||!obj(action)||
    !["snooze","dismiss","restore","recheck"].includes(String(action.kind))||
    !validMs(action.nowMs)||!validRevision(action.expectedSourceRevision)||
    !validRevision(action.expectedAttentionEpoch)||
    !(action.expectedLifecycleRevision===null||
      validRevision(action.expectedLifecycleRevision))||
    !exact(action,action.kind==="snooze"?
      [...expectedFields,"untilMs"]:expectedFields)||
    (action.kind==="snooze"&&
      (!validMs(action.untilMs)||action.untilMs<=action.nowMs||
        action.untilMs-action.nowMs>MAX_SNOOZE_MS)))
    return {ok:false,reason:"invalid"};

  // Indistinguishable foreign identity, store generation, task, rule or
  // occurrence — no row, candidate content or audit leaks from the outcome.
  if(snapshot.actorUserId!==witness.actorUserId||
    snapshot.restoreGeneration!==witness.restoreGeneration||
    snapshot.taskId!==witness.candidate.taskId||
    snapshot.ruleId!==witness.candidate.ruleId||
    snapshot.relevantOn!==witness.candidate.relevantOn||
    snapshot.attentionKey!==witness.candidate.attentionKey)
    return {ok:false,reason:"unavailable"};

  const revision=snapshot.row?.revision??null;
  if(snapshot.attentionEpoch!==witness.attentionEpoch||
    action.expectedAttentionEpoch!==snapshot.attentionEpoch||
    action.expectedLifecycleRevision!==revision||
    action.expectedSourceRevision!==witness.candidate.sourceRevision)
    return {ok:false,reason:"stale"};

  const cas={attentionEpoch:snapshot.attentionEpoch,
    lifecycleRevision:revision,sourceRevision:witness.candidate.sourceRevision};
  const row=snapshot.row;
  if(action.kind==="recheck"){
    // Expired hidden snooze is an active *view*, but its persisted row remains
    // until the pinned writer deletes it. Never fabricate an active row.
    if(row?.state==="snoozed"&&row.snoozedUntilMs!==null&&
      action.nowMs>=row.snoozedUntilMs){
      return {ok:true,operation:"delete",row:null,visible:true,cas,
        audit:{fromState:"snoozed",toState:"active",
          reason:"snooze_expired",atMs:action.nowMs}};
    }
    return {ok:true,operation:"none",row,visible:row===null,cas,audit:null};
  }
  if(action.kind==="restore"){
    if(row===null)return {ok:false,reason:"not-active"};
    return {ok:true,operation:"delete",row:null,visible:true,cas,
      audit:{fromState:row.state,toState:"active",
        reason:"user_restored",atMs:action.nowMs}};
  }
  if(row!==null)return {ok:false,reason:"not-active"};
  const next=action.kind==="snooze"?"snoozed":"dismissed";
  return {ok:true,operation:"insert",
    row:{state:next,snoozedUntilMs:action.kind==="snooze"?action.untilMs:null,
      revision:0},
    visible:false,cas,
    audit:{fromState:"active",toState:next,
      reason:action.kind==="snooze"?"user_snoozed":"user_dismissed",
      atMs:action.nowMs}};
}
