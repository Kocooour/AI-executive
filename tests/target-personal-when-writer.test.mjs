import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d3k4a-when-writer-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const oldData=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,
  TARGET_STAGING_PERSONAL_WHEN_RECEIPT_PREFIX:PREFIX,
  TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX:DUE_PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {validTargetStagingPersonalWhenCommand,personalWhenReceiptKey,
  personalWhenReceiptDigest}=await import("../lib/target-personal-when-writer.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const all=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const actor of ["bob","carol"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(actor);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(actor+"-ws",actor);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(actor+"-area",actor,actor+"-ws",actor);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('family','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('family-area','Family','shared','family','alice')").run();
  for(const [who,role] of [["alice","admin"],["bob","editor"],["carol","viewer"]])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('family-area',?,?)").run(who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('family-project','family-area','Family')").run();
  const ins=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  ins.run("p-alice",stage.unassignedAreaId,null,"Alice private",null,"2026-12-31");
  ins.run("p-bob","bob-area",null,"Bob private",null,null);
  ins.run("s-alice","family-area",null,"Alice assigned","alice",null);
  ins.run("s-bob","family-area",null,"Bob assigned","bob","2027-01-01");
  ins.run("s-none","family-area",null,"Unassigned",null,null);
  ins.run("child",null,"family-project","Child inherited","bob",null);
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
const state=(fx,who,id)=>fx.db.prepare(
  "SELECT when_on AS whenOn,revision FROM personal_task_plans WHERE user_id=? AND task_id=?"
).get(who,id);
const epoch=(fx,who)=>fx.db.prepare(
  "SELECT revision FROM personal_plan_epochs WHERE user_id=?"
).get(who).revision;
const receipts=(fx,prefix=PREFIX)=>fx.db.prepare(
  "SELECT key,value FROM metadata WHERE key LIKE ?"
).all(prefix+"%");
function command(fx,token,who,taskId,whenOn,commandId=randomUUID()){
  const preview=fx.authority.previewTaskTitleEdit(token,{taskId});
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const area=fx.db.prepare(
    "SELECT COALESCE(t.area_id,p.area_id) AS id FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?"
  ).get(taskId).id;
  return {commandId,taskId,whenOn,expectedRevision:preview.snapshotRevision,
    expectedPrivateEpoch:epoch(fx,who),
    expectedPlanRevision:state(fx,who,taskId)?.revision??null,
    writeAreaId:area,restoreGeneration:fx.stage.restoreGeneration};
}
test("strict command: no actor or timezone; Gregorian date or null only",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const c=command(fx,token,"alice","p-alice","2024-02-29");
  assert.equal(validTargetStagingPersonalWhenCommand(c),true);
  assert.equal(validTargetStagingPersonalWhenCommand({...c,whenOn:null}),true);
  for(const bad of ["2026-02-29","2100-02-29","2026-04-31","0000-01-01",
    "2026-11-04T00:00:00Z","2026/11/04",undefined,false]){
    assert.equal(validTargetStagingPersonalWhenCommand({...c,whenOn:bad}),false,String(bad));
  }
  for(const extra of [{actorUserId:"alice"},{scope:"shared"},{dueOn:"2028-01-01"},
    {timezone:"Europe/Prague"}]){
    assert.equal(validTargetStagingPersonalWhenCommand({...c,...extra}),false);
  }
  for(const wrong of [{expectedRevision:undefined},{expectedPrivateEpoch:-1},{expectedPrivateEpoch:1.2},
    {expectedPlanRevision:-1},{expectedPlanRevision:"0"},{commandId:"x"}]){
    assert.equal(validTargetStagingPersonalWhenCommand({...c,...wrong}),false);
  }
});
test("private set/update/clear is atomic, per-user and does not modify shared dueOn or task revision",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const before=fx.db.prepare("SELECT revision,due_on AS dueOn FROM tasks WHERE id='p-alice'").get();
  const set=command(fx,token,"alice","p-alice","2026-11-04");
  assert.deepEqual(fx.authority.changePersonalWhen(token,set),{ok:true});
  assert.deepEqual({...state(fx,"alice","p-alice")},{whenOn:"2026-11-04",revision:0});
  assert.equal(epoch(fx,"alice"),1);
  assert.deepEqual(fx.authority.changePersonalWhen(token,set),{ok:true,replayed:true});
  assert.equal(epoch(fx,"alice"),1);
  const next=command(fx,token,"alice","p-alice","2026-11-05");
  assert.deepEqual(fx.authority.changePersonalWhen(token,next),{ok:true});
  assert.deepEqual({...state(fx,"alice","p-alice")},{whenOn:"2026-11-05",revision:1});
  assert.equal(epoch(fx,"alice"),2);
  const clear=command(fx,token,"alice","p-alice",null);
  assert.deepEqual(fx.authority.changePersonalWhen(token,clear),{ok:true});
  assert.equal(state(fx,"alice","p-alice"),undefined);
  assert.equal(epoch(fx,"alice"),3);
  assert.deepEqual(fx.db.prepare("SELECT revision,due_on AS dueOn FROM tasks WHERE id='p-alice'").get(),before);
  assert.equal(receipts(fx).length,3);
  assert.equal(receipts(fx,DUE_PREFIX).length,0);
  assert.deepEqual(inspectIsolatedTargetStore({
    stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
    mode:"r2-model",
  }),{ok:true,mode:"r2-model",issues:[]});
  const journal=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  const records=journal.split("\n").filter(Boolean).map(JSON.parse)
    .filter(row=>row.t==="intent"&&row.k==="personal_when");
  assert.deepEqual(records.map(r=>r.p.set),[1,1,0]);
  assert.ok(records.every(r=>/^[a-f0-9]{64}$/.test(r.p.receiptHash)));
  for(const privateData of ["p-alice","alice","2026-11-04","2026-11-05"])
    assert.equal(journal.includes(privateData),false);
});
test("CAS, no-op and conflicting UUID cannot mutate or consume a receipt",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const noop=command(fx,token,"alice","p-alice",null);
  assert.deepEqual(fx.authority.changePersonalWhen(token,noop),denied("unchanged"));
  const stale=command(fx,token,"alice","p-alice","2026-11-04");
  fx.db.prepare("UPDATE tasks SET title='changed' WHERE id='p-alice'").run();
  assert.deepEqual(fx.authority.changePersonalWhen(token,stale),denied("stale_revision"));
  const fresh=command(fx,token,"alice","p-alice","2026-11-04");
  assert.deepEqual(fx.authority.changePersonalWhen(token,fresh),{ok:true});
  assert.deepEqual(fx.authority.changePersonalWhen(token,{...fresh,whenOn:"2026-11-05"}),
    denied("idempotency_conflict"));
  assert.deepEqual(fx.authority.changePersonalWhen(token,{...fresh,whenOn:null}),
    denied("idempotency_conflict"));
  assert.deepEqual(fx.authority.changePersonalWhen(token,
    {...command(fx,token,"alice","p-alice","2026-11-06"),expectedPrivateEpoch:0}),
    denied("stale_revision"));
  assert.deepEqual(fx.authority.changePersonalWhen(token,
    {...command(fx,token,"alice","p-alice","2026-11-06"),expectedPlanRevision:null}),
    denied("stale_revision"));
  assert.equal(state(fx,"alice","p-alice").whenOn,"2026-11-04");
  assert.equal(receipts(fx).length,1);
  assert.notEqual(personalWhenReceiptKey("alice","p-alice",fresh.commandId),
    personalWhenReceiptKey("bob","p-alice",fresh.commandId));
  assert.notEqual(personalWhenReceiptDigest(fresh),
    personalWhenReceiptDigest({...fresh,whenOn:"2026-11-05"}));
});
test("shared plans require the actor's own assignment, including inherited projects",()=>{
  const fx=fixture();
  const alice=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const carol=fx.authority.issueWritable("carol").sessionToken;
  const shared=command(fx,bob,"bob","s-bob","2026-11-07");
  assert.deepEqual(fx.authority.changePersonalWhen(bob,shared),{ok:true});
  assert.equal(state(fx,"alice","s-bob"),undefined);
  assert.equal(state(fx,"bob","s-bob").whenOn,"2026-11-07");
  const inherited=command(fx,bob,"bob","child","2026-11-08");
  assert.deepEqual(fx.authority.changePersonalWhen(bob,inherited),{ok:true});
  assert.deepEqual(fx.authority.changePersonalWhen(alice,shared),denied("unavailable"));
  assert.deepEqual(fx.authority.changePersonalWhen(carol,shared),denied("unavailable"));
  const own=command(fx,alice,"alice","p-alice","2026-11-09");
  assert.deepEqual(fx.authority.changePersonalWhen(bob,own),denied("unavailable"));
  // Previously committed receipt cannot be replayed after assignment revocation.
  fx.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-bob'").run();
  assert.equal(state(fx,"bob","s-bob"),undefined);
  assert.deepEqual(fx.authority.changePersonalWhen(bob,shared),denied("unavailable"));
});
test("invalid generation, wrong Area, read-only credentials and revoked durable sessions",()=>{
  const fx=fixture(),writer=fx.authority.issueWritable("bob").sessionToken;
  const reader=fx.authority.issue("bob").sessionToken;
  const cmd=command(fx,writer,"bob","p-bob","2026-11-04");
  assert.deepEqual(fx.authority.changePersonalWhen(reader,cmd),denied("unauthorized"));
  assert.deepEqual(fx.authority.changePersonalWhen("garbage",cmd),denied("unauthorized"));
  assert.deepEqual(fx.authority.changePersonalWhen(writer,{...cmd,restoreGeneration:randomUUID()}),
    denied("resync_required"));
  assert.deepEqual(fx.authority.changePersonalWhen(writer,{...cmd,writeAreaId:"family-area"}),
    denied("write_area_mismatch"));
  const issued=durable.issueDurableTargetStagingSession(fx.store,"bob",900);
  assert.equal(issued.ok,true);
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  assert.deepEqual(fx.authority.changePersonalWhen(writer,cmd,hash),{ok:true});
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  const next=command(fx,writer,"bob","p-bob",null);
  assert.deepEqual(fx.authority.changePersonalWhen(writer,next,hash),
    denied("session_revoked"));
  assert.equal(state(fx,"bob","p-bob").whenOn,"2026-11-04");
  assert.equal(receipts(fx).length,1);
});
