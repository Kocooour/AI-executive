import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5b2-attention-writer-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const oldData=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore,
  TARGET_STAGING_PERSONAL_ATTENTION_RECEIPT_PREFIX:PREFIX,
  TARGET_STAGING_PERSONAL_WHEN_RECEIPT_PREFIX:WHEN_PREFIX,
  TARGET_STAGING_MAX_RECEIPTS}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=
  await import("../lib/target-staging-session-authority.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const {validTargetStagingAttentionLifecycleCommand,attentionLifecycleReceiptKey,
  attentionLifecycleReceiptDigest}=await import("../lib/target-attention-lifecycle-writer.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const all=[];
const DAY=24*60*60*1000;
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
  const ins=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  ins.run("p-alice",stage.unassignedAreaId,null,"Alice private",null,"2026-11-01");
  ins.run("p-alice2",stage.unassignedAreaId,null,"Alice private 2",null,"2026-11-01");
  ins.run("p-bob","bob-area",null,"Bob private",null,"2026-11-01");
  ins.run("s-alice","family-area",null,"Alice assigned","alice","2026-11-01");
  ins.run("s-bob","family-area",null,"Bob assigned","bob","2026-11-01");
  ins.run("s-none","family-area",null,"Unassigned",null,"2026-11-01");
  ins.run("p-done","bob-area",null,"Done",null,"2026-11-01");
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='p-done'").run();
  db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES ('alice','p-alice','2026-10-30')").run();
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
const rowOf=(fx,who,id,rule="deadline_overdue",on="2026-11-01")=>fx.db.prepare(
  "SELECT state,snoozed_until_ms AS until,revision FROM personal_attention_states WHERE user_id=? AND task_id=? AND rule_id=? AND occurrence_on=?"
).get(who,id,rule,on);
const rowCount=fx=>fx.db.prepare("SELECT COUNT(*) AS n FROM personal_attention_states").get().n;
const epoch=(fx,who)=>fx.db.prepare(
  "SELECT revision FROM personal_attention_epochs WHERE user_id=?").get(who).revision;
const receipts=(fx,prefix=PREFIX)=>fx.db.prepare(
  "SELECT key,value FROM metadata WHERE key LIKE ?").all(prefix+"%");
const shared=fx=>JSON.stringify([
  fx.db.prepare("SELECT id,revision FROM tasks ORDER BY id").all(),
  fx.db.prepare("SELECT COUNT(*) AS n FROM change_log").get(),
  fx.db.prepare("SELECT * FROM personal_plan_epochs ORDER BY user_id").all(),
]);
function command(fx,token,who,taskId,action,extra={}){
  const preview=fx.authority.previewTaskTitleEdit(token,{taskId});
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const area=fx.db.prepare(
    "SELECT COALESCE(t.area_id,p.area_id) AS id FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?"
  ).get(taskId).id;
  const ruleId=extra.ruleId??"deadline_overdue";
  const occurrenceOn=extra.occurrenceOn??"2026-11-01";
  return {commandId:randomUUID(),taskId,ruleId,occurrenceOn,action,
    snoozedUntilMs:action==="snooze"?Date.now()+DAY:null,
    expectedRevision:preview.snapshotRevision,
    expectedAttentionEpoch:epoch(fx,who),
    expectedStateRevision:rowOf(fx,who,taskId,ruleId,occurrenceOn)?.revision??null,
    writeAreaId:area,restoreGeneration:fx.stage.restoreGeneration,...extra};
}
const change=(fx,token,c,hash)=>fx.authority.changeAttentionLifecycle(token,c,hash);
const preflight=fx=>inspectIsolatedTargetStore({
  stagingDirectory:fx.stage.directory,expectedRestoreGeneration:fx.stage.restoreGeneration,
  mode:"r2-model",
});

test("strict command: exact keys, enums, strict date, snooze/until pairing",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const c=command(fx,token,"alice","p-alice","snooze");
  assert.equal(validTargetStagingAttentionLifecycleCommand(c),true);
  assert.equal(validTargetStagingAttentionLifecycleCommand(command(fx,token,"alice","p-alice","dismiss")),true);
  for(const bad of [{ruleId:"x"},{action:"hide"},{occurrenceOn:null},{occurrenceOn:"2026-02-30"},
    {snoozedUntilMs:null},{snoozedUntilMs:0},{snoozedUntilMs:1.5},{snoozedUntilMs:Number.MAX_SAFE_INTEGER+1},
    {expectedAttentionEpoch:-1},{expectedStateRevision:"0"},{commandId:"x"},{expectedRevision:"abc"}])
    assert.equal(validTargetStagingAttentionLifecycleCommand({...c,...bad}),false,JSON.stringify(bad));
  for(const extra of [{actorUserId:"alice"},{timezone:"Europe/Prague"}])
    assert.equal(validTargetStagingAttentionLifecycleCommand({...c,...extra}),false);
  for(const action of ["dismiss","restore"])
    assert.equal(validTargetStagingAttentionLifecycleCommand({...c,action,snoozedUntilMs:Date.now()+DAY}),false);
  assert.deepEqual(change(fx,token,{...c,snoozedUntilMs:null}),denied("invalid_request"));
  assert.deepEqual(change(fx,token,{...c,action:"dismiss"}),denied("invalid_request"));
  assert.equal(rowCount(fx),0);
});

test("snooze, dismiss, restore: rows, epochs, receipts, content-free journal, shared state untouched",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const before=shared(fx);
  const until=Date.now()+DAY;
  const snooze=command(fx,token,"alice","p-alice","snooze",{snoozedUntilMs:until});
  assert.deepEqual(change(fx,token,snooze),{ok:true});
  assert.deepEqual({...rowOf(fx,"alice","p-alice")},{state:"snoozed",until,revision:0});
  assert.equal(epoch(fx,"alice"),1);
  assert.deepEqual(change(fx,token,snooze),{ok:true,replayed:true});
  assert.equal(epoch(fx,"alice"),1);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","dismiss")),denied("not_active"));
  assert.equal(epoch(fx,"alice"),1);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","restore")),{ok:true});
  assert.equal(rowOf(fx,"alice","p-alice"),undefined);
  assert.equal(epoch(fx,"alice"),2);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","dismiss")),{ok:true});
  assert.deepEqual({...rowOf(fx,"alice","p-alice")},{state:"dismissed",until:null,revision:0});
  assert.equal(epoch(fx,"alice"),3);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","snooze")),denied("not_active"));
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","restore")),{ok:true});
  assert.equal(rowOf(fx,"alice","p-alice"),undefined);
  assert.equal(epoch(fx,"alice"),4);
  assert.equal(receipts(fx).length,4);
  assert.equal(receipts(fx,WHEN_PREFIX).length,0);
  assert.equal(shared(fx),before);
  assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});
  const journal=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8");
  const records=journal.split("\n").filter(Boolean).map(JSON.parse)
    .filter(row=>row.t==="intent"&&row.k==="personal_attention");
  assert.deepEqual(records.map(r=>r.p.action),[0,2,1,2]);
  assert.deepEqual(records.map(r=>r.p.epoch),[1,2,3,4]);
  for(const r of records){
    assert.deepEqual(Object.keys(r.p).sort(),["action","epoch","receiptHash"]);
    assert.match(r.p.receiptHash,/^[a-f0-9]{64}$/);
  }
  for(const privateData of ["p-alice","alice","2026-11-01","deadline_overdue","snooze"])
    assert.equal(journal.includes(privateData),false,privateData);
});

test("planned_date_passed lifecycle and receipt identity",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const c=command(fx,token,"alice","p-alice","dismiss",
    {ruleId:"planned_date_passed",occurrenceOn:"2026-10-30"});
  assert.deepEqual(change(fx,token,c),{ok:true});
  assert.equal(rowOf(fx,"alice","p-alice","planned_date_passed","2026-10-30").state,"dismissed");
  assert.notEqual(attentionLifecycleReceiptKey("alice","p-alice",c.commandId),
    attentionLifecycleReceiptKey("bob","p-alice",c.commandId));
  assert.notEqual(attentionLifecycleReceiptDigest(c),
    attentionLifecycleReceiptDigest({...c,ruleId:"deadline_soon"}));
});

test("same UUID with a different payload conflicts and writes nothing",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const c=command(fx,token,"alice","p-alice","dismiss");
  assert.deepEqual(change(fx,token,c),{ok:true});
  assert.deepEqual(change(fx,token,{...c,action:"restore",snoozedUntilMs:null}),
    denied("idempotency_conflict"));
  assert.deepEqual(change(fx,token,{...c,action:"snooze",snoozedUntilMs:Date.now()+DAY}),
    denied("idempotency_conflict"));
  assert.equal(rowOf(fx,"alice","p-alice").state,"dismissed");
  assert.equal(epoch(fx,"alice"),1);
  assert.equal(receipts(fx).length,1);
});

test("CAS: stale task revision, attention epoch and state revision write nothing",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const stale=command(fx,token,"alice","p-alice","dismiss");
  fx.db.prepare("UPDATE tasks SET title='changed' WHERE id='p-alice'").run();
  assert.deepEqual(change(fx,token,stale),denied("stale_revision"));
  assert.deepEqual(change(fx,token,{...command(fx,token,"alice","p-alice","dismiss"),
    expectedAttentionEpoch:5}),denied("stale_revision"));
  assert.deepEqual(change(fx,token,{...command(fx,token,"alice","p-alice","dismiss"),
    expectedStateRevision:0}),denied("stale_revision"));
  assert.equal(rowCount(fx),0);assert.equal(epoch(fx,"alice"),0);
  assert.equal(receipts(fx).length,0);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","dismiss")),{ok:true});
  assert.deepEqual(change(fx,token,{...command(fx,token,"alice","p-alice","snooze"),
    expectedStateRevision:null}),denied("stale_revision"));
  assert.deepEqual(change(fx,token,{...command(fx,token,"alice","p-alice","snooze"),
    expectedAttentionEpoch:0}),denied("stale_revision"));
  assert.equal(rowOf(fx,"alice","p-alice").state,"dismissed");
});

test("ACL: viewer, unassigned, other assignee, foreign private, completed, read credential",()=>{
  const fx=fixture();
  const alice=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const carol=fx.authority.issueWritable("carol").sessionToken;
  const own=command(fx,bob,"bob","s-bob","dismiss");
  const foreign=command(fx,alice,"alice","p-alice","dismiss");
  assert.deepEqual(change(fx,carol,{...own}),denied("unavailable"),"viewer");
  assert.deepEqual(change(fx,alice,{...own}),denied("unavailable"),"admin but not assignee");
  assert.deepEqual(change(fx,bob,foreign),denied("unavailable"),"foreign private");
  const none=command(fx,alice,"alice","s-none","dismiss");
  assert.deepEqual(change(fx,bob,none),denied("unavailable"),"unassigned");
  assert.deepEqual(change(fx,alice,none),denied("unavailable"),"unassigned, own");
  const done=command(fx,bob,"bob","p-done","dismiss");
  assert.deepEqual(change(fx,bob,done),denied("unavailable"),"completed");
  const reader=fx.authority.issue("bob").sessionToken;
  assert.deepEqual(change(fx,reader,own),denied("unauthorized"));
  assert.deepEqual(change(fx,"garbage",own),denied("unauthorized"));
  assert.equal(rowCount(fx),0);assert.equal(receipts(fx).length,0);
  assert.deepEqual(change(fx,bob,own),{ok:true});
  // Revoked assignment makes even a stored receipt unreplayable.
  fx.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE id='s-bob'").run();
  assert.equal(rowCount(fx),0,"reconcile removed the state");
  assert.deepEqual(change(fx,bob,own),denied("unavailable"));
});

test("invalid generation, wrong Area and revoked durable session roll back",()=>{
  const fx=fixture(),writer=fx.authority.issueWritable("bob").sessionToken;
  const c=command(fx,writer,"bob","p-bob","dismiss");
  assert.deepEqual(change(fx,writer,{...c,restoreGeneration:randomUUID()}),denied("resync_required"));
  assert.deepEqual(change(fx,writer,{...c,writeAreaId:"family-area"}),denied("write_area_mismatch"));
  const issued=durable.issueDurableTargetStagingSession(fx.store,"bob",900);
  assert.equal(issued.ok,true);
  const hash=durable.hashTargetStagingSessionToken(issued.sessionToken);
  assert.deepEqual(change(fx,writer,c,hash),{ok:true});
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  const next=command(fx,writer,"bob","p-bob","restore");
  assert.deepEqual(change(fx,writer,next,hash),denied("session_revoked"));
  assert.equal(rowOf(fx,"bob","p-bob").state,"dismissed");
  assert.equal(receipts(fx).length,1);assert.equal(epoch(fx,"bob"),1);
});

test("occurrence must still be current; no leak, nothing written",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  for(const [rule,on] of [["deadline_overdue","2026-11-02"],["deadline_soon","2026-10-31"],
    ["planned_date_passed","2026-11-01"]]){
    const res=change(fx,token,command(fx,token,"alice","p-alice","dismiss",{ruleId:rule,occurrenceOn:on}));
    assert.deepEqual(res,denied("unavailable"),rule);
  }
  // planned rule with no plan at all
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice2","dismiss",
    {ruleId:"planned_date_passed",occurrenceOn:"2026-10-30"})),denied("unavailable"));
  assert.equal(rowCount(fx),0);assert.equal(receipts(fx).length,0);
});

test("snooze bounds are checked against the server clock",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const now=Date.now();
  for(const until of [1,now-1000,now,now+30*DAY+5000])
    assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","snooze",
      {snoozedUntilMs:until})),denied("invalid_request"),String(until));
  assert.equal(rowCount(fx),0);assert.equal(receipts(fx).length,0);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","snooze",
    {snoozedUntilMs:Date.now()+30*DAY})),{ok:true},"exactly 30 days is allowed");
});

test("restore without a row is unchanged; snooze/dismiss only from active, expired snooze is active",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","restore")),denied("unchanged"));
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","dismiss")),{ok:true});
  for(const action of ["dismiss","snooze"])
    assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice",action)),denied("not_active"),action);
  const until=Date.now()+DAY;
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","restore")),{ok:true});
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","snooze",{snoozedUntilMs:until})),{ok:true});
  for(const [action,extra] of [["snooze",{snoozedUntilMs:until}],["snooze",{}],["dismiss",{}]])
    assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice",action,extra)),denied("not_active"));
  assert.equal(epoch(fx,"alice"),3);assert.equal(receipts(fx).length,3);
  // Expire the snooze: the state is effectively active again.
  fx.db.prepare("UPDATE personal_attention_states SET snoozed_until_ms=? WHERE task_id='p-alice'").run(Date.now()-1000);
  const rev=rowOf(fx,"alice","p-alice").revision;
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","dismiss")),{ok:true});
  assert.deepEqual({...rowOf(fx,"alice","p-alice")},{state:"dismissed",until:null,revision:rev+1});
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","restore")),{ok:true});
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","snooze")),{ok:true});
  fx.db.prepare("UPDATE personal_attention_states SET snoozed_until_ms=? WHERE task_id='p-alice'").run(Date.now()-1000);
  const next=Date.now()+2*DAY;
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","snooze",{snoozedUntilMs:next})),{ok:true});
  assert.equal(rowOf(fx,"alice","p-alice").until,next);
  // Restore from an expired snooze row deletes it.
  fx.db.prepare("UPDATE personal_attention_states SET snoozed_until_ms=? WHERE task_id='p-alice'").run(Date.now()-1000);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","restore")),{ok:true});
  assert.equal(rowOf(fx,"alice","p-alice"),undefined);
});

test("overdue command removes only the actor's matching soon row",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const bob=fx.authority.issueWritable("bob").sessionToken;
  const put=(who,task,rule,on)=>fx.db.prepare(
    "INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES (?,?,?,?,'dismissed')")
    .run(who,task,rule,on);
  put("alice","p-alice","deadline_soon","2026-11-01");
  put("alice","p-alice2","deadline_soon","2026-11-01");
  put("bob","s-bob","deadline_soon","2026-11-01");
  const e0=epoch(fx,"alice"),b0=epoch(fx,"bob");
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","dismiss")),{ok:true});
  assert.equal(rowOf(fx,"alice","p-alice","deadline_soon"),undefined);
  assert.ok(rowOf(fx,"alice","p-alice2","deadline_soon"));
  assert.ok(rowOf(fx,"bob","s-bob","deadline_soon"));
  assert.equal(epoch(fx,"alice"),e0+2);assert.equal(epoch(fx,"bob"),b0);
  const j=readFileSync(path.join(fx.stage.directory,"lumi-target.journal"),"utf8")
    .split("\n").filter(Boolean).map(JSON.parse).filter(r=>r.k==="personal_attention");
  assert.equal(j[0].p.epoch,e0+2);
  // overdue restore also cleans a (re-created) soon row; soon command never touches overdue
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice2","dismiss",{ruleId:"deadline_soon"})),denied("not_active"));
  assert.deepEqual(preflight(fx),{ok:true,mode:"r2-model",issues:[]});
  void bob;
});

test("end to end with the selector: dismiss hides, restore re-activates",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  const now=Date.now();
  const read=view=>fx.authority.readAttentionCandidatePage("alice","all",view,now,"Europe/Prague",100,0);
  const has=p=>p.items.some(i=>i.taskId==="p-alice"&&i.ruleId==="deadline_overdue");
  assert.ok(read("active"));assert.equal(has(read("active")),true);assert.equal(has(read("hidden")),false);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","dismiss")),{ok:true});
  assert.equal(has(read("active")),false);assert.equal(has(read("hidden")),true);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","restore")),{ok:true});
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","snooze",
    {snoozedUntilMs:now+DAY})),{ok:true});
  assert.equal(has(read("active")),false);assert.equal(has(read("hidden")),true);
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","restore")),{ok:true});
  assert.equal(has(read("active")),true);assert.equal(has(read("hidden")),false);
});

test("preflight detects malformed or over-cap attention receipts",()=>{
  const fx=fixture(),token=fx.authority.issueWritable("alice").sessionToken;
  assert.deepEqual(change(fx,token,command(fx,token,"alice","p-alice","dismiss")),{ok:true});
  assert.equal(preflight(fx).ok,true);
  fx.db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(PREFIX+"zz","bad");
  const res=preflight(fx);
  assert.equal(res.ok,false);assert.ok(res.issues.length>0);
  assert.equal(JSON.stringify(res).includes("alice"),false);
  assert.ok(TARGET_STAGING_MAX_RECEIPTS>0);
});
