import assert from "node:assert/strict";
import {test} from "node:test";
const {planTargetAttentionPushes,targetAttentionDeliveryKey,targetAttentionPushPayload,inTargetQuietHours}=
  await import("../lib/target-attention-push-planner.ts");

const H=3_600_000;
const NOW=Date.parse("2026-11-04T12:00:00Z"); // 13:00 Prague, 21:00 Tokyo, 07:00 New York
const settings=(o={})=>({timeZone:"Europe/Prague",attentionPush:1,quietStart:"22:00",quietEnd:"08:00",dailyLimit:3,paused:0,...o});
const cand=(taskId,ruleId="deadline_overdue",o={})=>({
  attentionKey:"tatt1:x",subjectType:"task",taskId,title:"Úkol "+taskId,projectId:null,areaId:"a",areaKind:"private",
  ruleId,ruleVersion:1,severity:ruleId==="deadline_overdue"?1:ruleId==="deadline_soon"?2:5,reasonCode:ruleId,
  relevantOn:"2026-11-01",relevantAt:Date.parse("2026-11-01T23:00:00Z"),dueOn:"2026-11-01",whenOn:null,
  thresholdHours:0,sourceRevision:1,lifecycle:"active",snoozedUntilMs:null,lifecycleRevision:null,...o});
const plan=(o={})=>planTargetAttentionPushes({candidates:[cand("t1")],settings:settings(),handled:new Set(),sentInLast24h:0,nowMs:NOW,...o});

test("disabled or paused settings send nothing",()=>{
  for(const s of [settings({attentionPush:0}),settings({paused:1}),settings({attentionPush:false}),settings({paused:true})]){
    assert.deepEqual(plan({settings:s}),{send:[],held:"disabled"});
  }
  assert.equal(plan({settings:settings({attentionPush:true})}).send.length,1);
  // malformed settings fail closed
  for(const s of [null,settings({timeZone:"Nope/Zone"}),settings({quietStart:"25:00"}),settings({dailyLimit:11}),settings({dailyLimit:-1}),settings({timeZone:5})])
    assert.deepEqual(plan({settings:s}),{send:[],held:"disabled"},JSON.stringify(s));
  assert.deepEqual(plan({nowMs:-1}),{send:[],held:"disabled"});
});

test("quiet hours use each user's own stored zone at the same instant",()=>{
  const at=Date.parse("2026-11-04T21:30:00Z"); // 22:30 Prague (quiet), 06:30 next day Tokyo (quiet), 16:30 NY
  const prague=plan({nowMs:at,settings:settings({timeZone:"Europe/Prague"})});
  const newYork=plan({nowMs:at,settings:settings({timeZone:"America/New_York"})});
  const tokyoLate=plan({nowMs:Date.parse("2026-11-04T10:30:00Z"),settings:settings({timeZone:"Asia/Tokyo"})}); // 19:30
  assert.deepEqual(prague,{send:[],held:"quiet_hours"});
  assert.equal(newYork.send.length,1);assert.equal(newYork.held,null);
  assert.equal(tokyoLate.send.length,1);
  // Boundaries [22:00,08:00)
  assert.equal(inTargetQuietHours(Date.parse("2026-11-04T21:00:00Z"),"Europe/Prague","22:00","08:00"),true);
  assert.equal(inTargetQuietHours(Date.parse("2026-11-04T20:59:00Z"),"Europe/Prague","22:00","08:00"),false);
  assert.equal(inTargetQuietHours(Date.parse("2026-11-05T06:59:00Z"),"Europe/Prague","22:00","08:00"),true);
  assert.equal(inTargetQuietHours(Date.parse("2026-11-05T07:00:00Z"),"Europe/Prague","22:00","08:00"),false);
  // Custom, non-wrapping window and an empty one
  assert.equal(plan({settings:settings({quietStart:"12:00",quietEnd:"14:00"})}).held,"quiet_hours");
  assert.equal(plan({settings:settings({quietStart:"13:00",quietEnd:"13:00"})}).send.length,1);
  assert.throws(()=>inTargetQuietHours(NOW,"Nope/Zone","22:00","08:00"));
});

test("nothing pending yields held null, even in quiet hours",()=>{
  const at=Date.parse("2026-11-04T22:30:00Z");
  assert.deepEqual(plan({candidates:[],nowMs:at}),{send:[],held:null});
});

test("daily limit uses delivered+in-flight count and the user's configured limit",()=>{
  const cs=["a","b","c","d","e"].map(id=>cand(id));
  let r=plan({candidates:cs});
  assert.equal(r.send.length,3);assert.equal(r.held,"daily_limit");
  r=plan({candidates:cs,sentInLast24h:2});assert.equal(r.send.length,1);assert.equal(r.held,"daily_limit");
  r=plan({candidates:cs,sentInLast24h:3});assert.deepEqual(r,{send:[],held:"daily_limit"});
  r=plan({candidates:cs,sentInLast24h:99});assert.deepEqual(r,{send:[],held:"daily_limit"});
  r=plan({candidates:cs.slice(0,3)});assert.equal(r.held,null);
  r=plan({candidates:cs,settings:settings({dailyLimit:5})});assert.equal(r.send.length,5);assert.equal(r.held,null);
  r=plan({candidates:cs,settings:settings({dailyLimit:0})});assert.deepEqual(r,{send:[],held:"daily_limit"});
});

test("order: severity, relevantAt, delivery key; duplicates collapse; handled keys skipped",()=>{
  const soon=cand("s",  "deadline_soon",{relevantOn:"2026-11-05",relevantAt:5});
  const lateOver=cand("o2","deadline_overdue",{relevantAt:200});
  const earlyOver=cand("o1","deadline_overdue",{relevantAt:100});
  const r=plan({candidates:[soon,lateOver,earlyOver,{...earlyOver}],settings:settings({dailyLimit:10})});
  assert.deepEqual(r.send.map(x=>x.taskId),["o1","o2","s"]);
  // tie on severity and relevantAt: key order
  const a=cand("ta"),b=cand("tb");
  const keys=[a,b].map(c=>targetAttentionDeliveryKey(c.ruleId,c.taskId,c.relevantOn)).sort();
  assert.deepEqual(plan({candidates:[b,a]}).send.map(x=>x.deliveryKey),keys);
  const handled=new Set([targetAttentionDeliveryKey("deadline_overdue","o1","2026-11-01")]);
  assert.deepEqual(plan({candidates:[soon,lateOver,earlyOver],handled,settings:settings({dailyLimit:10})}).send.map(x=>x.taskId),["o2","s"]);
  // retry semantics: a failed-but-retryable key is simply left out of handled
  assert.equal(plan({candidates:[earlyOver],handled:new Set()}).send.length,1);
  assert.deepEqual(plan({candidates:[earlyOver],handled:new Set([targetAttentionDeliveryKey("deadline_overdue","o1","2026-11-01")])}),{send:[],held:null});
  assert.deepEqual(r.send[0],{deliveryKey:targetAttentionDeliveryKey("deadline_overdue","o1","2026-11-01"),taskId:"o1",ruleId:"deadline_overdue",occurrenceOn:"2026-11-01"});
});

test("only overdue/soon tasks; planned_date_passed and non-active lifecycle are never sent",()=>{
  const r=plan({settings:settings({dailyLimit:10}),candidates:[
    cand("p","planned_date_passed",{relevantOn:"2026-11-01"}),
    cand("sn","deadline_overdue",{lifecycle:"snoozed",snoozedUntilMs:NOW+H}),
    cand("di","deadline_soon",{lifecycle:"dismissed"}),
    cand("pr","deadline_overdue",{subjectType:"project"}),
    cand("bad","deadline_overdue",{relevantOn:"2026-13-45"}),
    cand("","deadline_overdue"),
    cand("ok","deadline_soon"),
  ]});
  assert.deepEqual(r.send.map(x=>x.taskId),["ok"]);
  assert.equal(plan({candidates:[cand("p","planned_date_passed")]}).send.length,0);
});

test("delivery key is stable, zone-independent and identity-only",()=>{
  const k=targetAttentionDeliveryKey("deadline_soon","t1","2026-11-05");
  assert.match(k,/^tad1:[0-9a-f]{64}$/);
  assert.equal(k,targetAttentionDeliveryKey("deadline_soon","t1","2026-11-05"));
  assert.notEqual(k,targetAttentionDeliveryKey("deadline_overdue","t1","2026-11-05"));
  assert.notEqual(k,targetAttentionDeliveryKey("deadline_soon","t2","2026-11-05"));
  assert.notEqual(k,targetAttentionDeliveryKey("deadline_soon","t1","2026-11-06"));
  for(const tz of ["Europe/Prague","Pacific/Auckland","America/Los_Angeles"]){
    const send=plan({settings:settings({timeZone:tz}),nowMs:Date.parse("2026-11-04T12:00:00Z"),candidates:[cand("t1","deadline_soon",{relevantOn:"2026-11-05"})]}).send;
    if(send.length)assert.equal(send[0].deliveryKey,k,tz);
  }
  assert.throws(()=>targetAttentionDeliveryKey("planned_date_passed","t1","2026-11-05"),TypeError);
  assert.throws(()=>targetAttentionDeliveryKey("deadline_soon","","2026-11-05"),TypeError);
  assert.throws(()=>targetAttentionDeliveryKey("deadline_soon","t1","5.11.2026"),TypeError);
});

test("payload uses only the candidate's own data",()=>{
  const p=targetAttentionPushPayload(cand("t 1/x","deadline_overdue",{title:"  Zavolat   notáři  ",relevantOn:"2026-11-01"}));
  assert.deepEqual(p,{title:"Zavolat notáři",body:"Termín 1. 11. uplynul.",url:"/?task=t%201%2Fx",tag:"attention-t 1/x"});
  const soon=targetAttentionPushPayload(cand("t2","deadline_soon",{relevantOn:"2026-12-24"}));
  assert.equal(soon.body,"Termín 24. 12. je do 48 hodin.");
  const long=targetAttentionPushPayload(cand("t3","deadline_overdue",{title:"😀".repeat(100)}));
  assert.equal(Array.from(long.title).length,80);assert.ok(long.title.endsWith("…"));
  assert.ok(!/�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long.title));
  // Output reveals nothing beyond title/rule/date/task id, even if the object carries extras.
  const extra=targetAttentionPushPayload({...cand("t4"),areaId:"SECRET-AREA",projectId:"SECRET-PROJECT",assigneeName:"SECRET"});
  assert.ok(!JSON.stringify(extra).includes("SECRET"));
  assert.deepEqual(Object.keys(extra).sort(),["body","tag","title","url"]);
  assert.equal(targetAttentionPushPayload(cand("t5","planned_date_passed")),null);
  assert.equal(targetAttentionPushPayload(cand("t6","deadline_soon",{lifecycle:"dismissed"})),null);
});
