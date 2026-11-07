/**
 * R2d.5b.0 — deterministic, content-free Attention lifecycle policy.
 *
 * Staging-only pure reducer, not a command, receipt, persistence layer, HTTP
 * route, permission check or authority. Call ONLY after a preflighted actor-
 * scoped candidate read AND a fresh live identity/Area/private-epoch guard.
 * A caller must never accept the witness/identity/clock from a browser.
 *
 * This slice does not infer resolution or supersession from a missing row:
 * absent pages can mean ACL revocation or incomplete pagination. The next
 * persistent slice must reconcile only from a complete authorized snapshot.
 */
import {attentionKey, type AttentionRuleId} from "./target-attention-read-model";
import {temporalCalendarOrdinal} from "./target-task-temporal-read-model";

export type TargetAttentionLifecycleState = "active"|"snoozed"|"dismissed";
export type TargetAttentionLifecycleRecord = {
  actorUserId:string;
  restoreGeneration:string;
  attentionKey:string;
  taskId:string;
  ruleId:AttentionRuleId;
  relevantOn:string;
  sourceRevision:number;
  state:TargetAttentionLifecycleState;
  snoozeUntilMs:number|null;
  changedAtMs:number;
};
export type TargetAttentionLifecycleWitness = {
  actorUserId:string;
  restoreGeneration:string;
  candidate:{
    attentionKey:string;taskId:string;ruleId:AttentionRuleId;
    relevantOn:string;sourceRevision:number;
  };
};
export type TargetAttentionLifecycleAction =
  | {kind:"snooze";nowMs:number;untilMs:number;
     expectedSourceRevision:number;expectedChangedAtMs:number}
  | {kind:"dismiss";nowMs:number;
     expectedSourceRevision:number;expectedChangedAtMs:number}
  | {kind:"recheck";nowMs:number};

export type TargetAttentionLifecycleAudit = {
  fromState:TargetAttentionLifecycleState;
  toState:TargetAttentionLifecycleState;
  reason:"user_snoozed"|"user_dismissed"|"snooze_expired";
  atMs:number;
};
export type TargetAttentionLifecycleOutcome =
  | {ok:true;record:TargetAttentionLifecycleRecord;
     change:"none"|"source-revision"|"state-transition";
     visible:boolean;audit:TargetAttentionLifecycleAudit|null}
  | {ok:false;reason:"invalid"|"unavailable"|"stale"|"not-active"};

const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^tatt1:[a-f0-9]{64}$/;
const DAY=86_400_000;
const MAX_SNOOZE_MS=30*DAY;
const validMs=(value:unknown):value is number=>
  typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000;
const validId=(value:unknown):value is string=>
  typeof value==="string"&&value.length>0&&value!== "."&&value!==".."&&
  Buffer.byteLength(value,"utf8")<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const validRule=(value:unknown):value is AttentionRuleId=>
  value==="deadline_overdue"||value==="deadline_soon"||
  value==="planned_date_passed";
const obj=(value:unknown):value is Record<string,unknown>=>
  typeof value==="object"&&value!==null&&!Array.isArray(value);
function exact(value:Record<string,unknown>,expected:readonly string[]):boolean {
  const a=Object.keys(value).sort(),b=[...expected].sort();
  return a.length===b.length&&a.every((key,i)=>key===b[i]);
}
const recordFields=["actorUserId","restoreGeneration","attentionKey","taskId",
  "ruleId","relevantOn","sourceRevision","state","snoozeUntilMs","changedAtMs"];
const witnessFields=["actorUserId","restoreGeneration","candidate"];
const candidateFields=["attentionKey","taskId","ruleId","relevantOn","sourceRevision"];

function validBinding(record:unknown,witness:unknown):boolean {
  if(!obj(record)||!obj(witness)||!exact(record,recordFields)||
    !exact(witness,witnessFields)||!obj(witness.candidate)||
    !exact(witness.candidate,candidateFields))return false;
  const c=witness.candidate;
  if(typeof record.actorUserId!=="string"||!ACTOR.test(record.actorUserId)||
    typeof witness.actorUserId!=="string"||!ACTOR.test(witness.actorUserId)||
    typeof record.restoreGeneration!=="string"||!UUID.test(record.restoreGeneration)||
    typeof witness.restoreGeneration!=="string"||!UUID.test(witness.restoreGeneration)||
    !validId(record.taskId)||!validId(c.taskId)||
    !validRule(record.ruleId)||!validRule(c.ruleId)||
    typeof record.relevantOn!=="string"||
    temporalCalendarOrdinal(record.relevantOn)===null||
    typeof c.relevantOn!=="string"||temporalCalendarOrdinal(c.relevantOn)===null||
    typeof record.attentionKey!=="string"||!KEY.test(record.attentionKey)||
    typeof c.attentionKey!=="string"||!KEY.test(c.attentionKey)||
    !validMs(record.sourceRevision)||!validMs(c.sourceRevision)||
    !validMs(record.changedAtMs)||
    !["active","snoozed","dismissed"].includes(String(record.state))||
    (record.state==="snoozed"
      ? !validMs(record.snoozeUntilMs)||record.snoozeUntilMs<=record.changedAtMs
      :record.snoozeUntilMs!==null))return false;
  // Cross-rule or cross-occurrence keys may never inherit old dismiss/snooze.
  return record.attentionKey===attentionKey(record.ruleId,record.taskId,record.relevantOn)&&
    c.attentionKey===attentionKey(c.ruleId,c.taskId,c.relevantOn);
}

/**
 * Produces only immutable-ish scalar state and content-free audit metadata.
 * This is a policy plan; the future SQLite writer must reverify and CAS
 * actor, restore generation, source revision and state INSIDE a pinned write.
 * No title, Area, auth token or other actor's metadata enter the output.
 */
export function planTargetAttentionLifecycle(
  record:TargetAttentionLifecycleRecord,
  witness:TargetAttentionLifecycleWitness,
  action:TargetAttentionLifecycleAction,
):TargetAttentionLifecycleOutcome {
  if(!validBinding(record,witness)||!obj(action)||
    !["snooze","dismiss","recheck"].includes(String(action.kind))||
    !validMs(action.nowMs)||action.nowMs<record.changedAtMs)
    return {ok:false,reason:"invalid"};
  // Deliberately ambiguous on actor/generation/key mismatches: never reveal
  // whether another user's record or an older restored store exists.
  if(record.actorUserId!==witness.actorUserId||
    record.restoreGeneration!==witness.restoreGeneration||
    record.taskId!==witness.candidate.taskId||
    record.ruleId!==witness.candidate.ruleId||
    record.relevantOn!==witness.candidate.relevantOn||
    record.attentionKey!==witness.candidate.attentionKey)
    return {ok:false,reason:"unavailable"};
  if(witness.candidate.sourceRevision<record.sourceRevision)
    return {ok:false,reason:"stale"};

  if(action.kind==="recheck"){
    if(!exact(action,["kind","nowMs"]))return {ok:false,reason:"invalid"};
    if(record.state==="snoozed"&&
      record.snoozeUntilMs!==null&&action.nowMs>=record.snoozeUntilMs){
      return {ok:true,record:{...record,state:"active",snoozeUntilMs:null,
        sourceRevision:witness.candidate.sourceRevision,changedAtMs:action.nowMs},
        change:"state-transition",visible:true,audit:{
          fromState:"snoozed",toState:"active",reason:"snooze_expired",atMs:action.nowMs,
        }};
    }
    const updated=witness.candidate.sourceRevision!==record.sourceRevision;
    return {ok:true,
      record:{...record,sourceRevision:witness.candidate.sourceRevision},
      change:updated?"source-revision":"none",
      visible:record.state==="active",audit:null};
  }

  if(action.kind==="snooze"){
    if(!exact(action,["kind","nowMs","untilMs","expectedSourceRevision",
      "expectedChangedAtMs"])||!validMs(action.untilMs)||
      action.untilMs<=action.nowMs||
      action.untilMs-action.nowMs>MAX_SNOOZE_MS)
      return {ok:false,reason:"invalid"};
  }else if(!exact(action,["kind","nowMs","expectedSourceRevision",
      "expectedChangedAtMs"]))return {ok:false,reason:"invalid"};

  if(!validMs(action.expectedSourceRevision)||!validMs(action.expectedChangedAtMs))
    return {ok:false,reason:"invalid"};
  if(action.expectedSourceRevision!==record.sourceRevision||
    action.expectedChangedAtMs!==record.changedAtMs||
    witness.candidate.sourceRevision!==record.sourceRevision)
    return {ok:false,reason:"stale"};
  if(record.state!=="active")return {ok:false,reason:"not-active"};

  const next=action.kind==="snooze"?"snoozed":"dismissed";
  return {ok:true,record:{
    ...record,state:next,
    snoozeUntilMs:action.kind==="snooze"?action.untilMs:null,
    changedAtMs:action.nowMs,
  },change:"state-transition",visible:false,audit:{
    fromState:"active",toState:next,
    reason:action.kind==="snooze"?"user_snoozed":"user_dismissed",
    atMs:action.nowMs,
  }};
}
