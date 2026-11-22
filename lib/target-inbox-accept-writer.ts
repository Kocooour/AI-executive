/**
 * C-3b: atomic Inbox Accept/Undo on canonical pinned target SQLite.
 *
 * Deliberately NOT attached to HTTP/UI until the cross-process AI consent and
 * live-release gates are complete. AI proposals are explicitly rejected here;
 * a later integration must add the external revoke/target consent lock before
 * enabling them. Rule proposals can be accepted only with a valid sealed
 * displayed action, not regenerated AI/rule content.
 *
 * Both entry points use one pinned BEGIN IMMEDIATE transaction and one
 * content-free target journal intent. Receipts live in bounded namespaced
 * target metadata (v27) because the v27 C-3a receipts cannot represent
 * compound task relocation + triage revisions. Do not reuse those receipts.
 */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import type {TargetStagingReadCredential} from "./target-task-authenticated-read";
import {verifiedActor} from "./target-task-authenticated-read";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {fingerprint} from "./target-task-staging-writer";
import {lookupLiveTargetStagingSession,isTargetStagingSessionTokenHash}
  from "./target-staging-durable-session";
import {canEditIsolatedTargetTaskTitle,canWriteIsolatedTargetArea,
  targetStoreRestoreGeneration} from "./target-task-write-preflight";
import {readAuthorizedInboxSuggestionSnapshot}
  from "./target-inbox-suggestion-snapshot";
import {unsealInboxDisplayedAction}
  from "./target-inbox-suggestion-commitment";
import type {InboxSuggestedChanges} from "./target-inbox-suggestions";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const HEX=/^[a-f0-9]{64}$/;
const ACCEPT="r3:c3b:accept:v1:";
const UNDO="r3:c3b:undo:v1:";
const MAX_RECEIPTS=4096;

export type InboxAcceptCommand={
  commandId:string;taskId:string;restoreGeneration:string;
  token:string;displayedWhy:string;displayedChanges:InboxSuggestedChanges;
};
export type InboxAcceptUndoCommand={
  commandId:string;undoOfCommandId:string;taskId:string;
  restoreGeneration:string;
  expectedTaskRevision:number;expectedTriageRevision:number;
  expectedPrivateEpoch:number;expectedPlanRevision:number|null;
};
export type InboxAcceptResult=
  |{ok:true;replayed?:true}
  |{ok:false;reason:"invalid_request"|"unavailable"|"stale_revision"|
      "session_revoked"|"resync_required"|"idempotency_conflict"|"write_failed"};
type TaskRow={
  revision:number;triage_revision:number;triage_state:string;
  triaged_at:number|null;status:string;
  project_id:string|null;area_id:string|null;
};
type PlanRow={when_on:string;revision:number};
type Receipt={
  v:1;kind:"accept";actor:string;taskId:string;digest:string;
  commandId:string;restoreGeneration:string;
  before:{projectId:string|null;areaId:string|null;effectiveAreaId:string;whenOn:string|null;
    planRevision:number|null;taskRevision:number;triageRevision:number};
  after:{projectId:string|null;areaId:string|null;effectiveAreaId:string;whenOn:string|null;
    planRevision:number|null;taskRevision:number;triageRevision:number;
    triagedAtMs:number};
  committedAtMs:number;
};
const validEpoch=(n:unknown):n is number=>typeof n==="number"&&
  Number.isSafeInteger(n)&&n>=0;
const bad=(reason:Extract<InboxAcceptResult,{ok:false}>["reason"]):InboxAcceptResult=>
  ({ok:false,reason});
const validateAccept=(c:unknown):c is InboxAcceptCommand=>{
  if(!c||typeof c!=="object"||Array.isArray(c))return false;
  const x=c as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
    "commandId,displayedChanges,displayedWhy,restoreGeneration,taskId,token"&&
    typeof x.commandId==="string"&&UUID.test(x.commandId)&&
    typeof x.taskId==="string"&&TASK.test(x.taskId)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration)&&
    typeof x.token==="string"&&x.token.length<=8192&&x.token.length>0&&
    typeof x.displayedWhy==="string"&&x.displayedWhy.length<=512&&
    x.displayedChanges!==null&&typeof x.displayedChanges==="object"&&
    !Array.isArray(x.displayedChanges);
};
const validateUndo=(c:unknown):c is InboxAcceptUndoCommand=>{
  if(!c||typeof c!=="object"||Array.isArray(c))return false;
  const x=c as Record<string,unknown>;
  return Object.keys(x).sort().join(",")===
    "commandId,expectedPlanRevision,expectedPrivateEpoch,expectedTaskRevision,expectedTriageRevision,restoreGeneration,taskId,undoOfCommandId"&&
    typeof x.commandId==="string"&&UUID.test(x.commandId)&&
    typeof x.undoOfCommandId==="string"&&UUID.test(x.undoOfCommandId)&&
    x.commandId.toLowerCase()!==x.undoOfCommandId.toLowerCase()&&
    typeof x.taskId==="string"&&TASK.test(x.taskId)&&
    typeof x.restoreGeneration==="string"&&UUID.test(x.restoreGeneration)&&
    validEpoch(x.expectedTaskRevision)&&validEpoch(x.expectedTriageRevision)&&
    validEpoch(x.expectedPrivateEpoch)&&
    (x.expectedPlanRevision===null||validEpoch(x.expectedPlanRevision));
};
const receiptKey=(prefix:string,actor:string,id:string):string=>
  prefix+createHash("sha256").update(JSON.stringify([
    "lumi:c3b:compound-inbox-receipt:v1",actor,id.toLowerCase(),
  ])).digest("hex");
const acceptDigest=(c:InboxAcceptCommand):string=>
  createHash("sha256").update(JSON.stringify([
    "lumi:c3b:accept-command:v1",c.commandId.toLowerCase(),c.taskId,
    c.restoreGeneration.toLowerCase(),c.token,c.displayedWhy,
    // Canonical field order, independent of the browser's object key order.
    c.displayedChanges.whenOn,c.displayedChanges.projectId,
    c.displayedChanges.taskAreaId,c.displayedChanges.effectiveAreaId,
  ])).digest("hex");
const undoDigest=(c:InboxAcceptUndoCommand):string=>
  createHash("sha256").update(JSON.stringify([
    "lumi:c3b:undo-command:v1",c.commandId.toLowerCase(),
    c.undoOfCommandId.toLowerCase(),c.taskId,c.restoreGeneration.toLowerCase(),
    c.expectedTaskRevision,c.expectedTriageRevision,c.expectedPrivateEpoch,
    c.expectedPlanRevision,
  ])).digest("hex");
const currentTask=(db:DatabaseSync,id:string):TaskRow|undefined=>
  db.prepare("SELECT revision,triage_revision,triage_state,triaged_at,status,"+
    "project_id,area_id FROM tasks WHERE id=?").get(id) as TaskRow|undefined;
const currentPlan=(db:DatabaseSync,actor:string,id:string):PlanRow|undefined=>
  db.prepare("SELECT when_on,revision FROM personal_task_plans WHERE user_id=? AND task_id=?")
    .get(actor,id) as PlanRow|undefined;
const currentPrivateEpoch=(db:DatabaseSync,actor:string):number|null=>{
  const r=db.prepare("SELECT revision FROM personal_plan_epochs WHERE user_id=?")
    .get(actor) as {revision:number}|undefined;
  return r&&validEpoch(r.revision)?r.revision:null;
};
const storeReceipt=(db:DatabaseSync,key:string,receipt:object):void=>{
  db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
    .run(key,JSON.stringify(receipt));
};
const readReceipt=(db:DatabaseSync,key:string):Receipt|null=>{
  try{
    const row=db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(key) as {value:string}|undefined;
    if(!row||typeof row.value!=="string"||Buffer.byteLength(row.value)>2048)return null;
    const v:unknown=JSON.parse(row.value);
    if(!v||typeof v!=="object"||Array.isArray(v))return null;
    const a=v as Receipt;
    return a.v===1&&a.kind==="accept"&&typeof a.actor==="string"&&
      typeof a.taskId==="string"&&HEX.test(a.digest)&&
      UUID.test(a.commandId)&&UUID.test(a.restoreGeneration)&&
      validEpoch(a.committedAtMs)&&a.before!==null&&a.after!==null&&
      validEpoch(a.before.taskRevision)&&validEpoch(a.before.triageRevision)&&
      validEpoch(a.after.taskRevision)&&validEpoch(a.after.triageRevision)&&
      validEpoch(a.after.triagedAtMs)?a:null;
  }catch{return null;}
};
const checkCapacity=(db:DatabaseSync):boolean=>{
  const row=db.prepare(`SELECT COUNT(*) AS n FROM metadata WHERE
    substr(key,1,?)=? OR substr(key,1,?)=?`)
    .get(ACCEPT.length,ACCEPT,UNDO.length,UNDO) as {n:number};
  return validEpoch(row.n)&&row.n<MAX_RECEIPTS;
};
const sessionIsLive=(db:DatabaseSync,actor:string,hash:string|null):boolean=>
  hash===null||lookupLiveTargetStagingSession(db,hash,Date.now())?.userId===actor;

/** Internal core; call ONLY inside the canonical pinned BEGIN IMMEDIATE. */
function acceptLocked(db:DatabaseSync,actor:string,hash:string,
  c:InboxAcceptCommand,key:Uint8Array):InboxAcceptResult{
  if(targetStoreRestoreGeneration(db)!==c.restoreGeneration.toLowerCase())
    return bad("resync_required");
  // Read right first: a fabricated command cannot probe another actor's
  // old receipt, even if its UUID and target identity were guessed.
  if(!canEditIsolatedTargetTaskTitle(db,actor,c.taskId,true))
    return bad("unavailable");
  const keyId=receiptKey(ACCEPT,actor,c.commandId),digest=acceptDigest(c);
  const existing=readReceipt(db,keyId);
  if(existing)return existing.actor===actor&&existing.taskId===c.taskId&&
      existing.digest===digest?{ok:true,replayed:true}:bad("idempotency_conflict");
  if(db.prepare("SELECT 1 FROM metadata WHERE key=?").get(keyId))
    return bad("idempotency_conflict");
  if(!checkCapacity(db))return bad("write_failed");
  const proof=unsealInboxDisplayedAction(c.token,key,{
    actorUserId:actor,taskId:c.taskId,sessionTokenHash:hash,
    restoreGeneration:c.restoreGeneration,displayedChanges:c.displayedChanges,
    displayedWhy:c.displayedWhy,
  });
  if(!proof)return bad("stale_revision");
  // Only the entirely local rule slice is enabled until the external
  // consent/revoke barrier is integrated. Never accept a remotely sourced
  // proposal by treating it as a rule.
  if(proof.suggestion.source!=="rule"||proof.consentEpoch!==0)
    return bad("unavailable");
  const snapshot=readAuthorizedInboxSuggestionSnapshot(
    db,actor,c.taskId,c.restoreGeneration);
  if(!snapshot||snapshot.taskWriteRevision!==proof.taskWriteRevision||
     snapshot.candidateFingerprint!==proof.candidateFingerprint||
     snapshot.taskRevision!==proof.taskRevision||
     snapshot.triageRevision!==proof.triageRevision||
     snapshot.personalPlanEpoch!==proof.personalPlanEpoch||
     snapshot.personalWhenRevision!==proof.personalWhenRevision)
    return bad("stale_revision");
  const task=currentTask(db,c.taskId),plan=currentPlan(db,actor,c.taskId);
  if(!task||!validEpoch(task.revision)||!validEpoch(task.triage_revision)||
     task.triage_state!=="unprocessed"||task.triaged_at!==null||
     task.status!=="open"||task.revision!==snapshot.taskRevision||
     task.triage_revision!==snapshot.triageRevision||
     (plan?.when_on??null)!==snapshot.personalWhenOn)
    return bad("stale_revision");
  const before={projectId:task.project_id,areaId:task.area_id,
    effectiveAreaId:snapshot.snapshot.currentAreaId,
    whenOn:plan?.when_on??null,planRevision:plan?.revision??null,
    taskRevision:task.revision,triageRevision:task.triage_revision};
  const action=proof.suggestion.changes;
  // A new project requires exactly the inherited private Area, a standalone
  // Area move requires no existing project and must never detach implicitly.
  let nextProject=task.project_id,nextArea=task.area_id;
  if(action.projectId!=="unchanged"){
    const project=snapshot.snapshot.privateOpenProjects.find(
      p=>p.id===action.projectId);
    if(!project||project.areaId!==action.effectiveAreaId||
       action.taskAreaId!==null)return bad("unavailable");
    nextProject=project.id;
    nextArea=null;
  }else if(action.taskAreaId!=="unchanged"){
    if(task.project_id!==null||action.taskAreaId===null||
       action.effectiveAreaId!==action.taskAreaId||
       !snapshot.snapshot.privateAreas.some(a=>a.id===action.taskAreaId))
      return bad("unavailable");
    nextArea=action.taskAreaId;
  }
  if(action.whenOn!=="unchanged"&&action.whenOn!==proof.localDate)
    return bad("invalid_request");
  const nextWhen=action.whenOn==="unchanged"?before.whenOn:action.whenOn;
  const planning=nextWhen!==before.whenOn;
  const relocated=nextProject!==task.project_id||nextArea!==task.area_id;
  if(relocated){
    const moved=db.prepare(`UPDATE tasks SET project_id=?,area_id=?
      WHERE id=? AND revision=? AND project_id IS ? AND area_id IS ?`)
      .run(nextProject,nextArea,c.taskId,task.revision,
        task.project_id,task.area_id);
    if(moved.changes!==1)return bad("stale_revision");
  }
  if(planning){
    if(!plan){
      const inserted=db.prepare(`INSERT INTO personal_task_plans
        (user_id,task_id,when_on,revision) VALUES(?,?,?,0)`)
        .run(actor,c.taskId,nextWhen);
      if(inserted.changes!==1)return bad("write_failed");
    }else{
      const changedPlan=db.prepare(`UPDATE personal_task_plans SET when_on=?
        WHERE user_id=? AND task_id=? AND revision=? AND when_on=?`)
        .run(nextWhen,actor,c.taskId,plan.revision,plan.when_on);
      if(changedPlan.changes!==1)return bad("stale_revision");
    }
  }
  const now=Date.now();
  if(!Number.isSafeInteger(now)||now<=0)return bad("write_failed");
  const changed=db.prepare(`UPDATE tasks SET triage_state='processed',
    triaged_at=?,triage_revision=triage_revision+1
    WHERE id=? AND triage_state='unprocessed' AND triage_revision=?
      AND triaged_at IS NULL`).run(now,c.taskId,task.triage_revision);
  if(changed.changes!==1)return bad("stale_revision");
  const after=currentTask(db,c.taskId),afterPlan=currentPlan(db,actor,c.taskId);
  const expectedPlanRevision=planning?(plan?plan.revision+1:0):before.planRevision;
  const afterEpoch=currentPrivateEpoch(db,actor);
  if(!after||after.status!=="open"||after.triage_state!=="processed"||
     after.triaged_at!==now||
     after.triage_revision!==task.triage_revision+1||
     after.revision!==task.revision+(relocated?2:1)||
     after.project_id!==nextProject||after.area_id!==nextArea||
     (afterPlan?.when_on??null)!==nextWhen||
     (afterPlan?.revision??null)!==expectedPlanRevision||
     afterEpoch!==snapshot.personalPlanEpoch+(planning?1:0))
    return bad("write_failed");
  storeReceipt(db,keyId,{
    v:1,kind:"accept",actor,taskId:c.taskId,digest,
    commandId:c.commandId.toLowerCase(),
    restoreGeneration:c.restoreGeneration.toLowerCase(),before,
    after:{projectId:nextProject,areaId:nextArea,
      effectiveAreaId:action.effectiveAreaId==="unchanged"
        ?snapshot.snapshot.currentAreaId:action.effectiveAreaId,
      whenOn:afterPlan?.when_on??null,
      planRevision:afterPlan?.revision??null,
      taskRevision:after.revision,triageRevision:after.triage_revision,
      triagedAtMs:now},committedAtMs:now,
  } satisfies Receipt);
  return {ok:true};
}

/** Internal core; called exclusively under pinned BEGIN IMMEDIATE. */
function undoLocked(db:DatabaseSync,actor:string,c:InboxAcceptUndoCommand):InboxAcceptResult{
  if(targetStoreRestoreGeneration(db)!==c.restoreGeneration.toLowerCase())
    return bad("resync_required");
  if(!canEditIsolatedTargetTaskTitle(db,actor,c.taskId,true))
    return bad("unavailable");
  const original=readReceipt(db,receiptKey(ACCEPT,actor,c.undoOfCommandId));
  if(!original||original.actor!==actor||original.taskId!==c.taskId||
     original.restoreGeneration!==c.restoreGeneration.toLowerCase())
    return bad("stale_revision");
  const undoKey=receiptKey(UNDO,actor,c.undoOfCommandId);
  const digest=undoDigest(c);
  const previous=db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(undoKey) as {value:string}|undefined;
  if(previous){
    try{
      const r=JSON.parse(previous.value) as Record<string,unknown>;
      return r.digest===digest&&r.commandId===c.commandId.toLowerCase()
        ?{ok:true,replayed:true}:bad("idempotency_conflict");
    }catch{return bad("idempotency_conflict");}
  }
  if(!checkCapacity(db))return bad("write_failed");
  const task=currentTask(db,c.taskId),plan=currentPlan(db,actor,c.taskId);
  const epoch=currentPrivateEpoch(db,actor);
  if(!task||task.status!=="open"||
     task.triage_state!=="processed"||
     task.triaged_at!==original.after.triagedAtMs||
     task.revision!==original.after.taskRevision||
     task.triage_revision!==original.after.triageRevision||
     task.revision!==c.expectedTaskRevision||
     task.triage_revision!==c.expectedTriageRevision||
     task.project_id!==original.after.projectId||
     task.area_id!==original.after.areaId||
     (plan?.when_on??null)!==original.after.whenOn||
     (plan?.revision??null)!==original.after.planRevision||
     (plan?.revision??null)!==c.expectedPlanRevision||
     epoch===null||epoch!==c.expectedPrivateEpoch)
    return bad("stale_revision");
  const oldArea=original.before.projectId===null
    ?original.before.areaId
    :db.prepare("SELECT area_id AS areaId FROM projects WHERE id=?")
      .get(original.before.projectId)?.areaId;
  if(typeof oldArea!=="string"||
     oldArea!==original.before.effectiveAreaId||
     !canWriteIsolatedTargetArea(db,actor,oldArea,true))
    return bad("unavailable");
  if(original.before.projectId!==null){
    const project=db.prepare(`SELECT p.id FROM projects p
      JOIN areas a ON a.id=p.area_id
      JOIN workspaces w ON w.id=a.workspace_id
      WHERE p.id=? AND p.area_id=?
        AND a.kind='private' AND w.kind='personal'
        AND a.owner_user_id=? AND w.owner_user_id=?`)
      .get(original.before.projectId,oldArea,actor,actor);
    if(!project||original.before.areaId!==null)return bad("unavailable");
  }
  const liveEffectiveArea=task.project_id!==null
    ?db.prepare("SELECT area_id AS areaId FROM projects WHERE id=?")
      .get(task.project_id)?.areaId:task.area_id;
  if(liveEffectiveArea!==original.after.effectiveAreaId)return bad("stale_revision");
  const relocated=task.project_id!==original.before.projectId||
    task.area_id!==original.before.areaId;
  if(relocated){
    const r=db.prepare(`UPDATE tasks SET project_id=?,area_id=?
      WHERE id=? AND revision=? AND project_id IS ? AND area_id IS ?`)
      .run(original.before.projectId,original.before.areaId,
        c.taskId,task.revision,task.project_id,task.area_id);
    if(r.changes!==1)return bad("stale_revision");
  }
  const planning=original.before.whenOn!==original.after.whenOn;
  if(planning){
    if(original.before.whenOn===null){
      const removed=db.prepare(`DELETE FROM personal_task_plans
        WHERE user_id=? AND task_id=? AND revision=? AND when_on=?`)
        .run(actor,c.taskId,original.after.planRevision,original.after.whenOn);
      if(removed.changes!==1)return bad("stale_revision");
    }else{
      if(!plan||original.after.planRevision===null)return bad("stale_revision");
      const restored=db.prepare(`UPDATE personal_task_plans SET when_on=?
        WHERE user_id=? AND task_id=? AND revision=? AND when_on=?`)
        .run(original.before.whenOn,actor,c.taskId,
          original.after.planRevision,original.after.whenOn);
      if(restored.changes!==1)return bad("stale_revision");
    }
  }
  const r=db.prepare(`UPDATE tasks SET triage_state='unprocessed',
    triaged_at=NULL,triage_revision=triage_revision+1
    WHERE id=? AND triage_state='processed'
      AND triaged_at=? AND triage_revision=?`)
    .run(c.taskId,original.after.triagedAtMs,task.triage_revision);
  if(r.changes!==1)return bad("stale_revision");
  const after=currentTask(db,c.taskId),afterPlan=currentPlan(db,actor,c.taskId);
  const expectedRevertedPlanRevision=planning
    ?(original.before.whenOn===null?null:
        (original.after.planRevision as number)+1)
    :original.before.planRevision;
  if(!after||after.triage_state!=="unprocessed"||
     after.triaged_at!==null||
     after.revision!==task.revision+(relocated?2:1)||
     after.triage_revision!==task.triage_revision+1||
     after.project_id!==original.before.projectId||
     after.area_id!==original.before.areaId||
     (afterPlan?.when_on??null)!==original.before.whenOn||
     (afterPlan?.revision??null)!==expectedRevertedPlanRevision||
     currentPrivateEpoch(db,actor)!==epoch+(planning?1:0))
    return bad("write_failed");
  storeReceipt(db,undoKey,{
    v:1,kind:"undo",actor,taskId:c.taskId,
    commandId:c.commandId.toLowerCase(),
    undoOfCommandId:c.undoOfCommandId.toLowerCase(),digest,
    restoreGeneration:c.restoreGeneration.toLowerCase(),committedAtMs:Date.now(),
  });
  return {ok:true};
}

/**
 * Read-only reconciliation for an uncertain original Accept. A missing
 * receipt is NOT proof a still-running write cannot commit; clients must
 * preserve their original UUID and never issue an automatic replacement.
 * Call only on a pinned preflighted actor snapshot, and revalidate the live
 * session/ACL before exposing this status through any future HTTP route.
 */
export type InboxAcceptReceiptView={
  status:"committed"|"undone"|"not_recorded"|"conflict";
  next:{expectedTaskRevision:number;expectedTriageRevision:number;
    expectedPrivateEpoch:number;expectedPlanRevision:number|null}|null;
};
export function readInboxAcceptReceiptInSnapshot(
  db:DatabaseSync,actor:string,command:InboxAcceptCommand,
):InboxAcceptReceiptView|null{
  if(!validateAccept(command)||
     !canEditIsolatedTargetTaskTitle(db,actor,command.taskId,true)||
     targetStoreRestoreGeneration(db)!==command.restoreGeneration.toLowerCase())
    return null;
  try{
    const keyId=receiptKey(ACCEPT,actor,command.commandId);
    const old=readReceipt(db,keyId);
    if(!old){
      if(db.prepare("SELECT 1 FROM metadata WHERE key=?").get(keyId))
        return {status:"conflict",next:null};
      return {status:"not_recorded",next:null};
    }
    if(old.actor!==actor||old.taskId!==command.taskId||
       old.digest!==acceptDigest(command))
      return {status:"conflict",next:null};
    if(db.prepare("SELECT 1 FROM metadata WHERE key=?").get(
      receiptKey(UNDO,actor,command.commandId)))
      return {status:"undone",next:null};
    const row=currentTask(db,command.taskId);
    const plan=currentPlan(db,actor,command.taskId);
    const epoch=currentPrivateEpoch(db,actor);
    const next=row&&row.status==="open"&&row.triage_state==="processed"&&
      row.revision===old.after.taskRevision&&
      row.triage_revision===old.after.triageRevision&&
      row.triaged_at===old.after.triagedAtMs&&
      row.area_id===old.after.areaId&&
      row.project_id===old.after.projectId&&
      (plan?.when_on??null)===old.after.whenOn&&
      (plan?.revision??null)===old.after.planRevision&&
      epoch!==null?
        {expectedTaskRevision:row.revision,
          expectedTriageRevision:row.triage_revision,
          expectedPrivateEpoch:epoch,
          expectedPlanRevision:plan?.revision??null}:null;
    return {status:"committed",next};
  }catch{return null;}
}

type WriteMode={mode:"accept";command:InboxAcceptCommand;key:Uint8Array;
  sessionTokenHash:string}|{mode:"undo";command:InboxAcceptUndoCommand;
  sessionTokenHash:string};

/**
 * Single pinned command. The HTTP adapter MUST derive sessionTokenHash from
 * the authenticated cookie/session (never from the client body), and must not
 * call this from the event loop: use a bounded dedicated write worker.
 */
export function writePreflightedInboxSuggestedAction(
  store:TargetStagingReadStore,credential:TargetStagingReadCredential,
  work:WriteMode,
):InboxAcceptResult{
  if(!work||typeof work!=="object"||
     (work.mode==="accept"?!validateAccept(work.command):
       work.mode==="undo"?!validateUndo(work.command):true)||
     !isTargetStagingSessionTokenHash(work.sessionTokenHash))
    return bad("invalid_request");
  return withPinnedTargetStagingWrite<InboxAcceptResult>(store,ctx=>{
    const actor=verifiedActor(ctx.db,credential,true);
    if(!actor||!sessionIsLive(ctx.db,actor,work.sessionTokenHash))
      return bad("session_revoked");
    if(!ctx.stillPinned()||!ctx.noSidecars())return bad("unavailable");
    fingerprint(ctx.databaseFd);
    const result=work.mode==="accept"
      ?acceptLocked(ctx.db,actor,work.sessionTokenHash,work.command,work.key)
      :undoLocked(ctx.db,actor,work.command);
    if(!result.ok||result.replayed)return result;
    if(!sessionIsLive(ctx.db,actor,work.sessionTokenHash)||
       !ctx.stillPinned())return bad("session_revoked");
    if(!ctx.commit({kind:"task_triage",payload:{}}))return bad("write_failed");
    return result;
  },()=>bad("unavailable"),()=>bad("write_failed"));
}
