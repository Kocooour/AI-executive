import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";

const {attentionKey}=await import("../lib/target-attention-read-model.ts");
const {planTargetAttentionLifecycle:plan}=
  await import("../lib/target-attention-lifecycle-policy.ts");

const ACTOR="bob",GEN=randomUUID(),NOW=1_800_000_000_000;
const candidate=(overrides={})=>({
  attentionKey:attentionKey("deadline_soon","task-1","2026-11-09"),
  taskId:"task-1",ruleId:"deadline_soon",relevantOn:"2026-11-09",
  sourceRevision:3,...overrides,
});
const state=(overrides={})=>({
  actorUserId:ACTOR,restoreGeneration:GEN,
  ...candidate(),state:"active",snoozeUntilMs:null,changedAtMs:NOW,
  ...overrides,
});
const evidence=(overrides={})=>({
  actorUserId:ACTOR,restoreGeneration:GEN,candidate:candidate(),
  ...overrides,
});
const user=(kind,extra={})=>({
  kind,nowMs:NOW+1,expectedSourceRevision:3,expectedChangedAtMs:NOW,...extra,
});

test("active → snoozed: content-free audit and no exposed private titles",()=>{
  const before=state(),proof=evidence();
  const result=plan(before,proof,user("snooze",{untilMs:NOW+60_000}));
  assert.equal(result.ok,true);
  assert.equal(result.change,"state-transition");
  assert.equal(result.record.state,"snoozed");
  assert.equal(result.record.snoozeUntilMs,NOW+60_000);
  assert.equal(result.visible,false);
  assert.deepEqual(result.audit,{fromState:"active",toState:"snoozed",
    reason:"user_snoozed",atMs:NOW+1});
  assert.equal(before.state,"active","planner must not mutate its input");
  assert.equal(before.snoozeUntilMs,null);
  const json=JSON.stringify(result);
  for(const secret of ["title","areaId","workspaceId","sessionToken",
    "assigneeUserId","noteBody"])assert.ok(!json.includes(secret),secret);
});

test("active → dismissed never completes a task or reopens on title revision",()=>{
  const dismissed=plan(state(),evidence(),user("dismiss"));
  assert.equal(dismissed.ok,true);
  assert.equal(dismissed.record.state,"dismissed");
  assert.equal(dismissed.record.snoozeUntilMs,null);
  assert.equal(dismissed.audit.reason,"user_dismissed");
  const newer=plan(dismissed.record,evidence({candidate:candidate({sourceRevision:4})}),
    {kind:"recheck",nowMs:NOW+2});
  assert.equal(newer.ok,true);
  assert.equal(newer.record.sourceRevision,4);
  assert.equal(newer.record.state,"dismissed","ordinary task revision must not undo dismiss");
  assert.equal(newer.change,"source-revision");
  assert.equal(newer.visible,false);
  assert.equal(newer.audit,null);
  assert.equal(plan(newer.record,evidence({candidate:candidate({sourceRevision:4})}),
    user("dismiss",{nowMs:NOW+3,expectedSourceRevision:4,
      expectedChangedAtMs:NOW+1})).reason,"not-active");
});

test("snooze expiration requires an explicit fresh verified candidate recheck",()=>{
  const snoozed=plan(state(),evidence(),
    user("snooze",{untilMs:NOW+60_000})).record;
  const before=plan(snoozed,evidence(),{kind:"recheck",nowMs:NOW+59_999});
  assert.equal(before.ok,true);
  assert.equal(before.change,"none");
  assert.equal(before.record.state,"snoozed");
  assert.equal(before.visible,false);
  const expired=plan(snoozed,evidence(),{kind:"recheck",nowMs:NOW+60_000});
  assert.equal(expired.ok,true);
  assert.equal(expired.change,"state-transition");
  assert.equal(expired.record.state,"active");
  assert.equal(expired.record.snoozeUntilMs,null);
  assert.equal(expired.record.changedAtMs,NOW+60_000);
  assert.equal(expired.audit.reason,"snooze_expired");
  assert.equal(expired.visible,true);
});

test("snoozed and dismissed user commands are rejected (no repeated receipts)",()=>{
  const snoozed=plan(state(),evidence(),
    user("snooze",{untilMs:NOW+60_000})).record;
  assert.deepEqual(plan(snoozed,evidence(),
    user("dismiss",{expectedChangedAtMs:NOW+1,nowMs:NOW+2})),
    {ok:false,reason:"not-active"});
  assert.deepEqual(plan(snoozed,evidence(),
    user("snooze",{untilMs:NOW+70_000,expectedChangedAtMs:NOW+1,nowMs:NOW+2})),
    {ok:false,reason:"not-active"});
  const dismissed=plan(state(),evidence(),user("dismiss")).record;
  assert.equal(plan(dismissed,evidence(),{kind:"recheck",nowMs:NOW+80_000}).record.state,
    "dismissed");
});

test("bad, expired, excessively long and non-integer snooze values fail closed",()=>{
  for(const until of [null,undefined,"later",-1,0,NOW+1,NOW,1.2,
    NOW+30*86_400_000+2,Number.MAX_SAFE_INTEGER]){
    const outcome=plan(state(),evidence(),user("snooze",{untilMs:until}));
    assert.deepEqual(outcome,{ok:false,reason:"invalid"},String(until));
  }
  const edge=plan(state(),evidence(),
    user("snooze",{untilMs:NOW+1+30*86_400_000}));
  assert.equal(edge.ok,true,"maximum of thirty days exactly should be allowed");
});

test("stale revision, CAS and rollback cannot change state",()=>{
  assert.deepEqual(plan(state(),evidence({candidate:candidate({sourceRevision:2})}),
    user("dismiss")),{ok:false,reason:"stale"});
  assert.deepEqual(plan(state(),evidence({candidate:candidate({sourceRevision:4})}),
    user("dismiss")),{ok:false,reason:"stale"});
  assert.deepEqual(plan(state(),evidence(),
    user("dismiss",{expectedChangedAtMs:NOW-1})),{ok:false,reason:"stale"});
  assert.deepEqual(plan(state(),evidence(),
    user("dismiss",{expectedSourceRevision:2})),{ok:false,reason:"stale"});
  assert.deepEqual(plan(state(),evidence(),
    user("dismiss",{nowMs:NOW-1})),{ok:false,reason:"invalid"});
  assert.equal(plan(state(),evidence({candidate:candidate({sourceRevision:4})}),
    {kind:"recheck",nowMs:NOW+1}).record.sourceRevision,4);
});

test("cross-actor, restore generation, rule, task and occurrence never inherit state",()=>{
  const altered=[
    evidence({actorUserId:"alice"}),
    evidence({restoreGeneration:randomUUID()}),
    evidence({candidate:{...candidate(),taskId:"task-2",
      attentionKey:attentionKey("deadline_soon","task-2","2026-11-09")}}),
    evidence({candidate:{...candidate(),ruleId:"deadline_overdue",
      attentionKey:attentionKey("deadline_overdue","task-1","2026-11-09")}}),
    evidence({candidate:{...candidate(),relevantOn:"2026-11-10",
      attentionKey:attentionKey("deadline_soon","task-1","2026-11-10")}}),
  ];
  for(const proof of altered)
    assert.deepEqual(plan(state(),proof,user("dismiss")),
      {ok:false,reason:"unavailable"});
});

test("unknown, malformed or content-bearing records and evidence are rejected",()=>{
  for(const record of [
    null,undefined,{},state({title:"private secret"}),
    state({actorUserId:"another actor"}),state({restoreGeneration:"wrong"}),
    state({attentionKey:"tatt1:fake"}),state({taskId:"bad\nid"}),
    state({ruleId:"other"}),state({relevantOn:"2026-02-30"}),
    state({sourceRevision:-1}),state({snoozeUntilMs:NOW+100}),
    state({state:"snoozed",snoozeUntilMs:null}),
    state({state:"snoozed",snoozeUntilMs:NOW-1,changedAtMs:NOW}),
  ])assert.equal(plan(record,evidence(),user("dismiss")).ok,false,
    JSON.stringify(record));
  for(const proof of [
    null,{},evidence({title:"somebody else's title"}),
    evidence({candidate:{...candidate(),title:"private"}}),
    evidence({candidate:{...candidate(),attentionKey:"tatt1:fake"}}),
    evidence({candidate:{...candidate(),relevantOn:"2026-02-30"}}),
  ])assert.equal(plan(state(),proof,user("dismiss")).ok,false,
    JSON.stringify(proof));
  assert.deepEqual(plan(state(),evidence(),{kind:"archive",nowMs:NOW+1}),
    {ok:false,reason:"invalid"});
  assert.deepEqual(plan(state(),evidence(),
    user("dismiss",{extraActor:"alice"})),{ok:false,reason:"invalid"});
  assert.deepEqual(plan(state(),evidence(),
    {kind:"recheck",nowMs:NOW+1,untrustedScope:"shared"}),
    {ok:false,reason:"invalid"});
});

test("fresh material occurrence makes a new key instead of reusing a dismissal",()=>{
  const dismissed=plan(state(),evidence(),user("dismiss")).record;
  const soon=candidate();
  const overdue=candidate({ruleId:"deadline_overdue",
    attentionKey:attentionKey("deadline_overdue","task-1",soon.relevantOn)});
  assert.notEqual(soon.attentionKey,overdue.attentionKey);
  assert.deepEqual(plan(dismissed,evidence({candidate:overdue}),
    {kind:"recheck",nowMs:NOW+1000}),{ok:false,reason:"unavailable"});
});

test("no networking, persistence or legacy Attention mutator is imported",async()=>{
  const {readFileSync}=await import("node:fs");
  const {fileURLToPath}=await import("node:url");
  const {dirname,join}=await import("node:path");
  const current=dirname(fileURLToPath(import.meta.url));
  const body=readFileSync(join(current,"../lib/target-attention-lifecycle-policy.ts"),"utf8");
  assert.doesNotMatch(body,/from [^\n]*server-store|fetch\(|getDatabase\(|db\.prepare|localStorage|indexedDB/);
});
