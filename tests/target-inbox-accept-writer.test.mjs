import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test,after} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3b-accept-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
const originalDir=process.env.AI_EXECUTIVE_DATA_DIR;
const originalSecret=process.env.AI_EXECUTIVE_SESSION_SECRET;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
process.env.AI_EXECUTIVE_SESSION_SECRET="C-3b integration test secret (32+ bytes)";

const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {issueDurableTargetStagingSession,hashTargetStagingSessionToken,
  revokeDurableTargetStagingSession}=await import("../lib/target-staging-durable-session.ts");
const {readAuthorizedInboxSuggestionSnapshot}=
  await import("../lib/target-inbox-suggestion-snapshot.ts");
const {suggestInboxByRules,suggestInboxWithLocalToday}=
  await import("../lib/target-inbox-suggestions.ts");
const {sealInboxDisplayedAction,inboxLocalDate}=
  await import("../lib/target-inbox-suggestion-commitment.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");

const fixtures=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON;");
  db.prepare(`INSERT INTO areas
    (id,title,kind,workspace_id,owner_user_id)
    SELECT 'private:projects','Projekty','private',w.id,'alice'
    FROM workspaces w WHERE w.kind='personal' AND w.owner_user_id='alice'`).run();
  db.prepare(`INSERT INTO projects(id,area_id,title)
    VALUES('renovation','private:projects','Rekonstrukce')`).run();
  db.prepare(`INSERT INTO tasks(id,area_id,title)
    VALUES('captured',?,'Připravit rekonstrukce')`).run(stage.unassignedAreaId);
  db.prepare(`INSERT INTO personal_task_plans(user_id,task_id,when_on)
    VALUES('alice','captured','2030-01-01')`).run();
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const durable=issueDurableTargetStagingSession(store,"alice");
  assert.equal(durable.ok,true,JSON.stringify(durable));
  const sessionHash=hashTargetStagingSessionToken(durable.sessionToken);
  const authority=new TargetStagingSessionAuthority(store);
  const token=authority.issueWritable("alice").sessionToken;
  const fx={stage,db,store,authority,token,durable,sessionHash,key:randomBytes(32)};
  fixtures.push(fx);return fx;
}
after(()=>{
  for(const fx of fixtures){fx.authority.close();fx.db.close();}
  if(originalDir===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=originalDir;
  if(originalSecret===undefined)delete process.env.AI_EXECUTIVE_SESSION_SECRET;
  else process.env.AI_EXECUTIVE_SESSION_SECRET=originalSecret;
  rmSync(root,{recursive:true,force:true});
});
function prepare(fx,{today=false}={}){
  const snapshot=readAuthorizedInboxSuggestionSnapshot(
    fx.db,"alice","captured",fx.stage.restoreGeneration);
  assert.ok(snapshot);
  const now=Date.now(),timeZone=snapshot.timeZone;
  const suggestion=today
    ?suggestInboxWithLocalToday(snapshot.snapshot,inboxLocalDate(now,timeZone))
    :suggestInboxByRules(snapshot.snapshot);
  assert.equal(suggestion.changes.projectId,"renovation");
  const data={actorUserId:"alice",taskId:"captured",
    sessionTokenHash:fx.sessionHash,
    restoreGeneration:fx.stage.restoreGeneration,
    taskWriteRevision:snapshot.taskWriteRevision,
    taskRevision:snapshot.taskRevision,
    triageRevision:snapshot.triageRevision,
    candidateFingerprint:snapshot.candidateFingerprint,
    personalPlanEpoch:snapshot.personalPlanEpoch,
    personalWhenRevision:snapshot.personalWhenRevision,
    consentEpoch:0,dataScopeVersion:"c3b:v1",timeZone,
    notificationEpoch:snapshot.notificationEpoch,
    localDate:inboxLocalDate(now,timeZone),suggestion};
  const sealed=sealInboxDisplayedAction(data,fx.key,now);
  assert.ok(sealed);
  return {commandId:randomUUID(),taskId:"captured",
    token:sealed,displayedWhy:suggestion.why,
    displayedChanges:suggestion.changes,
    restoreGeneration:fx.stage.restoreGeneration};
}
const row=fx=>fx.db.prepare(`SELECT t.project_id AS projectId,
    t.area_id AS areaId,t.triage_state AS state,t.triaged_at AS triaged,
    t.triage_revision AS triageRevision,t.revision AS revision
    FROM tasks t WHERE t.id='captured'`).get();

test("C-3b receipt capacity reserves an Undo for every live Accept",async()=>{
  const {inboxCompoundLedgerHasCapacity}=await import(
    "../lib/target-inbox-accept-writer.ts");
  const allowed=inboxCompoundLedgerHasCapacity;
  assert.equal(allowed(0,0,"accept"),true);
  assert.equal(allowed(2048,2048,"accept"),true,
    "the previous 4096-row ceiling must not disable future Accepts");
  assert.equal(allowed(32255,32255,"accept"),true);
  assert.equal(allowed(32256,32256,"accept"),false,
    "terminal-cancel capacity must be reserved beyond all pending Undo slots");
  assert.equal(allowed(32768,32768,"accept"),false,
    "all remaining ledger slots belong to future Undo receipts");
  assert.equal(allowed(32768,32768,"undo"),true,
    "reserved Undo must still succeed at capacity");
  assert.equal(allowed(65535,0,"accept"),false);
  assert.equal(allowed(65535,0,"undo"),true);
  assert.equal(allowed(64512,0,"cancel"),true,
    "cancel remains available after new Accept admission is exhausted");
  assert.equal(allowed(65535,0,"cancel"),true);
  assert.equal(allowed(65536,0,"undo"),false);
  assert.equal(allowed(3000,3001,"undo"),false);
  const {inboxCompoundLedgerCapacity}=await import(
    "../lib/target-inbox-accept-writer.ts");
  assert.deepEqual(inboxCompoundLedgerCapacity(0,0),{
    limit:65536,used:0,reserved:0,remainingAccepts:32256,warning:false,
  });
  assert.equal(inboxCompoundLedgerCapacity(24000,24000).warning,false);
  assert.equal(inboxCompoundLedgerCapacity(24576,24576).warning,true);
  assert.equal(inboxCompoundLedgerCapacity(2048,4096),null);
});

test("C-3b canonical metadata accepts >4096 immutable terminal receipts without cleanup",async()=>{
  const {createHash}=await import("node:crypto");
  const {validateC3BMetadata,C3B_RECEIPT_MAX_ROWS}=
    await import("../lib/target-inbox-metadata-validation.ts");
  const actor="alice",generation="00000000-0000-4000-8000-000000000099";
  const rows=Array.from({length:4100},(_,i)=>{
    const commandId="00000000-0000-4000-8000-"+i.toString(16).padStart(12,"0");
    const hash=createHash("sha256").update(JSON.stringify([
      "lumi:c3b:compound-inbox-receipt:v1",actor,commandId,
    ])).digest("hex");
    return {key:"r3:c3b:accept:v1:"+hash,value:JSON.stringify({
      v:1,kind:"cancelled",actor,taskId:"captured",commandId,
      restoreGeneration:generation,cancelledAtMs:i+1,
    })};
  });
  assert.equal(validateC3BMetadata(rows,[actor]).valid,true,
    "old immutable tombstones must still pass expanded preflight");
  const over=Array.from({length:C3B_RECEIPT_MAX_ROWS+1},()=>rows[0]);
  assert.equal(validateC3BMetadata(over,[actor]).valid,false,
    "excessive stores must fail closed, never truncate receipt history");
});

test("C-3b canonical v27: Accept move + Process is one pinned command; Undo reverses both",()=>{
  const fx=fixture(),before=row(fx),command=prepare(fx);
  const beforePlan=fx.db.prepare(`SELECT when_on,revision FROM personal_task_plans
    WHERE user_id='alice' AND task_id='captured'`).get();
  const accept=()=>fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command,key:fx.key,sessionTokenHash:fx.sessionHash,
  });
  assert.deepEqual(accept(),{ok:true});
  const afterAccept=row(fx);
  assert.equal(afterAccept.projectId,"renovation");
  assert.equal(afterAccept.areaId,null,
    "the physical task Area must be null on a project assignment");
  assert.equal(afterAccept.state,"processed");
  assert.ok(afterAccept.triaged>0);
  assert.equal(afterAccept.triageRevision,before.triageRevision+1);
  assert.equal(afterAccept.revision,before.revision+2);
  assert.deepEqual(accept(),{ok:true,replayed:true});
  const receipt=fx.authority.readInboxSuggestionReceipt("alice",command);
  assert.equal(receipt?.status,"committed");
  assert.equal(receipt?.next?.expectedTaskRevision,afterAccept.revision);
  assert.equal(receipt?.next?.expectedTriageRevision,afterAccept.triageRevision);
  const afterPlan=fx.db.prepare(`SELECT when_on,revision FROM personal_task_plans
    WHERE user_id='alice' AND task_id='captured'`).get();
  assert.deepEqual(afterPlan,beforePlan,"only this actor's plan remains intact");
  const privateEpoch=fx.db.prepare(`SELECT revision FROM personal_plan_epochs
    WHERE user_id='alice'`).get().revision;
  const undo={commandId:randomUUID(),undoOfCommandId:command.commandId,
    taskId:"captured",restoreGeneration:fx.stage.restoreGeneration,
    expectedTaskRevision:afterAccept.revision,
    expectedTriageRevision:afterAccept.triageRevision,
    expectedPrivateEpoch:privateEpoch,
    expectedPlanRevision:afterPlan.revision};
  const revert=()=>fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"undo",command:undo,sessionTokenHash:fx.sessionHash,
  });
  assert.deepEqual(revert(),{ok:true});
  const undone=row(fx);
  assert.equal(undone.projectId,null);
  assert.equal(undone.areaId,before.areaId);
  assert.equal(undone.state,"unprocessed");
  assert.equal(undone.triaged,null);
  assert.equal(undone.triageRevision,afterAccept.triageRevision+1);
  assert.deepEqual(revert(),{ok:true,replayed:true});
  assert.deepEqual(fx.authority.readInboxSuggestionReceipt("alice",command),
    {status:"undone",next:null});
  assert.equal(fx.db.prepare(`SELECT COUNT(*) AS n FROM metadata
    WHERE key LIKE 'r3:c3b:%'`).get().n,2);
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
  const audit=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  assert.equal((audit.match(/"k":"task_triage"/g)||[]).length,2);
  assert.equal(audit.includes("Připravit rekonstrukce"),false);
});

for(const [timeZone,expectedDay] of [["UTC","2026-11-27"],["Europe/Prague","2026-11-28"]])
test("C-3b canonical v27: personal Today + project + triage, Undo restores date with monotonic revision ("+timeZone+")",t=>{
  t.mock.method(Date,"now",()=>Date.parse("2026-11-27T23:30:00Z"));
  const fx=fixture();
  fx.db.prepare("UPDATE personal_notification_settings SET time_zone=? WHERE user_id=?").run(timeZone,"alice");
  fx.db.prepare("UPDATE tasks SET title='Připravit rekonstrukce dnes' WHERE id='captured'").run();
  const original=row(fx);
  const originalPlan=fx.db.prepare("SELECT when_on,revision FROM personal_task_plans WHERE user_id='alice' AND task_id='captured'").get();
  const originalEpoch=fx.db.prepare("SELECT revision FROM personal_plan_epochs WHERE user_id='alice'").get().revision;
  const cmd=prepare(fx,{today:true});
  assert.equal(cmd.displayedChanges.whenOn,expectedDay);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:cmd,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  const accepted=row(fx);
  const acceptedPlan=fx.db.prepare("SELECT when_on,revision FROM personal_task_plans WHERE user_id='alice' AND task_id='captured'").get();
  const acceptedEpoch=fx.db.prepare("SELECT revision FROM personal_plan_epochs WHERE user_id='alice'").get().revision;
  assert.equal(acceptedPlan.when_on,cmd.displayedChanges.whenOn);
  assert.equal(acceptedPlan.revision,originalPlan.revision+1);
  assert.equal(acceptedEpoch,originalEpoch+1);
  assert.equal(accepted.projectId,"renovation");
  assert.equal(accepted.areaId,null);
  assert.equal(accepted.state,"processed");
  const undo={commandId:randomUUID(),undoOfCommandId:cmd.commandId,
    taskId:"captured",restoreGeneration:fx.stage.restoreGeneration,
    expectedTaskRevision:accepted.revision,
    expectedTriageRevision:accepted.triageRevision,
    expectedPrivateEpoch:acceptedEpoch,
    expectedPlanRevision:acceptedPlan.revision};
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"undo",command:undo,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  const reverted=row(fx);
  const revertedPlan=fx.db.prepare("SELECT when_on,revision FROM personal_task_plans WHERE user_id='alice' AND task_id='captured'").get();
  assert.equal(reverted.state,"unprocessed");
  assert.equal(reverted.projectId,original.projectId);
  assert.equal(reverted.areaId,original.areaId);
  assert.equal(revertedPlan.when_on,originalPlan.when_on);
  assert.equal(revertedPlan.revision,originalPlan.revision+2);
  assert.equal(fx.db.prepare("SELECT revision FROM personal_plan_epochs WHERE user_id='alice'").get().revision,originalEpoch+2);
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
});

test("C-3b canonical preflight rejects tampered compound receipt metadata",()=>{
  const fx=fixture(),command=prepare(fx);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  assert.equal(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}).ok,true);
  const row=fx.db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'r3:c3b:accept:v1:%'").get();
  assert.ok(row);
  const forged=JSON.parse(row.value);
  forged.actor="other";
  fx.db.prepare("UPDATE metadata SET value=? WHERE key=?")
    .run(JSON.stringify(forged),row.key);
  const inspected=inspectIsolatedTargetStore({...fx.store,mode:"r2-model"});
  assert.equal(inspected.ok,false);
  assert.ok(inspected.issues.includes("metadata_invalid"));
});

test("C-3b canonical v27: tamper and stale signed proposal cannot write",()=>{
  const fx=fixture(),cmd=prepare(fx),before=row(fx);
  const attempts=[
    {...cmd,displayedWhy:"Injected why"},
    {...cmd,displayedChanges:{...cmd.displayedChanges,projectId:"foreign"}},
    {...cmd,token:cmd.token.slice(0,-2)+"Aa"},
    {...cmd,restoreGeneration:randomUUID()},
  ];
  for(const attempt of attempts){
    const result=fx.authority.changeInboxSuggestedAction(fx.token,{
      mode:"accept",command:attempt,key:fx.key,sessionTokenHash:fx.sessionHash,
    });
    assert.equal(result.ok,false,JSON.stringify(result));
    assert.deepEqual(row(fx),before);
  }
  fx.db.prepare(`UPDATE projects SET title='Jiné jméno' WHERE id='renovation'`).run();
  const stale=fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:cmd,key:fx.key,sessionTokenHash:fx.sessionHash,
  });
  assert.deepEqual(stale,{ok:false,reason:"stale_revision"});
  assert.deepEqual(row(fx),before);
});

test("C-3b canonical v27: revoked durable session cannot accept",()=>{
  const fx=fixture(),cmd=prepare(fx);
  assert.equal(revokeDurableTargetStagingSession(
    fx.store,fx.durable.sessionId).ok,true);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:cmd,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:false,reason:"session_revoked"});
  assert.equal(row(fx).state,"unprocessed");
});

test("C-3b canonical v27: concurrent edit after Accept forbids Undo of other changes",()=>{
  const fx=fixture(),cmd=prepare(fx);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:cmd,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  const accepted=row(fx);
  fx.db.prepare("UPDATE tasks SET title='Jiné zadání' WHERE id='captured'").run();
  const epoch=fx.db.prepare(`SELECT revision FROM personal_plan_epochs
    WHERE user_id='alice'`).get().revision;
  const planRev=fx.db.prepare(`SELECT revision FROM personal_task_plans
    WHERE user_id='alice' AND task_id='captured'`).get().revision;
  const undo={commandId:randomUUID(),undoOfCommandId:cmd.commandId,
    taskId:"captured",restoreGeneration:fx.stage.restoreGeneration,
    expectedTaskRevision:accepted.revision,
    expectedTriageRevision:accepted.triageRevision,
    expectedPrivateEpoch:epoch,expectedPlanRevision:planRev};
  const result=fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"undo",command:undo,sessionTokenHash:fx.sessionHash,
  });
  assert.deepEqual(result,{ok:false,reason:"stale_revision"});
  assert.equal(row(fx).state,"processed");
});

test("C-3b: actor timezone revision is verified in same write transaction",()=>{
  const fx=fixture(),command=prepare(fx),before=row(fx);
  // A same-day zone change must invalidate the signed Today capability.
  // Notification preferences are authoritative, not a browser-provided zone.
  fx.db.prepare("UPDATE personal_notification_settings SET time_zone=? WHERE user_id=?")
    .run("Europe/London","alice");
  fx.db.prepare("UPDATE personal_notification_epochs SET revision=revision+1 WHERE user_id=?")
    .run("alice");
  const actual=fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command,key:fx.key,sessionTokenHash:fx.sessionHash,
  });
  assert.deepEqual(actual,{ok:false,reason:"stale_revision"});
  assert.deepEqual(row(fx),before);
});
test("C-3b recovery: lost Accept -> reload/query-only UUID -> durable terminal cancellation",()=>{
  const fx=fixture(),command=prepare(fx),before=row(fx);
  const query={commandId:command.commandId,taskId:command.taskId,
    restoreGeneration:command.restoreGeneration};
  assert.deepEqual(fx.authority.readInboxSuggestionReceipt("alice",query),
    {status:"not_recorded",next:null});
  const cancel=()=>fx.authority.cancelInboxSuggestedAction(
    fx.token,query,fx.sessionHash);
  assert.deepEqual(cancel(),{status:"cancelled",next:null});
  assert.deepEqual(cancel(),{status:"cancelled",next:null},
    "terminal cancellation is idempotent after a reload or worker restart");
  assert.deepEqual(fx.authority.readInboxSuggestionReceipt("alice",query),
    {status:"cancelled",next:null});
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:false,reason:"idempotency_conflict"},
    "late original Accept cannot commit after the terminal marker");
  assert.deepEqual(row(fx),before);
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
  // A later explicit suggestion can use a fresh UUID once cancellation is terminal.
  const fresh=prepare(fx);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:fresh,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
});

test("C-3b recovery: committed Accept wins the pinned lock before cancellation",()=>{
  const fx=fixture(),command=prepare(fx),query={
    commandId:command.commandId,taskId:command.taskId,
    restoreGeneration:command.restoreGeneration,
  };
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  const cancel=fx.authority.cancelInboxSuggestedAction(
    fx.token,query,fx.sessionHash);
  assert.equal(cancel?.status,"committed");
  assert.ok(cancel?.next,"winner must retain CAS for Undo");
  assert.equal(row(fx).state,"processed");
  assert.equal(fx.authority.readInboxSuggestionReceipt("alice",query)?.status,
    "committed","must not replace committed receipt with cancellation");
});

test("C-3b recovery: revoked actor session cannot cancel another UUID",()=>{
  const fx=fixture(),command=prepare(fx),query={
    commandId:command.commandId,taskId:command.taskId,
    restoreGeneration:command.restoreGeneration,
  };
  assert.equal(revokeDurableTargetStagingSession(
    fx.store,fx.durable.sessionId).ok,true);
  assert.equal(fx.authority.cancelInboxSuggestedAction(
    fx.token,query,fx.sessionHash),null);
  assert.deepEqual(fx.authority.readInboxSuggestionReceipt("alice",query),
    {status:"not_recorded",next:null});
});


test("C-3b P1: stale Undo can be terminally cancelled, never overwriting later edits",()=>{
  const fx=fixture(),cmd=prepare(fx);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:cmd,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  const original=fx.authority.readInboxSuggestionReceipt("alice",cmd);
  assert.equal(original.status,"committed");
  const undo={commandId:randomUUID(),undoOfCommandId:cmd.commandId,
    taskId:"captured",restoreGeneration:fx.stage.restoreGeneration,
    ...original.next};
  // Genuine newer task edit means the original CAS cannot safely Undo.
  fx.db.prepare("UPDATE tasks SET title='Novější zadání' WHERE id='captured'").run();
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"undo",command:undo,sessionTokenHash:fx.sessionHash,
  }),{ok:false,reason:"stale_revision"});
  const cancel=()=>fx.authority.cancelInboxSuggestedUndo(
    fx.token,undo,fx.sessionHash);
  assert.deepEqual(cancel(),{status:"undo_cancelled",next:null});
  assert.deepEqual(cancel(),{status:"undo_cancelled",next:null},
    "terminal cancellation must be idempotent across reloads");
  assert.deepEqual(fx.authority.readInboxSuggestionReceipt("alice",cmd),
    {status:"undo_cancelled",next:null});
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"undo",command:undo,sessionTokenHash:fx.sessionHash,
  }),{ok:false,reason:"idempotency_conflict"},
    "late original Undo must be rejected after the pinned cancellation");
  assert.equal(fx.db.prepare("SELECT title FROM tasks WHERE id='captured'").get().title,
    "Novější zadání");
  assert.equal(row(fx).state,"processed");
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
});

test("C-3b P1: successful Undo wins before a racing cancellation",()=>{
  const fx=fixture(),cmd=prepare(fx);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:cmd,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  const receipt=fx.authority.readInboxSuggestionReceipt("alice",cmd);
  const undo={commandId:randomUUID(),undoOfCommandId:cmd.commandId,
    taskId:"captured",restoreGeneration:fx.stage.restoreGeneration,
    ...receipt.next};
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"undo",command:undo,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  assert.deepEqual(fx.authority.cancelInboxSuggestedUndo(
    fx.token,undo,fx.sessionHash),{status:"undone",next:null});
  assert.equal(row(fx).state,"unprocessed");
});

test("C-3b P1: backwards wall clock cannot corrupt a committed Undo",()=>{
  const fx=fixture(),cmd=prepare(fx);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:cmd,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  const accepted=fx.authority.readInboxSuggestionReceipt("alice",cmd);
  const original=JSON.parse(fx.db.prepare(
    "SELECT value FROM metadata WHERE key LIKE 'r3:c3b:accept:v1:%'").get().value);
  const undo={commandId:randomUUID(),undoOfCommandId:cmd.commandId,
    taskId:"captured",restoreGeneration:fx.stage.restoreGeneration,...accepted.next};
  const clock=Date.now;
  try{
    Date.now=()=>original.committedAtMs-20;
    assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
      mode:"undo",command:undo,sessionTokenHash:fx.sessionHash,
    }),{ok:true});
  }finally{Date.now=clock;}
  const record=JSON.parse(fx.db.prepare(
    "SELECT value FROM metadata WHERE key LIKE 'r3:c3b:undo:v1:%'").get().value);
  assert.ok(record.committedAtMs>=original.committedAtMs);
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
});
test("C-3b P1: backwards wall clock cannot corrupt terminal Undo cancellation",()=>{
  const fx=fixture(),cmd=prepare(fx);
  assert.deepEqual(fx.authority.changeInboxSuggestedAction(fx.token,{
    mode:"accept",command:cmd,key:fx.key,sessionTokenHash:fx.sessionHash,
  }),{ok:true});
  const accepted=fx.authority.readInboxSuggestionReceipt("alice",cmd);
  const original=JSON.parse(fx.db.prepare(
    "SELECT value FROM metadata WHERE key LIKE 'r3:c3b:accept:v1:%'").get().value);
  const undo={commandId:randomUUID(),undoOfCommandId:cmd.commandId,
    taskId:"captured",restoreGeneration:fx.stage.restoreGeneration,...accepted.next};
  const clock=Date.now;
  try{
    Date.now=()=>original.committedAtMs-20;
    assert.deepEqual(fx.authority.cancelInboxSuggestedUndo(
      fx.token,undo,fx.sessionHash),{status:"undo_cancelled",next:null});
  }finally{Date.now=clock;}
  const record=JSON.parse(fx.db.prepare(
    "SELECT value FROM metadata WHERE key LIKE 'r3:c3b:undo:v1:%'").get().value);
  assert.ok(record.cancelledAtMs>=original.committedAtMs);
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
});
test("C-3b P1: rejected task ID with trailing space never poisons metadata",()=>{
  const fx=fixture();
  const invalid={commandId:randomUUID(),taskId:"captured ",
    restoreGeneration:fx.stage.restoreGeneration};
  assert.equal(fx.authority.cancelInboxSuggestedAction(
    fx.token,invalid,fx.sessionHash),null);
  assert.equal(fx.db.prepare(
    "SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'r3:c3b:%'").get().n,0);
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
});
