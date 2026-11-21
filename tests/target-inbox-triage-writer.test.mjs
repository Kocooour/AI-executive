import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test,after} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3a-triage-writer-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
const beforeEnv=process.env.AI_EXECUTIVE_DATA_DIR;
const beforeSecret=process.env.AI_EXECUTIVE_SESSION_SECRET;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
process.env.AI_EXECUTIVE_SESSION_SECRET="test-c3a-authority-signing-secret-32-bytes-minimum";
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {validTargetInboxTriageCommand,readTargetInboxTriageReceipt}=
  await import("../lib/target-inbox-triage-writer.ts");
const {issueTargetInboxRevision,issueTargetInboxCommandId}=
  await import("../lib/target-inbox-command-identity.ts");
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
  const tokenActors=new Map();
  for(const method of ["issueWritable","issue"]){
    const issue=authority[method].bind(authority);
    authority[method]=(actor,...args)=>{
      const result=issue(actor,...args);
      if(result?.sessionToken)tokenActors.set(result.sessionToken,actor);
      return result;
    };
  }
  const fx={stage,db,store,authority,tokenActors};
  fixtures.push(fx);return fx;
}
after(()=>{
  for(const fx of fixtures){fx.authority.close();fx.db.close();}
  if(beforeEnv===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=beforeEnv;
  if(beforeSecret===undefined)delete process.env.AI_EXECUTIVE_SESSION_SECRET;
  else process.env.AI_EXECUTIVE_SESSION_SECRET=beforeSecret;
  rmSync(root,{recursive:true,force:true});
});
function command(fx,token,taskId,mode="process",original=null,id=null){
  const preview=fx.authority.previewTaskTitleEdit(token,{taskId});
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const actor=fx.tokenActors.get(token);
  assert.ok(actor,"a command must originate from a known issued session");
  const row=fx.db.prepare("SELECT triage_revision,COALESCE(t.area_id,p.area_id) AS area FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?")
    .get(taskId);
  const fields={taskId,mode,undoOfCommandId:original,
    expectedRevision:issueTargetInboxRevision(fx.db,actor,taskId,row.triage_revision,
      row.area,fx.stage.restoreGeneration),
    expectedTriageRevision:row.triage_revision,
    writeAreaId:row.area,restoreGeneration:fx.stage.restoreGeneration};
  assert.ok(fields.expectedRevision);
  return {...fields,commandId:id??issueTargetInboxCommandId(fields)};
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

test("pinned receipt confirms original Process after Area move, without stale Undo CAS",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const process=command(fx,token,"private");
  assert.deepEqual(fx.authority.changeInboxTriage(token,process),{ok:true});
  const before=fx.authority.readInboxTriageReceiptSnapshot("alice",process);
  assert.equal(before?.status,"committed");
  assert.ok(before?.next,"unchanged Process has a valid Undo witness");
  // The original write succeeded. A later authorized edit changes the task's
  // effective Area while the client still holds the ORIGINAL Process UUID.
  fx.db.prepare("UPDATE tasks SET area_id='team-area' WHERE id='private'").run();
  assert.equal(read(fx,"private").area_id,"team-area");
  assert.equal(readTargetInboxTriageReceipt(fx.db,"alice",process),"committed");
  const after=fx.authority.readInboxTriageReceiptSnapshot("alice",process);
  assert.equal(after?.status,"committed");
  assert.equal(after?.next,null,"the old Area/revision must not create a stale Undo");
  assert.equal(count(fx),1,"read-only reconciliation never replays the writer");
  // The actor may now continue with an unrelated authorized command.
  assert.deepEqual(fx.authority.changeInboxTriage(
    token,command(fx,token,"shared")),{ok:true});
  assert.equal(count(fx),2);
  // The original UUID is actor-bound, not transferable to another editor.
  assert.equal(readTargetInboxTriageReceipt(fx.db,"bob",process),null);
});

test("receipt cannot leak after task moves out of the original editor's access",()=>{
  const fx=fixture(),bob=fx.authority.issueWritable("bob").sessionToken;
  const process=command(fx,bob,"shared");
  assert.deepEqual(fx.authority.changeInboxTriage(bob,process),{ok:true});
  assert.equal(readTargetInboxTriageReceipt(fx.db,"bob",process),"committed");
  fx.db.prepare("UPDATE tasks SET area_id=? WHERE id='shared'")
    .run(fx.stage.unassignedAreaId);
  assert.equal(readTargetInboxTriageReceipt(fx.db,"bob",process),null);
  assert.equal(fx.authority.readInboxTriageReceiptSnapshot("bob",process),null);
  // Alice can write in the new Area, but does not own Bob's command UUID.
  assert.notEqual(fx.authority.readInboxTriageReceiptSnapshot("alice",process)?.status,
    "committed");
});

test("committed Process and Undo receipts survive authorized tombstone, never revive deleted task",()=>{
  for(const originallyUndone of [false,true]){
    const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
    const process=command(fx,token,"private");
    assert.deepEqual(fx.authority.changeInboxTriage(token,process),{ok:true});
    const undoPreview=fx.authority.readInboxTriageReceiptSnapshot("alice",process);
    assert.equal(undoPreview?.status,"committed");
    assert.ok(undoPreview?.next);
    let last=process;
    if(originallyUndone){
      const undo=command(fx,token,"private","undo",process.commandId);
      assert.deepEqual(fx.authority.changeInboxTriage(token,undo),{ok:true});
      last=undo;
    }
    const latest=command(fx,token,"private");
    const deletion={commandId:randomUUID(),taskId:"private",
      expectedRevision:latest.expectedRevision,writeAreaId:latest.writeAreaId,
      restoreGeneration:fx.stage.restoreGeneration};
    assert.deepEqual(fx.authority.deleteTask(token,deletion),{ok:true},
      "real pinned task delete must create a valid tombstone");
    assert.equal(read(fx,"private"),undefined);
    assert.equal(fx.db.prepare("SELECT area_id FROM task_tombstones WHERE id='private'")
      .get()?.area_id,fx.stage.unassignedAreaId);
    assert.equal(readTargetInboxTriageReceipt(fx.db,"alice",last),"committed");
    const after=fx.authority.readInboxTriageReceiptSnapshot("alice",last);
    assert.equal(after?.status,"committed");
    assert.equal(after?.next,null,"Undo must never resurrect a deleted task");
    assert.equal(readTargetInboxTriageReceipt(fx.db,"alice",process),"committed",
      "the earlier Process proof is retained even after its Undo");
    assert.equal(readTargetInboxTriageReceipt(fx.db,"alice",
      {...last,commandId:randomUUID()}),null,
      "a missing receipt must reveal nothing about a tombstoned task");
    assert.equal(readTargetInboxTriageReceipt(fx.db,"bob",last),null,
      "foreign user cannot read actor's receipt");
    assert.equal(fx.authority.readInboxTriageReceiptSnapshot("bob",last),null);
    assert.equal(fx.authority.changeInboxTriage(token,
      {commandId:randomUUID(),taskId:"private",mode:"undo",
        undoOfCommandId:process.commandId,expectedRevision:undoPreview.next.expectedRevision,
        expectedTriageRevision:undoPreview.next.triageRevision,
        writeAreaId:undoPreview.next.writeAreaId,restoreGeneration:fx.stage.restoreGeneration}
    ).ok,false,"triage writer cannot Undo a tombstone");
    assert.deepEqual(fx.authority.changeInboxTriage(token,
      command(fx,token,"shared")),{ok:true},
      "other Inbox commands are available after tombstone receipt recovery");
    assert.equal(read(fx,"private"),undefined);
  }
});

test("tombstoned Process receipt is only visible to its actor with current write ACL",()=>{
  const fx=fixture();
  const alice=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const process=command(fx,bob,"shared");
  assert.deepEqual(fx.authority.changeInboxTriage(bob,process),{ok:true});
  const latest=command(fx,alice,"shared");
  assert.deepEqual(fx.authority.deleteTask(alice,{
    commandId:randomUUID(),taskId:"shared",expectedRevision:latest.expectedRevision,
    writeAreaId:latest.writeAreaId,restoreGeneration:fx.stage.restoreGeneration,
  }),{ok:true});
  assert.equal(readTargetInboxTriageReceipt(fx.db,"bob",process),"committed");
  const confirmed=fx.authority.readInboxTriageReceiptSnapshot("bob",process);
  assert.equal(confirmed?.status,"committed");
  assert.equal(confirmed?.next,null);
  assert.equal(readTargetInboxTriageReceipt(fx.db,"alice",process),null,
    "another shared Area admin cannot borrow Bob's UUID");
  assert.equal(readTargetInboxTriageReceipt(fx.db,"cara",process),null,
    "shared viewer must not receive a tombstone receipt");
  assert.equal(readTargetInboxTriageReceipt(fx.db,"bob",
    {...process,restoreGeneration:randomUUID()}),null);
  fx.db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal(readTargetInboxTriageReceipt(fx.db,"bob",process),null,
    "tombstone receipt is denied as soon as actor loses write access");
  assert.equal(fx.authority.readInboxTriageReceiptSnapshot("bob",process),null);
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
  const shared=command(fx,token,"shared");
  assert.deepEqual(fx.authority.changeInboxTriage(token,
    {...shared,commandId:cmd.commandId}),denied("idempotency_conflict"),
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

test("bounded triage ledger prunes only expired history and preserves active Process for Undo",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const process=command(fx,token,"private");
  assert.deepEqual(fx.authority.changeInboxTriage(token,process),{ok:true});
  const undo=command(fx,token,"private","undo",process.commandId);
  const seed=fx.db.prepare(
    "INSERT INTO task_triage_receipts(receipt_key,request_digest,actor_user_id,task_id,action,"+
    "undo_of_receipt_key,restore_generation,triage_revision_before,triage_revision_after,"+
    "task_revision_before,task_revision_after,committed_at_ms) VALUES (?,?,?,'gone','process',NULL,?,0,1,0,1,?)");
  const age95Days=Date.now()-95*86_400_000;
  fx.db.exec("BEGIN IMMEDIATE");
  try{
    for(let i=0;i<4095;i++){
      const key=i.toString(16).padStart(64,"0");
      seed.run(key,key,"alice",fx.stage.restoreGeneration,age95Days);
    }
    fx.db.exec("COMMIT");
  }catch(e){fx.db.exec("ROLLBACK");throw e;}
  assert.equal(count(fx),4096);
  // New receipts, including the active Process proof, cannot be deleted.
  assert.throws(()=>fx.db.prepare(
    "DELETE FROM task_triage_receipts WHERE receipt_key=?").run(
      (fx.db.prepare("SELECT receipt_key FROM task_triage_receipts WHERE task_id='private'")
        .get()).receipt_key));
  // Undo is allowed after bounded cleanup; it does not lose its parent Process.
  assert.deepEqual(fx.authority.changeInboxTriage(token,undo),{ok:true});
  assert.equal(count(fx),2);
  assert.equal(read(fx,"private").triage_state,"unprocessed");
  assert.deepEqual(inspectIsolatedTargetStore({...fx.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
});


test("4096 live Process receipts cannot starve Undo; new Process preserves the Undo reserve",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const process=command(fx,token,"private");
  assert.deepEqual(fx.authority.changeInboxTriage(token,process),{ok:true});
  const undo=command(fx,token,"private","undo",process.commandId);
  const other=command(fx,token,"shared");
  const addTask=fx.db.prepare("INSERT INTO tasks(id,area_id,title) VALUES (?,?,?)");
  const complete=fx.db.prepare("UPDATE tasks SET triage_state='processed',triaged_at=?,"+
    "triage_revision=triage_revision+1 WHERE id=?");
  const seed=fx.db.prepare(
    "INSERT INTO task_triage_receipts(receipt_key,request_digest,actor_user_id,task_id,action,"+
    "undo_of_receipt_key,restore_generation,triage_revision_before,triage_revision_after,"+
    "task_revision_before,task_revision_after,committed_at_ms)"+
    " VALUES (?,?,'alice',?,'process',NULL,?,0,1,0,1,?)");
  const at=Date.now()-2*86_400_000; // active and inside the retention window
  fx.db.exec("BEGIN IMMEDIATE");
  try{
    for(let i=0;i<4095;i++){
      const id="reserved-"+i,key=(i+1).toString(16).padStart(64,"0");
      addTask.run(id,fx.stage.unassignedAreaId,"Protected Process "+i);
      complete.run(at,id);
      seed.run(key,key,id,fx.stage.restoreGeneration,at);
    }
    fx.db.exec("COMMIT");
  }catch(error){fx.db.exec("ROLLBACK");throw error;}
  assert.equal(count(fx),4096);
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE triage_state='processed'")
    .get().n,4096);

  // Hard cap has additional bounded headroom, but new Processes cannot use
  // the slots reserved for the Undo of all 4096 live Processes.
  assert.deepEqual(fx.authority.changeInboxTriage(token,other),denied("write_failed"));
  assert.equal(read(fx,"shared").triage_state,"unprocessed");
  assert.equal(count(fx),4096);
  // This exact case deadlocked permanently under the old 4096-row cap.
  assert.deepEqual(fx.authority.changeInboxTriage(token,undo),{ok:true});
  assert.equal(read(fx,"private").triage_state,"unprocessed");
  assert.equal(count(fx),4097);
  assert.deepEqual(fx.authority.changeInboxTriage(token,undo),{ok:true,replayed:true});
});
