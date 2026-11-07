import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";

const {attentionKey}=await import("../lib/target-attention-read-model.ts");
const {planTargetAttentionLifecycle:plan}=
  await import("../lib/target-attention-lifecycle-policy.ts");

const ACTOR="bob",GEN=randomUUID(),NOW=1_800_000_000_000;
const candidate=(overrides={})=>({
  attentionKey:attentionKey("deadline_soon","task-1","2026-11-09"),
  taskId:"task-1",ruleId:"deadline_soon",relevantOn:"2026-11-09",
  sourceRevision:3,...overrides,
});
const snapshot=(overrides={})=>({
  actorUserId:ACTOR,restoreGeneration:GEN,
  attentionKey:candidate().attentionKey,taskId:"task-1",
  ruleId:"deadline_soon",relevantOn:"2026-11-09",
  attentionEpoch:0,row:null,...overrides,
});
const witness=(overrides={})=>({
  actorUserId:ACTOR,restoreGeneration:GEN,
  attentionEpoch:0,candidate:candidate(),...overrides,
});
const command=(kind,extra={})=>({
  kind,nowMs:NOW+1,expectedSourceRevision:3,
  expectedAttentionEpoch:0,expectedLifecycleRevision:null,...extra,
});
const hidden=(state="dismissed",until=null,revision=0)=>({
  state,snoozedUntilMs:until,revision,
});

test("v22 active is row absence: first snooze plans revision-0 INSERT, no active row",()=>{
  const before=snapshot();
  const result=plan(before,witness(),command("snooze",{untilMs:NOW+60_000}));
  assert.deepEqual(result,{
    ok:true,operation:"insert",
    row:hidden("snoozed",NOW+60_000,0),
    visible:false,
    cas:{attentionEpoch:0,lifecycleRevision:null,sourceRevision:3},
    audit:{fromState:"active",toState:"snoozed",reason:"user_snoozed",atMs:NOW+1},
  });
  assert.equal(before.row,null,"pure planner never mutates the snapshot");
  const serialized=JSON.stringify(result);
  for(const secret of ["title","areaId","workspaceId","sessionToken",
    "assigneeUserId","noteBody","changedAtMs"])
    assert.equal(serialized.includes(secret),false,secret);
});

test("active dismiss plans a hidden row and never completes task",()=>{
  const result=plan(snapshot(),witness(),command("dismiss"));
  assert.equal(result.ok,true);
  assert.equal(result.operation,"insert");
  assert.deepEqual(result.row,hidden());
  assert.equal(result.visible,false);
  assert.equal(result.audit.reason,"user_dismissed");
  assert.equal(JSON.stringify(result).includes("taskStatus"),false);
});

test("recheck preserves dismiss on title/source revision, with no persistent sourceRevision",()=>{
  const newer=witness({candidate:candidate({sourceRevision:4})});
  const state=snapshot({row:hidden(),attentionEpoch:1});
  const result=plan(state,{...newer,attentionEpoch:1},
    command("recheck",{nowMs:NOW+100,expectedSourceRevision:4,
      expectedAttentionEpoch:1,expectedLifecycleRevision:0}));
  assert.equal(result.ok,true);
  assert.equal(result.operation,"none");
  assert.deepEqual(result.row,hidden());
  assert.equal(result.audit,null);
  assert.equal(result.visible,false);
  assert.equal("sourceRevision" in result.row,false);
  assert.deepEqual(result.cas,{attentionEpoch:1,lifecycleRevision:0,sourceRevision:4});
});

test("expired snooze uses v22 DELETE, not a fabricated persisted active record",()=>{
  const state=snapshot({row:hidden("snoozed",NOW+60_000,7),attentionEpoch:9});
  const proof=witness({attentionEpoch:9});
  const recheck=at=>plan(state,proof,command("recheck",{
    nowMs:at,expectedAttentionEpoch:9,expectedLifecycleRevision:7,
  }));
  const before=recheck(NOW+59_999);
  assert.equal(before.ok,true);
  assert.equal(before.operation,"none");
  assert.equal(before.visible,false);
  assert.deepEqual(before.row,state.row);
  const expired=recheck(NOW+60_000);
  assert.deepEqual(expired,{
    ok:true,operation:"delete",row:null,visible:true,
    cas:{attentionEpoch:9,lifecycleRevision:7,sourceRevision:3},
    audit:{fromState:"snoozed",toState:"active",
      reason:"snooze_expired",atMs:NOW+60_000},
  });
  const active=plan(snapshot({attentionEpoch:10}),witness({attentionEpoch:10}),
    command("recheck",{expectedAttentionEpoch:10}));
  assert.equal(active.operation,"none");
  assert.equal(active.row,null);
  assert.equal(active.visible,true);
});

test("explicit restore (Undo) deletes both hidden states and refuses missing row",()=>{
  for(const row of [hidden(),hidden("snoozed",NOW+60_000,2)]){
    const s=snapshot({row,attentionEpoch:11});
    const result=plan(s,witness({attentionEpoch:11}),command("restore",{
      expectedAttentionEpoch:11,expectedLifecycleRevision:row.revision,
    }));
    assert.deepEqual(result,{
      ok:true,operation:"delete",row:null,visible:true,
      cas:{attentionEpoch:11,lifecycleRevision:row.revision,sourceRevision:3},
      audit:{fromState:row.state,toState:"active",
        reason:"user_restored",atMs:NOW+1},
    });
  }
  assert.deepEqual(plan(snapshot(),witness(),command("restore")),
    {ok:false,reason:"not-active"});
});

test("hidden-state user snooze/dismiss requires current revision and remains not-active",()=>{
  const state=snapshot({row:hidden(),attentionEpoch:1});
  const proof=witness({attentionEpoch:1});
  for(const kind of ["dismiss","snooze"]){
    const result=plan(state,proof,command(kind,{
      expectedAttentionEpoch:1,expectedLifecycleRevision:0,
      ...(kind==="snooze"?{untilMs:NOW+60_000}:{}),
    }));
    assert.deepEqual(result,{ok:false,reason:"not-active"});
    const stale=plan(state,proof,command(kind,{
      expectedAttentionEpoch:0,expectedLifecycleRevision:null,
      ...(kind==="snooze"?{untilMs:NOW+60_000}:{}),
    }));
    assert.deepEqual(stale,{ok:false,reason:"stale"});
  }
});

test("snooze validates exact server-time future and maximum 30 days",()=>{
  for(const until of [null,undefined,"later",-1,0,NOW+1,NOW,1.2,
    NOW+30*86_400_000+2,Number.MAX_SAFE_INTEGER]){
    const result=plan(snapshot(),witness(),command("snooze",{untilMs:until}));
    assert.deepEqual(result,{ok:false,reason:"invalid"},String(until));
  }
  const exactly=plan(snapshot(),witness(),
    command("snooze",{untilMs:NOW+1+30*86_400_000}));
  assert.equal(exactly.ok,true);
  assert.equal(exactly.operation,"insert");
  // v22 accepts a stored snooze through MAX_SAFE_INTEGER, even when no new
  // server Date could legitimately schedule one that far away.
  const far=snapshot({row:hidden("snoozed",Number.MAX_SAFE_INTEGER,0),attentionEpoch:1});
  const farRecheck=plan(far,witness({attentionEpoch:1}),command("recheck",{
    nowMs:NOW+100,expectedAttentionEpoch:1,expectedLifecycleRevision:0,
  }));
  assert.equal(farRecheck.operation,"none");
  assert.equal(farRecheck.visible,false);
});

test("candidate source revision, attention epoch and row revision are ALL CAS conditions",()=>{
  assert.deepEqual(plan(snapshot(),witness({candidate:candidate({sourceRevision:4})}),
    command("dismiss")),{ok:false,reason:"stale"});
  assert.deepEqual(plan(snapshot(),witness(),
    command("dismiss",{expectedSourceRevision:2})),{ok:false,reason:"stale"});
  assert.deepEqual(plan(snapshot(),witness({attentionEpoch:1}),
    command("dismiss")),{ok:false,reason:"stale"});
  assert.deepEqual(plan(snapshot(),witness(),
    command("dismiss",{expectedAttentionEpoch:1})),{ok:false,reason:"stale"});
  assert.deepEqual(plan(snapshot({attentionEpoch:6}),witness({attentionEpoch:6}),
    command("dismiss",{expectedAttentionEpoch:6,expectedLifecycleRevision:0})),
    {ok:false,reason:"stale"});
  assert.deepEqual(plan(snapshot({row:hidden(),attentionEpoch:4}),
    witness({attentionEpoch:4}),
    command("recheck",{expectedAttentionEpoch:4,expectedLifecycleRevision:1})),
    {ok:false,reason:"stale"});
  // Row revision reused after delete/reinsert: the old epoch must invalidate.
  const aba=snapshot({row:hidden(),attentionEpoch:3});
  assert.deepEqual(plan(aba,witness({attentionEpoch:3}),command("restore",{
    expectedLifecycleRevision:0,expectedAttentionEpoch:1,
  })),{ok:false,reason:"stale"});
  assert.equal(plan(snapshot(),witness(),
    command("dismiss",{nowMs:-1})).reason,"invalid");
});

test("cross-actor, restore generation, task, rule and occurrence are unavailable",()=>{
  const altered=[
    witness({actorUserId:"alice"}),
    witness({restoreGeneration:randomUUID()}),
    witness({candidate:{...candidate(),taskId:"task-2",
      attentionKey:attentionKey("deadline_soon","task-2","2026-11-09")}}),
    witness({candidate:{...candidate(),ruleId:"deadline_overdue",
      attentionKey:attentionKey("deadline_overdue","task-1","2026-11-09")}}),
    witness({candidate:{...candidate(),relevantOn:"2026-11-10",
      attentionKey:attentionKey("deadline_soon","task-1","2026-11-10")}}),
  ];
  for(const p of altered)assert.deepEqual(plan(snapshot(),p,command("dismiss")),
    {ok:false,reason:"unavailable"});
});

test("bad, extra or content-bearing snapshots, v22 rows, and witnesses are invalid",()=>{
  for(const bad of [
    null,undefined,{},snapshot({title:"private secret"}),
    snapshot({actorUserId:"another actor"}),snapshot({restoreGeneration:"wrong"}),
    snapshot({attentionKey:"tatt1:fake"}),snapshot({taskId:"bad\nid"}),
    snapshot({ruleId:"other"}),snapshot({relevantOn:"2026-02-30"}),
    snapshot({attentionEpoch:-1}),snapshot({row:{state:"active",snoozedUntilMs:null,revision:0}}),
    snapshot({row:hidden("snoozed",null)}),
    snapshot({row:hidden("snoozed",-1)}),
    snapshot({row:hidden("snoozed",Number.MAX_SAFE_INTEGER+1)}),
    snapshot({row:hidden("dismissed",null,Number.MAX_SAFE_INTEGER)}),
    snapshot({row:{...hidden(),sourceRevision:3}}),
    snapshot({row:{...hidden(),changedAtMs:NOW}}),
    snapshot({row:hidden("dismissed",NOW+1)}),
  ])assert.equal(plan(bad,witness(),command("dismiss")).ok,false,
    JSON.stringify(bad));
  for(const bad of [
    null,{},witness({title:"secret"}),
    witness({candidate:{...candidate(),title:"private"}}),
    witness({candidate:{...candidate(),attentionKey:"tatt1:fake"}}),
    witness({candidate:{...candidate(),relevantOn:"2026-02-30"}}),
  ])assert.equal(plan(snapshot(),bad,command("dismiss")).ok,false,JSON.stringify(bad));
  for(const bad of [
    {kind:"archive",nowMs:NOW+1,expectedSourceRevision:3,
      expectedAttentionEpoch:0,expectedLifecycleRevision:null},
    command("dismiss",{extraActor:"alice"}),
    command("recheck",{untrustedScope:"shared"}),
    command("snooze",{untilMs:NOW+10,untrustedActor:"other"}),
    command("dismiss",{expectedLifecycleRevision:"0"}),
  ])assert.deepEqual(plan(snapshot(),witness(),bad),{ok:false,reason:"invalid"});
});

test("new material occurrence or newly overdue rule cannot inherit dismissal",()=>{
  const current=snapshot({row:hidden(),attentionEpoch:1});
  const soon=candidate();
  const overdue=candidate({ruleId:"deadline_overdue",
    attentionKey:attentionKey("deadline_overdue","task-1",soon.relevantOn)});
  assert.notEqual(soon.attentionKey,overdue.attentionKey);
  assert.deepEqual(plan(current,witness({attentionEpoch:1,candidate:overdue}),
    command("recheck",{expectedAttentionEpoch:1,expectedLifecycleRevision:0})),
    {ok:false,reason:"unavailable"});
});

test("policy stays pure and DTO matches merged v22 storage, not legacy Attention",()=>{
  const root=path.join(import.meta.dirname,"..");
  const policy=readFileSync(path.join(root,"lib/target-attention-lifecycle-policy.ts"),"utf8");
  const schema=readFileSync(path.join(root,"lib/target-store-bootstrap.ts"),"utf8");
  const reader=readFileSync(path.join(root,"lib/target-attention-read-model.ts"),"utf8");
  assert.doesNotMatch(policy,/from [^\n]*server-store|fetch\(|getDatabase\(|db\.prepare|localStorage|indexedDB/);
  assert.ok(schema.includes("CREATE TABLE personal_attention_states"));
  assert.ok(schema.includes("state TEXT NOT NULL CHECK(state IN ('snoozed','dismissed'))"));
  assert.ok(schema.includes("revision INTEGER NOT NULL DEFAULT 0"));
  assert.ok(schema.includes("personal_attention_state_insert_epoch"));
  assert.ok(schema.includes("personal_attention_state_delete_epoch"));
  assert.ok(reader.includes("lifecycleRevision:number|null"));
  // Guard actual DTO/property definitions, not prose explaining removed fields.
  assert.doesNotMatch(policy,/\bexpectedChangedAtMs\s*:/);
  assert.doesNotMatch(policy,/\bchangedAtMs\s*:/);
  assert.doesNotMatch(policy,/\brecord\.sourceRevision\b/);
});
