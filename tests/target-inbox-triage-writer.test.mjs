import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test,after} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3a-triage-writer-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
const beforeEnv=process.env.AI_EXECUTIVE_DATA_DIR;process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {validTargetInboxTriageCommand,readTargetInboxTriageReceipt}=
  await import("../lib/target-inbox-triage-writer.ts");
const fixtures=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice"});
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const actor of ["bob","cara"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(actor);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(actor,actor);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run("private:"+actor,actor,actor,actor);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for(const [actor,role] of [["alice","admin"],["bob","editor"],["cara","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(actor,role);
  db.prepare("INSERT INTO tasks(id,area_id,title,due_on) VALUES ('private',?,'Secret','2027-11-08')")
    .run(stage.unassignedAreaId);
  db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('shared','team-area','Shared task')").run();
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  const authority=new TargetStagingSessionAuthority(store);
  const fx={stage,db,store,authority};
  fixtures.push(fx);return fx;
}
after(()=>{
  for(const fx of fixtures){fx.authority.close();fx.db.close();}
  if(beforeEnv===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=beforeEnv;
  rmSync(root,{recursive:true,force:true});
});
function command(fx,token,taskId,mode="process",original=null,id=randomUUID()){
  const preview=fx.authority.previewTaskTitleEdit(token,{taskId});
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const row=fx.db.prepare("SELECT triage_revision,COALESCE(t.area_id,p.area_id) AS area FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?")
    .get(taskId);
  return {commandId:id,taskId,mode,undoOfCommandId:original,
    expectedRevision:preview.snapshotRevision,expectedTriageRevision:row.triage_revision,
    writeAreaId:row.area,restoreGeneration:fx.stage.restoreGeneration};
}
const denied=reason=>({ok:false,reason});
const read=(fx,id)=>fx.db.prepare(
  "SELECT triage_state,triaged_at,triage_revision,revision,due_on,area_id,status FROM tasks WHERE id=?").get(id);
const count=fx=>fx.db.prepare("SELECT COUNT(*) AS n FROM task_triage_receipts").get().n;

test("Process and exact Undo are atomic, idempotent, with no changes to dueOn or Area",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const before=read(fx,"private");
  const process=command(fx,token,"private");
  assert.equal(validTargetInboxTriageCommand(process),true);
  assert.deepEqual(fx.authority.changeInboxTriage(token,process),{ok:true});
  const processed=read(fx,"private");
  assert.equal(processed.triage_state,"processed");
  assert.ok(processed.triaged_at>0);
  assert.equal(processed.triage_revision,before.triage_revision+1);
  assert.equal(processed.revision,before.revision+1);
  for(const field of ["due_on","area_id","status"])
    assert.equal(processed[field],before[field],field);
  assert.equal(count(fx),1);
  assert.deepEqual(fx.authority.changeInboxTriage(token,process),{ok:true,replayed:true});
  assert.equal(count(fx),1);
  assert.deepEqual(fx.authority.changeInboxTriage(token,{...process,writeAreaId:"other"}),
    denied("unavailable"),"failed Area authorization takes precedence over receipt");
  assert.deepEqual(fx.authority.changeInboxTriage(token,{...process,mode:"undo",undoOfCommandId:randomUUID()}),
    denied("idempotency_conflict"));
  assert.equal(readTargetInboxTriageReceipt(fx.db,"alice",process),"committed");
  const undo=command(fx,token,"private","undo",process.commandId);
  assert.deepEqual(fx.authority.changeInboxTriage(token,undo),{ok:true});
  const undone=read(fx,"private");
  assert.equal(undone.triage_state,"unprocessed");
  assert.equal(undone.triaged_at,null);
  assert.equal(undone.triage_revision,processed.triage_revision+1);
  assert.equal(undone.revision,processed.revision+1);
  assert.equal(undone.due_on,before.due_on);
  assert.equal(count(fx),2);
  assert.deepEqual(fx.authority.changeInboxTriage(token,undo),{ok:true,replayed:true});
  assert.deepEqual(fx.authority.changeInboxTriage(token,
    command(fx,token,"private","undo",process.commandId)),denied("stale_revision"));
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
  const audit=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  assert.equal((audit.match(/"k":"task_triage"/g)??[]).length,2);
  assert.equal(audit.includes("Secret"),false);
});

test("stale task/triage revisions, invalid shape and replay with another ID do not write",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const cmd=command(fx,token,"private");
  assert.equal(validTargetInboxTriageCommand({...cmd,actorUserId:"alice"}),false);
  assert.equal(validTargetInboxTriageCommand({...cmd,undoOfCommandId:randomUUID()}),false);
  assert.equal(validTargetInboxTriageCommand({...cmd,expectedTriageRevision:-1}),false);
  assert.deepEqual(fx.authority.changeInboxTriage(token,{...cmd,expectedTriageRevision:99}),
    denied("stale_revision"));
  assert.equal(count(fx),0);
  assert.deepEqual(fx.authority.changeInboxTriage(token,cmd),{ok:true});
  assert.deepEqual(fx.authority.changeInboxTriage(token,
    {...cmd,taskId:"shared"}),denied("idempotency_conflict"),
    "same actor+UUID cannot be reused for a different task");
  assert.equal(count(fx),1);
  assert.deepEqual(fx.authority.changeInboxTriage(token,
    {...command(fx,token,"private"),expectedRevision:cmd.expectedRevision}),
    denied("stale_revision"));
  assert.equal(count(fx),1);
});

test("private foreign, shared viewer and revoked editor are not authorized",()=>{
  const fx=fixture();
  const alice=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const cara=fx.authority.issueWritable("cara").sessionToken;
  const original=command(fx,alice,"private");
  assert.deepEqual(fx.authority.changeInboxTriage(bob,original),denied("unavailable"));
  assert.deepEqual(fx.authority.changeInboxTriage(cara,command(fx,alice,"shared")),
    denied("unavailable"));
  const shared=command(fx,bob,"shared");
  fx.db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.deepEqual(fx.authority.changeInboxTriage(bob,shared),denied("unavailable"));
  assert.equal(count(fx),0);
  assert.deepEqual(fx.authority.changeInboxTriage(alice,original),{ok:true});
  assert.equal(count(fx),1);
});

test("read audience cannot issue triage and another restore generation fails closed",()=>{
  const fx=fixture();
  const readOnly=fx.authority.issue("alice").sessionToken;
  const writer=fx.authority.issueWritable("alice").sessionToken;
  const cmd=command(fx,writer,"private");
  assert.deepEqual(fx.authority.changeInboxTriage(readOnly,cmd),denied("unavailable"));
  assert.deepEqual(fx.authority.changeInboxTriage(writer,
    {...cmd,restoreGeneration:randomUUID()}),denied("resync_required"));
  assert.equal(count(fx),0);
});
