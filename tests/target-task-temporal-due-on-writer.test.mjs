import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3i1-due-on-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const oldData=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX:PREFIX,
  TARGET_STAGING_TEMPORAL_STATUS_RECEIPT_PREFIX:STATUS_PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {validTargetDueOn,validTargetStagingTemporalDueOnCommand,
  temporalDueOnReceiptKey,temporalDueOnReceiptDigest}=
  await import("../lib/target-task-temporal-due-on-writer.ts");
const durable=await import("../lib/target-staging-durable-session.ts");

const all=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const actor of ["bob","carol"]) {
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(actor);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(actor+"-ws",actor);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(actor+"-private",actor,actor+"-ws",actor);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)").run(who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('family-project','family-area','Family')").run();
  const ins=db.prepare("INSERT INTO tasks(id,area_id,project_id,title) VALUES (?,?,?,?)");
  ins.run("private",stage.unassignedAreaId,null,"Private");
  ins.run("bob-own","bob-private",null,"Bob private");
  ins.run("shared","family-area",null,"Shared");
  ins.run("child",null,"family-project","Inherited shared");
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  });
  const fx={stage,db,authority,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  }};all.push(fx);return fx;
}
after(()=>{
  for(const fx of all){fx.authority.close();fx.db.close();}
  if(oldData===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=oldData;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const denied=reason=>({ok:false,reason});
const state=(fx,id)=>fx.db.prepare(
  "SELECT due_on AS dueOn,status,completed_at_ms AS completedAtMs,revision FROM tasks WHERE id=?"
).get(id);
const receipts=(fx,prefix=PREFIX)=>fx.db.prepare(
  "SELECT key,value FROM metadata WHERE key LIKE ? ORDER BY key"
).all(prefix+"%");
function command(fx,actorToken,taskId,dueOn,commandId=randomUUID()){
  const revision=fx.authority.previewTaskTitleEdit(actorToken,{taskId});
  assert.equal(revision.ok,true,JSON.stringify(revision));
  const area=fx.db.prepare(
    "SELECT COALESCE(t.area_id,p.area_id) AS id FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?"
  ).get(taskId).id;
  return {commandId,taskId,dueOn,expectedRevision:revision.snapshotRevision,
    writeAreaId:area,restoreGeneration:fx.stage.restoreGeneration};
}

test("strict date-only ISO Gregorian validation including leap-century and clear",()=>{
  for(const date of [null,"0001-01-01","2024-02-29","2000-02-29","2026-11-03",
    "2026-12-31","9999-12-31"])
    assert.equal(validTargetDueOn(date),true,String(date));
  for(const invalid of [undefined,false,0,{},"","2026-2-03","2026-02-3","2026-02-29",
    "2024-02-30","2100-02-29","1900-02-29","0000-01-01","2026-00-01",
    "2026-13-01","2026-04-31","2026-11-03T00:00:00Z","2026-11-03+01:00",
    " 2026-11-03","2026-11-03 ","2026/11/03"])
    assert.equal(validTargetDueOn(invalid),false,String(invalid));
});

test("set and clear dueOn atomically, preserve status and timestamp, separate receipts and audit",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const before=state(fx,"private");
  const set=command(fx,token,"private","2028-02-29");
  assert.equal(validTargetStagingTemporalDueOnCommand(set),true);
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,set),{ok:true});
  const after=state(fx,"private");
  assert.equal(after.dueOn,"2028-02-29");
  assert.equal(after.revision,before.revision+1);
  assert.equal(after.status,before.status);
  assert.equal(after.completedAtMs,before.completedAtMs);
  assert.equal(receipts(fx).length,1);
  assert.equal(receipts(fx,STATUS_PREFIX).length,0);
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,set),{ok:true,replayed:true});
  assert.equal(state(fx,"private").revision,after.revision);
  const clear=command(fx,token,"private",null);
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,clear),{ok:true});
  assert.deepEqual({...state(fx,"private")},{
    dueOn:null,status:before.status,completedAtMs:before.completedAtMs,
    revision:before.revision+2,
  });
  assert.equal(receipts(fx).length,2);
  const check=inspectIsolatedTargetStore({
    stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
    mode:"r2-model",
  });
  assert.deepEqual(check,{ok:true,mode:"r2-model",issues:[]});
  const raw=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  const events=raw.split("\n").filter(Boolean).map(JSON.parse)
    .filter(event=>event.t==="intent"&&event.k==="temporal_due_on");
  assert.equal(events.length,2);
  assert.deepEqual(events.map(event=>event.p.set),[1,0]);
  assert.ok(events.every(event=>/^[a-f0-9]{64}$/.test(event.p.receiptHash)));
  for(const privateData of ["private","alice","2028-02-29"])
    assert.equal(raw.includes(privateData),false,privateData+" leaked into journal");
  const feed=fx.db.prepare(
    "SELECT COUNT(*) AS n FROM change_log WHERE entity_kind='task' AND entity_id='private' AND op='upsert'"
  ).get().n;
  assert.ok(feed>=3);
});

test("per-item CAS, no-op and conflicting UUID reuse never mutate or receipt",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const initial=command(fx,token,"private",null);
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,initial),denied("unchanged"));
  assert.equal(receipts(fx).length,0);
  const stale=command(fx,token,"private","2026-11-15");
  fx.db.prepare("UPDATE tasks SET title='updated title' WHERE id='private'").run();
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,stale),denied("stale_revision"));
  assert.equal(receipts(fx).length,0);
  const fresh=command(fx,token,"private","2026-11-15");
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,fresh),{ok:true});
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,{...fresh,dueOn:"2026-11-16"}),
    denied("idempotency_conflict"));
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,{...fresh,dueOn:null}),
    denied("idempotency_conflict"));
  assert.equal(state(fx,"private").dueOn,"2026-11-15");
  assert.equal(receipts(fx).length,1);
  const sameDate=command(fx,token,"private","2026-11-15");
  assert.deepEqual(fx.authority.changeTemporalDueOn(token,sameDate),denied("unchanged"));
  assert.equal(receipts(fx).length,1);
});

test("current Area write policy, shared project inheritance and replay revocation",()=>{
  const fx=fixture();
  const alice=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const carol=fx.authority.issueWritable("carol").sessionToken;
  const cmd=command(fx,bob,"child","2027-03-03");
  assert.deepEqual(fx.authority.changeTemporalDueOn(carol,cmd),denied("unavailable"));
  assert.deepEqual(fx.authority.changeTemporalDueOn(bob,cmd),{ok:true});
  assert.equal(state(fx,"child").dueOn,"2027-03-03");
  const own=command(fx,alice,"private","2026-12-03");
  assert.deepEqual(fx.authority.changeTemporalDueOn(bob,own),denied("unavailable"));
  fx.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  assert.deepEqual(fx.authority.changeTemporalDueOn(bob,cmd),denied("unavailable"));
  assert.equal(receipts(fx).length,1);
});

test("wrong Area/generation, read-only, invalid command and forged session fail closed",()=>{
  const fx=fixture(),writer=fx.authority.issueWritable("alice").sessionToken;
  const reader=fx.authority.issue("alice").sessionToken;
  const cmd=command(fx,writer,"shared","2026-11-03");
  assert.deepEqual(fx.authority.changeTemporalDueOn(reader,cmd),denied("unauthorized"));
  assert.deepEqual(fx.authority.changeTemporalDueOn("invalid",cmd),denied("unauthorized"));
  assert.deepEqual(fx.authority.changeTemporalDueOn(writer,{...cmd,restoreGeneration:randomUUID()}),
    denied("resync_required"));
  assert.deepEqual(fx.authority.changeTemporalDueOn(writer,{...cmd,writeAreaId:fx.stage.unassignedAreaId}),
    denied("write_area_mismatch"));
  assert.deepEqual(fx.authority.changeTemporalDueOn(writer,cmd,"invalid"),denied("unauthorized"));
  for(const altered of [{...cmd,dueOn:"2026-02-29"},{...cmd,dueOn:undefined},
    {...cmd,actorUserId:"alice"},{...cmd,when:"today"},{...cmd,completedAtMs:1},
    {...cmd,dueOn:"2026-11-03T00:00:00Z"},{...cmd,dueOn:"2026/11/03"}]){
    assert.equal(validTargetStagingTemporalDueOnCommand(altered),false);
    assert.deepEqual(fx.authority.changeTemporalDueOn(writer,altered),denied("invalid_request"));
  }
  assert.equal(receipts(fx).length,0);
  assert.equal(state(fx,"shared").dueOn,null);
});

test("opaque due-on receipts bind actor/task/UUID and date, not a caller timestamp",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const cmd=command(fx,token,"private","2026-11-03");
  assert.ok(temporalDueOnReceiptKey("alice",cmd.taskId,cmd.commandId).startsWith(PREFIX));
  assert.notEqual(temporalDueOnReceiptKey("alice",cmd.taskId,cmd.commandId),
    temporalDueOnReceiptKey("bob",cmd.taskId,cmd.commandId));
  assert.notEqual(temporalDueOnReceiptKey("alice",cmd.taskId,cmd.commandId),
    temporalDueOnReceiptKey("alice","shared",cmd.commandId));
  assert.notEqual(temporalDueOnReceiptDigest(cmd),
    temporalDueOnReceiptDigest({...cmd,dueOn:"2026-11-04"}));
  assert.notEqual(temporalDueOnReceiptDigest(cmd),
    temporalDueOnReceiptDigest({...cmd,dueOn:null}));
  assert.equal(validTargetStagingTemporalDueOnCommand({...cmd,localTimezone:"Europe/Prague"}),false);
});

test("durable session revocation is checked independently in pinned writer",()=>{
  const fx=fixture();
  const issued=durable.issueDurableTargetStagingSession(fx.store,"bob",900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  const writer=fx.authority.issueWritable("bob").sessionToken;
  const first=command(fx,writer,"shared","2026-11-30");
  assert.deepEqual(fx.authority.changeTemporalDueOn(writer,first,hash),{ok:true});
  const next=command(fx,writer,"shared",null);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  assert.deepEqual(fx.authority.changeTemporalDueOn(writer,next,hash),
    denied("session_revoked"));
  assert.equal(state(fx,"shared").dueOn,"2026-11-30");
  assert.equal(receipts(fx).length,1);
});
