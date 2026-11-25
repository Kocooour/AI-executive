import {test} from "node:test";
import assert from "node:assert/strict";
import {
  HOME_ATTENTION_LIMIT, readHomeAttention, readMoreHomeAttention, changeHomeAttention, undoHomeAttention,
} from "../lib/target-home-attention-actions.ts";

const item=(over={})=>({
  attentionKey:"tatt1:"+"a".repeat(64),subjectType:"task",taskId:"task-1",
  title:"Synthetic task",projectId:null,areaId:"area-private",areaKind:"private",
  ruleId:"deadline_overdue",ruleVersion:1,severity:1,reasonCode:"deadline_overdue",
  relevantOn:"2026-11-01",relevantAt:1793559599999,dueOn:"2026-11-01",whenOn:null,
  thresholdHours:0,sourceRevision:3,lifecycle:"active",snoozedUntilMs:null,
  lifecycleRevision:null,...over,
});
const page=(items=[item()],over={})=>({
  items,hasMore:false,nextCursor:null,areaFilter:"personal",view:"active",
  timeZone:"Europe/Prague",evaluationDate:"2026-11-08",soonThroughDate:"2026-11-10",
  evaluatedAtMs:1794000000000,attentionEpoch:4,...over,
});
const preview=(over={})=>({
  expectedRevision:"b".repeat(64),expectedAttentionEpoch:4,
  expectedStateRevision:null,writeAreaId:"area-private",
  restoreGeneration:"123e4567-e89b-42d3-a456-426614174000",
  lifecycle:"active",snoozedUntilMs:null,...over,
});
const json=(body,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
function recorder(...responses){
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url:String(url),method:init.method,body:init.body&&JSON.parse(init.body)});
    const response=responses[calls.length-1];
    if(!response)throw new Error("unexpected request");
    return response();
  };
  return {calls,fetcher};
}
const signal=()=>new AbortController().signal;
const witness=(over={})=>({item:item(over),attentionEpoch:4});

test("Home requests five private candidates only",async()=>{
  const {calls,fetcher}=recorder(()=>json(page()));
  const r=await readHomeAttention(signal(),fetcher);
  assert.equal(r.status,"ok");
  const u=new URL(calls[0].url,"https://example.invalid");
  assert.equal(u.searchParams.get("areaFilter"),"personal");
  assert.equal(u.searchParams.get("view"),"active");
  assert.equal(u.searchParams.get("limit"),String(HOME_ATTENTION_LIMIT));
  assert.equal(HOME_ATTENTION_LIMIT,5);
});

test("Home rejects shared rows rather than showing them",async()=>{
  const {fetcher}=recorder(()=>json(page([item({areaKind:"shared",assignedToMe:true})])));
  assert.equal((await readHomeAttention(signal(),fetcher)).status,"invalid_response");
});

test("More rejects nonpersonal previous page without a request",async()=>{
  const {calls,fetcher}=recorder();
  assert.equal((await readMoreHomeAttention(page([],{areaFilter:"all",hasMore:true,nextCursor:"a.b"}),signal(),fetcher)).status,"invalid");
  assert.equal(calls.length,0);
});

test("More appends only the same pinned evaluation and rejects a changed epoch",async()=>{
  const first=page(Array.from({length:5},(_,i)=>item({taskId:"task-"+i,
    attentionKey:"tatt1:"+"a".repeat(63)+i})),{hasMore:true,nextCursor:"a.b"});
  for(const epoch of [4,5]){
    const {calls,fetcher}=recorder(()=>json(page([item({taskId:"task-9",
      attentionKey:"tatt1:"+"a".repeat(63)+"9"})],{attentionEpoch:epoch})));
    const result=await readMoreHomeAttention(first,signal(),fetcher);
    assert.equal(result.status,epoch===4?"ok":"stale");
    if(result.status==="ok")assert.equal(result.page.items.length,6);
    assert.equal(new URL(calls[0].url,"https://example.invalid").searchParams.get("cursor"),"a.b");
  }
});

test("Lifecycle commands refuse shared or stale witnesses before PATCH",async()=>{
  const shared=recorder();
  assert.equal((await changeHomeAttention(witness({areaKind:"shared"}),"dismiss",null,signal(),shared.fetcher)).status,"invalid");
  assert.equal(shared.calls.length,0);
  for(const changed of [{expectedAttentionEpoch:5},{writeAreaId:"different"},
    {expectedStateRevision:1},{lifecycle:"dismissed",expectedStateRevision:0}]){
    const {calls,fetcher}=recorder(()=>json(preview(changed)));
    assert.equal((await changeHomeAttention(witness(),"dismiss",null,signal(),fetcher)).status,"conflict");
    assert.deepEqual(calls.map(c=>c.method),["GET"]);
  }
});

test("Dismiss and snooze issue one PATCH using the server preview",async()=>{
  for(const [action,until] of [["dismiss",null],["snooze",1794100000000]]){
    const {calls,fetcher}=recorder(()=>json(preview()),()=>json({ok:true}));
    assert.deepEqual(await changeHomeAttention(witness(),action,until,signal(),fetcher),{status:"ok"});
    assert.deepEqual(calls.map(c=>c.method),["GET","PATCH"]);
    assert.equal(new URL(calls[0].url,"https://example.invalid").searchParams.get("sourceRevision"),"3");
    const command=calls[1].body;
    assert.equal(command.taskId,"task-1");
    assert.equal(command.occurrenceOn,"2026-11-01");
    assert.equal(command.action,action);
    assert.equal(command.snoozedUntilMs,until);
    assert.equal(command.expectedRevision,preview().expectedRevision);
  }
});

test("Restore requires the exact hidden witness and matching lifecycle CAS",async()=>{
  const hidden=witness({lifecycle:"dismissed",lifecycleRevision:0});
  const {calls,fetcher}=recorder(()=>json(preview({lifecycle:"dismissed",expectedStateRevision:0})),()=>json({ok:true}));
  assert.deepEqual(await changeHomeAttention(hidden,"restore",null,signal(),fetcher),{status:"ok"});
  assert.equal(calls[1].body.expectedStateRevision,0);
  assert.equal(calls[1].body.action,"restore");
});

test("Uncertain PATCH reconciles exact receipt and never retries mutation",async()=>{
  for(const receipt of ["committed","not_recorded"]){
    const {calls,fetcher}=recorder(()=>json(preview()),()=>{throw Error("network");},()=>json({status:receipt}));
    const result=await changeHomeAttention(witness(),"dismiss",null,signal(),fetcher);
    assert.equal(result.status,receipt==="committed"?"ok":"uncertain");
    assert.deepEqual(calls.map(c=>c.method),["GET","PATCH","POST"]);
    assert.deepEqual(calls[2].body,calls[1].body);
  }
});

test("Aborted or refused preview sends no mutation",async()=>{
  const controller=new AbortController();
  controller.abort();
  const a=recorder();
  assert.equal((await changeHomeAttention(witness(),"dismiss",null,controller.signal,a.fetcher)).status,"aborted");
  assert.equal(a.calls.length,0);
  const b=recorder(()=>json({},403));
  assert.equal((await changeHomeAttention(witness(),"dismiss",null,signal(),b.fetcher)).status,"unauthorized");
  assert.equal(b.calls.length,1);
});

test("Undo restores only the exact confirmed hide, rejecting newer actor or task revision",async()=>{
  const original={
    commandId:"223e4567-e89b-42d3-a456-426614174001",taskId:"task-1",
    ruleId:"deadline_overdue",occurrenceOn:"2026-11-01",action:"dismiss",
    snoozedUntilMs:null,expectedRevision:preview().expectedRevision,
    expectedAttentionEpoch:4,expectedStateRevision:null,
    writeAreaId:"area-private",restoreGeneration:preview().restoreGeneration,
  };
  const hidden={expectedAttentionEpoch:5,expectedStateRevision:0,lifecycle:"dismissed"};
  const good=recorder(()=>json(preview(hidden)),()=>json({ok:true}));
  assert.deepEqual(await undoHomeAttention(original,signal(),good.fetcher),{status:"ok"});
  assert.equal(good.calls[1].body.action,"restore");
  for(const override of [{expectedAttentionEpoch:6},{expectedRevision:"c".repeat(64)},
    {writeAreaId:"other-area"},{restoreGeneration:"123e4567-e89b-42d3-a456-426614174999"},
    {expectedStateRevision:1}]){
    const stale=recorder(()=>json(preview({...hidden,...override})));
    assert.equal((await undoHomeAttention(original,signal(),stale.fetcher)).status,"conflict");
    assert.equal(stale.calls.length,1);
  }
});

test("Expired snooze replacement expects two lifecycle epoch increments before Undo",async()=>{
  const original={commandId:"223e4567-e89b-42d3-a456-426614174001",taskId:"task-1",
    ruleId:"deadline_soon",occurrenceOn:"2026-11-09",action:"snooze",
    snoozedUntilMs:1794100000000,expectedRevision:preview().expectedRevision,
    expectedAttentionEpoch:4,expectedStateRevision:0,
    writeAreaId:"area-private",restoreGeneration:preview().restoreGeneration};
  const hidden={expectedAttentionEpoch:6,expectedStateRevision:0,lifecycle:"snoozed",
    snoozedUntilMs:original.snoozedUntilMs};
  const good=recorder(()=>json(preview(hidden)),()=>json({ok:true}));
  assert.equal((await undoHomeAttention(original,signal(),good.fetcher)).status,"ok");
});

test("Home explanation is required for requested language and bound to exact ordered candidates",async()=>{
  const data=page();
  const key=data.items[0].attentionKey;
  const explanation={attentionKey:key,reason:"Po termínu · 1. 11. 2026",why:"Zdroj: termín úkolu. Vyhodnoceno: 8. 11. 2026 (Europe/Prague)."};
  const decorated={...data,explanationLanguage:"cs",explanations:[explanation]};
  const good=recorder(()=>json(decorated));
  const r=await readHomeAttention(signal(),good.fetcher,"cs");
  assert.equal(r.status,"ok");
  assert.equal(new URL(good.calls[0].url,"https://example.invalid").searchParams.get("explain"),"cs");
  assert.deepEqual(r.page.explanations,[explanation]);
  for(const bad of [data,{...decorated,explanationLanguage:"en"},
    {...decorated,explanations:[]},{...decorated,explanations:[{...explanation,attentionKey:"tatt1:"+"b".repeat(64)}]},
    {...decorated,explanations:[{...explanation,title:"private extra"}]},
    {...decorated,explanations:[{...explanation,why:""}]}]){
    const mock=recorder(()=>json(bad));
    assert.equal((await readHomeAttention(signal(),mock.fetcher,"cs")).status,"invalid_response");
  }
});

test("Server explanation derives source and time from pinned candidate without title or foreign data",async()=>{
  const {explainAttention}=await import("../lib/target-attention-explanation.ts");
  const epoch=Date.parse("2026-11-08T07:00:00Z");
  for(const [rule,cs,en] of [
    ["deadline_overdue","Po termínu","Overdue"],
    ["deadline_soon","Blíží se termín","Due soon"],
    ["planned_date_passed","Propadlé Kdy","Planned day passed"]]){
    const candidate=item({reasonCode:rule,ruleId:rule,title:"DO NOT COPY"});
    for(const [language,reason] of [["cs",cs],["en",en]]){
      const result=explainAttention(candidate,epoch,"Europe/Prague",language);
      assert.ok(result.reason.startsWith(reason));
      assert.match(result.why,/Europe\/Prague/);
      assert.match(result.why,/08:00|8:00/);
      assert.doesNotMatch(JSON.stringify(result),/DO NOT COPY/);
      assert.equal(result.attentionKey,candidate.attentionKey);
      assert.deepEqual(Object.keys(result).sort(),["attentionKey","reason","why"]);
    }
  }
});

test("Expanded Home page preserves locale and each explanation through cursor append",async()=>{
  const items=Array.from({length:5},(_,i)=>item({taskId:"task-"+i,attentionKey:"tatt1:"+"a".repeat(63)+i}));
  const decorate=p=>({...p,explanationLanguage:"cs",explanations:p.items.map(i=>({attentionKey:i.attentionKey,reason:"Po termínu",why:"Zdroj: termín úkolu"}))});
  const first=decorate(page(items,{hasMore:true,nextCursor:"a.b"}));
  const next=decorate(page([item({taskId:"task-9",attentionKey:"tatt1:"+"a".repeat(63)+"9"})]));
  const mock=recorder(()=>json(next));
  const r=await readMoreHomeAttention(first,signal(),mock.fetcher);
  assert.equal(r.status,"ok");
  assert.equal(r.page.explanations.length,6);
  assert.equal(new URL(mock.calls[0].url,"https://example.invalid").searchParams.get("explain"),"cs");
});
