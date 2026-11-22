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
const {suggestInboxByRules}=await import("../lib/target-inbox-suggestions.ts");
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
    VALUES('alice','captured','2026-11-23')`).run();
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
function prepare(fx){
  const snapshot=readAuthorizedInboxSuggestionSnapshot(
    fx.db,"alice","captured",fx.stage.restoreGeneration);
  assert.ok(snapshot);
  const suggestion=suggestInboxByRules(snapshot.snapshot);
  assert.equal(suggestion.changes.projectId,"renovation");
  const now=Date.now(),timeZone="Europe/Prague";
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
