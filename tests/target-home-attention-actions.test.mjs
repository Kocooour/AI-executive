import {test} from "node:test";
import assert from "node:assert/strict";
import {
  HOME_ATTENTION_LIMIT, readHomeAttention, readMoreHomeAttention, changeHomeAttention,
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
