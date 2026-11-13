import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3h-status-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"legacy unchanged");
const old=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,TARGET_STAGING_TEMPORAL_STATUS_RECEIPT_PREFIX:PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {validTargetStagingTemporalStatusCommand,temporalStatusReceiptKey,
  temporalStatusReceiptDigest}=await import("../lib/target-task-temporal-status-writer.ts");
const fixtures=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const user of ["bob","carol"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(user);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(user+"-ws",user);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(user+"-private",user,user+"-ws",user);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)")
      .run(who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('family-project','family-area','Family')").run();
  const insert=db.prepare("INSERT INTO tasks(id,area_id,project_id,title) VALUES (?,?,?,?)");
  insert.run("private-task",stage.unassignedAreaId,null,"Private task");
  insert.run("bob-task","bob-private",null,"Bob task");
  insert.run("shared-task","family-area",null,"Shared task");
  insert.run("child",null,"family-project","Inherited task");
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  });
  const fx={stage,db,authority};fixtures.push(fx);return fx;
}
after(()=>{
  for(const fx of fixtures){fx.authority.close();fx.db.close();}
  if(old===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=old;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"legacy unchanged");
  rmSync(root,{recursive:true,force:true});
});
const denial=reason=>({ok:false,reason});
function command(fx,token,taskId,status,commandId=randomUUID(),extra={}){
  const preview=fx.authority.previewTaskTitleEdit(token,{taskId});
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const area=fx.db.prepare("SELECT COALESCE(t.area_id,p.area_id) AS areaId FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?")
    .get(taskId).areaId;
  return {commandId,taskId,status,expectedRevision:preview.snapshotRevision,
    writeAreaId:area,restoreGeneration:fx.stage.restoreGeneration,...extra};
}
const state=(fx,id)=>fx.db.prepare("SELECT status,completed_at_ms AS completedAtMs,revision FROM tasks WHERE id=?").get(id);
const receipts=fx=>fx.db.prepare("SELECT key,value FROM metadata WHERE key LIKE ? ORDER BY key").all(PREFIX+"%");

test("complete and reopen use server timestamps, increment revisions, write one receipt and journal per command",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const before=state(fx,"private-task");
  const complete=command(fx,token,"private-task","completed");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,complete),{ok:true});
  const now=state(fx,"private-task");
  assert.equal(now.status,"completed");
  assert.ok(Number.isSafeInteger(now.completedAtMs)&&now.completedAtMs>0);
  assert.equal(now.revision,before.revision+1);
  assert.equal(receipts(fx).length,1);
  const feed=fx.db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity_kind='task' AND entity_id='private-task' AND op='upsert'").get().n;
  assert.ok(feed>=2);
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,complete),{ok:true,replayed:true});
  assert.equal(state(fx,"private-task").revision,now.revision);
  const reopen=command(fx,token,"private-task","open");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,reopen),{ok:true});
  const after=state(fx,"private-task");
  assert.equal(after.status,"open");
  assert.equal(after.completedAtMs,null);
  assert.equal(after.revision,now.revision+1);
  assert.equal(receipts(fx).length,2);
  assert.deepEqual(inspectIsolatedTargetStore({
    stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
    mode:"r2-model",
  }),{ok:true,mode:"r2-model",issues:[]});
  const journal=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  const entries=journal.split("\n").filter(Boolean).map(JSON.parse)
    .filter(e=>e.t==="intent"&&e.k==="temporal_status");
  assert.equal(entries.length,2);
  assert.deepEqual(entries.map(e=>e.p.completed),[1,0]);
  assert.ok(entries.every(e=>/^[a-f0-9]{64}$/.test(e.p.receiptHash)));
  assert.ok(entries.every(e=>!JSON.stringify(e.p).includes("private-task")));
});

test("current Area ACL denies shared viewers, foreign tasks and revoked editor replays",()=>{
  const fx=fixture();
  const alice=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const carol=fx.authority.issueWritable("carol").sessionToken;
  const shared=command(fx,bob,"child","completed");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(carol,shared),denial("unavailable"));
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(bob,shared),{ok:true});
  const own=command(fx,alice,"private-task","completed");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(bob,own),denial("unavailable"));
  fx.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(bob,shared),denial("unavailable"));
});

test("stale/no-op/forged revisions fail without receipt; reused UUID with changed semantics conflicts",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const original=command(fx,token,"private-task","completed");
  assert.equal(validTargetStagingTemporalStatusCommand({...original,status:"done"}),false);
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,{...original,status:"done"}),
    denial("invalid_request"));
  const noop=command(fx,token,"private-task","open");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,noop),denial("unchanged"));
  assert.equal(receipts(fx).length,0);
  fx.db.prepare("UPDATE tasks SET title='Edited' WHERE id='private-task'").run();
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,original),denial("stale_revision"));
  assert.equal(receipts(fx).length,0);
  const fresh=command(fx,token,"private-task","completed");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,fresh),{ok:true});
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,{...fresh,status:"open"}),
    denial("idempotency_conflict"));
  assert.equal(state(fx,"private-task").status,"completed");
});

test("wrong generation, Area, read-only token and forged session are refused",()=>{
  const fx=fixture(),writer=fx.authority.issueWritable("alice").sessionToken;
  const readOnly=fx.authority.issue("alice").sessionToken;
  const cmd=command(fx,writer,"shared-task","completed");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(readOnly,cmd),denial("unauthorized"));
  assert.deepEqual(fx.authority.changeTemporalTaskStatus("invalid",cmd),denial("unauthorized"));
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(writer,{
    ...cmd,restoreGeneration:randomUUID(),
  }),denial("resync_required"));
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(writer,{
    ...cmd,writeAreaId:fx.stage.unassignedAreaId,
  }),denial("write_area_mismatch"));
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(writer,cmd,"invalid"),denial("unauthorized"));
  assert.equal(state(fx,"shared-task").status,"open");
  assert.equal(receipts(fx).length,0);
});

test("opaque receipts bind actor/task/command and reject caller timestamps or alternate actor",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const cmd=command(fx,token,"private-task","completed");
  assert.ok(temporalStatusReceiptKey("alice",cmd.taskId,cmd.commandId).startsWith(PREFIX));
  assert.notEqual(temporalStatusReceiptKey("alice",cmd.taskId,cmd.commandId),
    temporalStatusReceiptKey("bob",cmd.taskId,cmd.commandId));
  assert.notEqual(temporalStatusReceiptKey("alice",cmd.taskId,cmd.commandId),
    temporalStatusReceiptKey("alice","another",cmd.commandId));
  assert.notEqual(temporalStatusReceiptDigest(cmd),temporalStatusReceiptDigest({...cmd,status:"open"}));
  assert.equal(validTargetStagingTemporalStatusCommand({...cmd,completedAtMs:1234}),false);
  assert.equal(validTargetStagingTemporalStatusCommand({...cmd,actorUserId:"bob"}),false);
  assert.equal(validTargetStagingTemporalStatusCommand({...cmd,writeAreaId:""}),false);
});


test("R3-A3 completion receipts restore previous When in same transaction and reject stale Undo",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  fx.db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES ('alice','private-task','2026-11-04')").run();
  const wrong={...command(fx,token,"private-task","completed"),
    previousWhenOn:"2026-11-05"};
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,wrong),
    denial("stale_revision"),"completion must verify client-supplied day");
  assert.equal(state(fx,"private-task").status,"open");
  assert.equal(receipts(fx).length,0);
  const completion={...command(fx,token,"private-task","completed"),
    previousWhenOn:"2026-11-04"};
  assert.equal(validTargetStagingTemporalStatusCommand(completion),true);
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,completion),{ok:true});
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM personal_task_plans WHERE task_id='private-task'").get().n,0);
  const undo={...command(fx,token,"private-task","open"),undoOf:completion};
  assert.equal(validTargetStagingTemporalStatusCommand(undo),true);
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,undo),{ok:true});
  assert.equal(fx.db.prepare("SELECT when_on AS d FROM personal_task_plans WHERE task_id='private-task'").get().d,"2026-11-04");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,undo),{ok:true,replayed:true});
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM personal_task_plans WHERE task_id='private-task'").get().n,1);
  assert.equal(receipts(fx).length,2);
  assert.deepEqual(inspectIsolatedTargetStore({
    stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
    mode:"r2-model",
  }),{ok:true,mode:"r2-model",issues:[]});

  const second={...command(fx,token,"private-task","completed"),
    previousWhenOn:"2026-11-04"};
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,second),{ok:true});
  // Any intervening task revision after completion blocks a stale Undo even
  // when the caller can fetch a fresh current CAS for reopening.
  fx.db.prepare("UPDATE tasks SET title='Changed after completion' WHERE id='private-task'").run();
  const staleUndo={...command(fx,token,"private-task","open"),undoOf:second};
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,staleUndo),
    denial("stale_revision"));
  assert.equal(state(fx,"private-task").status,"completed");
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM personal_task_plans WHERE task_id='private-task'").get().n,0);
  assert.equal(validTargetStagingTemporalStatusCommand({
    ...staleUndo,undoOf:{...second,previousWhenOn:"2026-11-05"},
  }),true,"structurally valid but not receipted as the original completion");
  assert.deepEqual(fx.authority.changeTemporalTaskStatus(token,{
    ...staleUndo,commandId:randomUUID(),
    undoOf:{...second,previousWhenOn:"2026-11-05"},
  }),denial("stale_revision"));
});
