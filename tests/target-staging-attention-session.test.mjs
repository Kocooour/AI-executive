import assert from "node:assert/strict";
import {test} from "node:test";
import {createAttentionSession} from "../lib/target-staging-attention-session.ts";

const REV="b".repeat(64);
const GEN="123e4567-e89b-42d3-a456-426614174000";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hdr={"cache-control":"no-store"};
const json=(body,status=200)=>Response.json(body,{status,headers:hdr});
const item=(n,over={})=>({
  attentionKey:"tatt1:"+String(n).repeat(64).slice(0,64),subjectType:"task",
  taskId:"task-"+n,title:"Private "+n,projectId:null,areaId:"area-private",
  areaKind:"private",ruleId:"deadline_overdue",ruleVersion:1,severity:1,
  reasonCode:"deadline_overdue",relevantOn:"2026-11-01",relevantAt:1793000000000,
  dueOn:"2026-11-01",whenOn:null,thresholdHours:0,sourceRevision:1,
  lifecycle:"active",snoozedUntilMs:null,lifecycleRevision:null,...over,
});
const body=(items,over={})=>({
  items,hasMore:false,nextCursor:null,areaFilter:"all",view:"active",
  timeZone:"Europe/Prague",evaluationDate:"2026-11-08",soonThroughDate:"2026-11-10",
  evaluatedAtMs:1794000000000,attentionEpoch:7,...over,
});
const preview=(over={})=>({
  expectedRevision:REV,expectedAttentionEpoch:7,expectedStateRevision:null,
  writeAreaId:"area-private",restoreGeneration:GEN,lifecycle:"active",
  snoozedUntilMs:null,...over,
});
const FIRST=()=>json(body([item(1),item(2)],{hasMore:true,nextCursor:"a.b"}));
/** Routes by URL; `h` may override any route. Records every call. */
function server(h={}){
  const calls=[];
  const f=async(url,init)=>{
    const u=new URL(String(url),"http://x");
    const key=(init?.method??"GET")+" "+u.pathname;
    calls.push({key,url:String(url),init});
    const handler=h[key]??h.default;
    if(!handler)throw Error("unexpected "+key);
    return handler(calls.filter(c=>c.key===key).length,u,init);
  };
  f.calls=calls;f.count=k=>calls.filter(c=>c.key===k).length;
  return f;
}
const PAGE="GET /api/target-staging/attention";
const PREVIEW="GET /api/target-staging/attention/command";
const PATCH="PATCH /api/target-staging/attention/command";
const RECEIPT="POST /api/target-staging/attention/command/receipt";
const make=(f,ctx=()=>"auth-1",over={})=>createAttentionSession({
  areaFilter:"all",view:"active",timeZone:"Europe/Prague",limit:2,
  contextVersion:ctx,fetch:f,...over});
const ready=async(f,ctx)=>{const s=make(f,ctx);assert.equal((await s.loadFirst()).ok,true);return s;};

test("nothing loads implicitly; loadMore before loadFirst is not-ready",async()=>{
  const f=server({[PAGE]:FIRST});
  const s=make(f);
  assert.deepEqual(s.getSnapshot(),{status:"idle"});
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"not-ready"});
  assert.equal(f.calls.length,0);
  const r=await s.loadFirst();
  assert.equal(r.ok,true);assert.equal(s.getSnapshot().status,"ready");
  assert.equal(f.calls.length,1,"no prefetch of the second page");
});

test("loadMore chains pages and refuses duplicates / cursor re-use",async()=>{
  const f=server({[PAGE]:n=>n===1?FIRST():
    json(body([item(3)],{evaluatedAtMs:1794000000000}))});
  const s=await ready(f);
  const r=await s.loadMore();
  assert.equal(r.ok,true);assert.equal(r.page.items.length,3);
  const url=new URL(f.calls[1].url,"http://x");
  assert.equal(url.searchParams.get("cursor"),"a.b");
  const dup=server({[PAGE]:n=>n===1?FIRST():json(body([item(2)]))});
  const d=await ready(dup);
  assert.deepEqual(await d.loadMore(),{ok:false,reason:"invalid_response"});
  assert.deepEqual(d.getSnapshot(),{status:"failed",reason:"invalid_response"});
  const instant=server({[PAGE]:n=>n===1?FIRST():
    json(body([item(3)],{evaluatedAtMs:1794000000001}))});
  const i=await ready(instant);
  assert.deepEqual(await i.loadMore(),{ok:false,reason:"invalid_response"});
});

test("snapshots and results are copy-out",async()=>{
  const s=await ready(server({[PAGE]:FIRST}));
  const a=s.getSnapshot();
  a.page.items[0].title="MUTATED";a.page.items.pop();
  const b=s.getSnapshot();
  assert.equal(b.page.items.length,2);assert.equal(b.page.items[0].title,"Private 1");
  assert.equal("attentionEpoch" in b.page,false);
  const more=await s.loadMore().catch(()=>null);void more;
});

test("non-ready states never expose items",async()=>{
  let release;
  const f=server({[PAGE]:()=>new Promise(r=>{release=r;})});
  const s=make(f);
  const p=s.loadFirst();
  assert.deepEqual(s.getSnapshot(),{status:"loading"});
  release(FIRST());await p;
  s.suspend();assert.deepEqual(s.getSnapshot(),{status:"suspended"});
  s.dispose();assert.deepEqual(s.getSnapshot(),{status:"disposed"});
  const failing=make(server({[PAGE]:()=>json({error:"Private leak"},503)}));
  await failing.loadFirst();
  assert.deepEqual(failing.getSnapshot(),{status:"failed",reason:"unavailable"});
});

test("busy: second loadMore while loading, act while loading",async()=>{
  let release;
  const f=server({[PAGE]:n=>n===1?FIRST():new Promise(r=>{release=r;})});
  const s=await ready(f);
  const pending=s.loadMore();
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"busy"});
  assert.deepEqual(await s.act(item(1),"dismiss"),{ok:false,reason:"busy"});
  release(json(body([item(3)])));
  assert.equal((await pending).ok,true);
});

test("context change is terminal, also A -> B -> A",async()=>{
  let v="A";
  const f=server({[PAGE]:FIRST});
  const s=await ready(f,()=>v);
  v="B";
  assert.deepEqual(s.getSnapshot(),{status:"failed",reason:"stale"});
  v="A";
  assert.deepEqual(s.getSnapshot(),{status:"failed",reason:"stale"});
  assert.deepEqual(await s.loadFirst(),{ok:false,reason:"stale"});
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"stale"});
  assert.deepEqual(await s.act(item(1),"dismiss"),{ok:false,reason:"stale"});
  assert.equal(s.resume(),false);
  assert.equal(f.calls.length,1);
});

test("context change while loading discards the late response",async()=>{
  let v="A",release;
  const s=make(server({[PAGE]:()=>new Promise(r=>{release=r;})}),()=>v);
  const p=s.loadFirst();v="B";
  release(FIRST());
  const r=await p;
  assert.equal(r.ok,false);
  assert.equal(s.getSnapshot().status,"failed");
});

test("invalid config and throwing contextVersion fail closed",async()=>{
  for(const over of [{areaFilter:"x"},{view:"x"},{timeZone:"Nope/Zone"},{limit:0},
    {limit:101},{contextVersion:()=>""},{contextVersion:()=>{throw Error("x");}}]){
    const f=server({[PAGE]:FIRST});
    const s=make(f,()=>"A",over);
    assert.deepEqual(await s.loadFirst(),{ok:false,reason:"invalid"});
    assert.equal(f.calls.length,0);
  }
});

test("suspend/resume wipes content and resume never fetches",async()=>{
  const f=server({[PAGE]:FIRST});
  const s=await ready(f);
  s.suspend();
  assert.deepEqual(s.getSnapshot(),{status:"suspended"});
  assert.deepEqual(await s.loadFirst(),{ok:false,reason:"not-ready"});
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"not-ready"});
  assert.deepEqual(await s.act(item(1),"dismiss"),{ok:false,reason:"not-ready"});
  assert.equal(s.resume(),true);
  assert.deepEqual(s.getSnapshot(),{status:"idle"});
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"not-ready"});
  assert.equal(f.calls.length,1,"resume is not a fetch");
  assert.equal((await s.loadFirst()).ok,true);
  assert.equal(f.calls.length,2);
  // resume without a suspend still wipes
  assert.equal(s.resume(),true);assert.deepEqual(s.getSnapshot(),{status:"idle"});
});

test("suspend aborts an in-flight read and late data is dropped",async()=>{
  let release,signal;
  const f=server({[PAGE]:(n,u,init)=>{signal=init.signal;return new Promise(r=>{release=r;});}});
  const s=make(f);
  const p=s.loadFirst();
  s.suspend();
  assert.equal(signal.aborted,true);
  assert.deepEqual(await p,{ok:false,reason:"superseded"});
  release(FIRST());
  assert.deepEqual(s.getSnapshot(),{status:"suspended"});
});

test("dispose aborts in-flight work and refuses everything after",async()=>{
  let signal;
  const f=server({[PAGE]:(n,u,init)=>{signal=init.signal;return new Promise(()=>{});}});
  const s=make(f);
  const p=s.loadFirst();
  s.dispose();
  assert.equal(signal.aborted,true);
  assert.deepEqual(await p,{ok:false,reason:"superseded"});
  assert.deepEqual(await s.loadFirst(),{ok:false,reason:"aborted"});
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"aborted"});
  assert.deepEqual(await s.act(item(1),"dismiss"),{ok:false,reason:"superseded"});
  assert.equal(s.resume(),false);
  assert.deepEqual(s.getSnapshot(),{status:"disposed"});
});

test("attentionEpoch change between pages invalidates the whole chain",async()=>{
  const f=server({[PAGE]:n=>n===1?FIRST():json(body([item(3)],{attentionEpoch:8}))});
  const s=await ready(f);
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"invalidated"});
  assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"not-ready"});
  assert.equal(f.count(PAGE),2);
  const fresh=await s.loadFirst();
  assert.equal(fresh.ok,true);
});

const happy=(over={})=>server({
  [PAGE]:FIRST,[PREVIEW]:()=>json(preview()),[PATCH]:()=>json({ok:true}),...over,
});

test("act: preview then PATCH built only from server data, then invalidated",async()=>{
  const f=happy();
  const s=await ready(f);
  // caller-supplied fields are ignored: only the attentionKey selects a loaded row
  const forged={attentionKey:item(1).attentionKey,taskId:"EVIL",ruleId:"deadline_soon",
    areaId:"other",actorUserId:"x",expectedRevision:"y"};
  const r=await s.act(forged,"snooze",1794003600000);
  assert.deepEqual(r,{ok:true,outcome:"committed",replayed:false});
  const pv=new URL(f.calls.find(c=>c.key===PREVIEW).url,"http://x");
  assert.equal(pv.searchParams.get("taskId"),"task-1");
  assert.equal(pv.searchParams.get("ruleId"),"deadline_overdue");
  assert.equal(pv.searchParams.get("occurrenceOn"),"2026-11-01");
  const sent=JSON.parse(f.calls.find(c=>c.key===PATCH).init.body);
  assert.deepEqual(Object.keys(sent).sort(),["action","commandId","expectedAttentionEpoch",
    "expectedRevision","expectedStateRevision","occurrenceOn","restoreGeneration","ruleId",
    "snoozedUntilMs","taskId","timeZone","writeAreaId"]);
  assert.equal(sent.taskId,"task-1");assert.equal(sent.ruleId,"deadline_overdue");
  assert.equal(sent.expectedRevision,REV);assert.equal(sent.writeAreaId,"area-private");
  assert.equal(sent.restoreGeneration,GEN);assert.equal(sent.timeZone,"Europe/Prague");
  assert.equal(sent.snoozedUntilMs,1794003600000);assert.equal(sent.action,"snooze");
  assert.match(sent.commandId,UUID);
  assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
  assert.equal(f.count(PAGE),1,"never refetches or patches the list by itself");
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"not-ready"});
  assert.deepEqual(await s.act(item(1),"dismiss"),{ok:false,reason:"not-ready"});
});

test("act uses a fresh commandId every time",async()=>{
  const ids=new Set();
  for(let i=0;i<3;i++){
    const f=happy();const s=await ready(f);
    await s.act(item(1),"dismiss");
    ids.add(JSON.parse(f.calls.find(c=>c.key===PATCH).init.body).commandId);
  }
  assert.equal(ids.size,3);
});

test("act argument validation does not touch the cache or network",async()=>{
  const f=happy();const s=await ready(f);
  assert.deepEqual(await s.act(item(1),"snooze"),{ok:false,reason:"invalid-request"});
  assert.deepEqual(await s.act(item(1),"snooze",0),{ok:false,reason:"invalid-request"});
  assert.deepEqual(await s.act(item(1),"dismiss",5),{ok:false,reason:"invalid-request"});
  assert.deepEqual(await s.act(item(1),"nuke"),{ok:false,reason:"invalid-request"});
  assert.deepEqual(await s.act(item(9),"dismiss"),{ok:false,reason:"unknown-item"});
  assert.deepEqual(await s.act(null,"dismiss"),{ok:false,reason:"unknown-item"});
  assert.equal(f.calls.length,1);
  assert.equal(s.getSnapshot().status,"ready");
});

test("act with replayed:true reports replay, still invalidates",async()=>{
  const f=happy({[PATCH]:()=>json({ok:true,replayed:true})});
  const s=await ready(f);
  assert.deepEqual(await s.act(item(1),"dismiss"),
    {ok:true,outcome:"committed",replayed:true});
  assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
});

for(const [name,patch,reason] of [
  ["conflict",()=>json({error:"Revision conflict"},409),"conflict"],
  ["not_found",()=>json({error:"Not found"},404),"not_found"],
  ["invalid",()=>json({error:"Invalid request"},400),"invalid"],
  ["unauthorized",()=>json({error:"Unauthorized"},401),"unauthorized"],
  ["rate limited",()=>json({error:"Too many"},429),"unavailable"],
]){
  test("act "+name+" drops the cache and sends no receipt request",async()=>{
    const f=happy({[PATCH]:patch});
    const s=await ready(f);
    assert.deepEqual(await s.act(item(1),"dismiss"),{ok:true,outcome:"rejected",reason});
    assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
    assert.equal(f.count(RECEIPT),0);assert.equal(f.count(PATCH),1,"no retry");
  });
}

for(const [name,pv,reason] of [
  ["preview 404",()=>json({error:"Not found"},404),"not_found"],
  ["preview 401",()=>json({error:"x"},401),"unauthorized"],
  ["preview 503",()=>json({error:"x"},503),"unavailable"],
  ["preview garbage",()=>json({surprise:true}),"invalid_response"],
]){
  test("act "+name+" drops the cache and never sends a PATCH",async()=>{
    const f=happy({[PREVIEW]:pv});
    const s=await ready(f);
    assert.deepEqual(await s.act(item(1),"dismiss"),{ok:true,outcome:"rejected",reason});
    assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
    assert.equal(f.count(PATCH),0);
  });
}

test("act refuses to send when the preview shows another tab already acted",async()=>{
  for(const pv of [preview({expectedAttentionEpoch:8}),
    preview({lifecycle:"dismissed",expectedStateRevision:0}),
    preview({expectedStateRevision:3})]){
    const f=happy({[PREVIEW]:()=>json(pv)});
    const s=await ready(f);
    assert.deepEqual(await s.act(item(1),"snooze",1794003600000),
      {ok:true,outcome:"rejected",reason:"stale"});
    assert.equal(f.count(PATCH),0);
    assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
  }
});

test("act refuses a transition the lifecycle cannot make (restore of active)",async()=>{
  const f=happy();const s=await ready(f);
  assert.deepEqual(await s.act(item(1),"restore"),
    {ok:true,outcome:"rejected",reason:"conflict"});
  assert.equal(f.count(PATCH),0);
  assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
});

test("act restore of a dismissed item in the hidden view",async()=>{
  const hidden=item(1,{lifecycle:"dismissed",lifecycleRevision:2});
  const f=happy({[PAGE]:()=>json(body([hidden],{view:"hidden"})),
    [PREVIEW]:()=>json(preview({lifecycle:"dismissed",expectedStateRevision:2}))});
  const s=make(f,()=>"auth-1",{view:"hidden"});
  await s.loadFirst();
  assert.deepEqual(await s.act(hidden,"restore"),
    {ok:true,outcome:"committed",replayed:false});
  const sent=JSON.parse(f.calls.find(c=>c.key===PATCH).init.body);
  assert.equal(sent.expectedStateRevision,2);assert.equal(sent.snoozedUntilMs,null);
  assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
});

for(const [name,patch] of [
  ["503",()=>json({error:"x"},503)],
  ["network loss",()=>{throw Error("offline");}],
  ["garbage 200",()=>json({nope:1})],
]){
  for(const [receiptName,receiptHandler,expected] of [
    ["committed",()=>json({status:"committed"}),"committed"],
    ["not_recorded",()=>json({status:"not_recorded"}),"not_recorded"],
    ["unavailable",()=>json({error:"x"},503),"unknown"],
    ["network",()=>{throw Error("x");},"unknown"],
  ]){
    test("act uncertain ("+name+") asks the receipt once: "+receiptName,async()=>{
      const f=happy({[PATCH]:patch,[RECEIPT]:receiptHandler});
      const s=await ready(f);
      assert.deepEqual(await s.act(item(1),"dismiss"),
        {ok:true,outcome:"uncertain",receipt:expected});
      assert.equal(f.count(PATCH),1,"never retried");
      assert.equal(f.count(RECEIPT),1,"exactly one receipt call");
      const patchBody=JSON.parse(f.calls.find(c=>c.key===PATCH).init.body);
      const receiptBody=JSON.parse(f.calls.find(c=>c.key===RECEIPT).init.body);
      assert.deepEqual(receiptBody,patchBody,"receipt of the SAME command");
      assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
      assert.equal(f.count(PAGE),1);
    });
  }
}

test("act drops the list before any await: no stale items while pending",async()=>{
  let release;
  const f=happy({[PREVIEW]:()=>new Promise(r=>{release=r;})});
  const s=await ready(f);
  const p=s.act(item(1),"dismiss");
  assert.deepEqual(s.getSnapshot(),{status:"acting"});
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"busy"});
  assert.deepEqual(await s.loadFirst(),{ok:false,reason:"busy"});
  assert.deepEqual(await s.act(item(2),"dismiss"),{ok:false,reason:"busy"});
  release(json(preview()));
  assert.equal((await p).ok,true);
  assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
});

test("after invalidation only an explicit loadFirst/reload shows data again",async()=>{
  let n=0;
  const f=happy({[PAGE]:()=>{n++;return json(body([item(n===1?1:5)]));}});
  const s=await ready(f);
  await s.act(item(1),"dismiss");
  assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
  const r=await s.reload();
  assert.equal(r.ok,true);
  assert.deepEqual(r.page.items.map(i=>i.taskId),["task-5"]);
  assert.equal(s.getSnapshot().page.items.some(i=>i.taskId==="task-1"),false,
    "no foreign data survives the invalidation");
  // the fresh baseline epoch is learned from the new first page
  const f2=happy({[PAGE]:n2=>json(body([item(1),item(2)],
    {hasMore:true,nextCursor:"a.b",attentionEpoch:n2===1?7:9}))});
  const t=await ready(f2);
  await t.act(item(1),"dismiss");
  await t.reload();
  assert.equal(t.getSnapshot().status,"ready");
});

test("suspend/dispose/context change during act: no receipt under another identity",async()=>{
  for(const how of ["suspend","dispose","context"]){
    let v="A",release,calls=0;
    const f=happy({[PATCH]:()=>{calls++;return new Promise(r=>{release=r;});}});
    const s=await ready(f,()=>v);
    const p=s.act(item(1),"dismiss");
    await new Promise(r=>setTimeout(r,20));
    assert.equal(calls,1,how);
    if(how==="suspend")s.suspend();
    if(how==="dispose")s.dispose();
    if(how==="context")v="B";
    s.getSnapshot();
    release(json({error:"x"},503));
    const r=await p;
    assert.deepEqual(r,{ok:true,outcome:"uncertain",receipt:"unknown"},how);
    assert.equal(f.count(RECEIPT),0,how);
    assert.notEqual(s.getSnapshot().status,"ready",how);
  }
  // before the PATCH is sent, the act simply fails closed
  let v="A",release;
  const f=happy({[PREVIEW]:()=>new Promise(r=>{release=r;})});
  const s=await ready(f,()=>v);
  const p=s.act(item(1),"dismiss");
  v="B";release(json(preview()));
  assert.deepEqual(await p,{ok:false,reason:"stale"});
  assert.equal(f.count(PATCH),0);
});

test("fetch is always called with same-origin, no-store",async()=>{
  const f=happy();const s=await ready(f);
  await s.act(item(1),"dismiss");
  for(const c of f.calls){
    assert.equal(c.init.credentials,"same-origin");
    assert.equal(c.init.cache,"no-store");
    assert.equal(c.init.redirect,"error");
  }
});

test("no persistence API is touched by a full lifecycle",async()=>{
  const touched=[];
  const trap=name=>new Proxy({},{get(_,k){touched.push(name+"."+String(k));return ()=>{};},
    set(){touched.push(name+".set");return true;}});
  const names=["indexedDB","localStorage","sessionStorage","caches"];
  const saved=Object.fromEntries(names.map(n=>[n,Object.getOwnPropertyDescriptor(globalThis,n)]));
  for(const n of names)Object.defineProperty(globalThis,n,{value:trap(n),configurable:true});
  try{
    const f=happy();const s=await ready(f);
    await s.loadMore().catch(()=>null);
    await s.act(item(1),"dismiss");
    await s.reload();s.suspend();s.resume();s.dispose();
  }finally{
    for(const n of names){
      if(saved[n])Object.defineProperty(globalThis,n,saved[n]);else delete globalThis[n];
    }
  }
  assert.deepEqual(touched,[]);
});

test("a failed network read never leaves old items behind",async()=>{
  let n=0;
  const f=server({[PAGE]:()=>{n++;return n===1?FIRST():json({error:"x"},503);}});
  const s=await ready(f);
  assert.deepEqual(await s.loadFirst(),{ok:false,reason:"unavailable"});
  assert.deepEqual(s.getSnapshot(),{status:"failed",reason:"unavailable"});
  assert.deepEqual(await s.loadMore(),{ok:false,reason:"not-ready"});
});

test("act without a secure-context UUID source ends invalidated, never wedges, sends no PATCH",async(t)=>{
  const f=happy();
  const s=await ready(f);
  t.mock.method(globalThis.crypto,"randomUUID",()=>{throw new TypeError("not available");});
  assert.deepEqual(await s.act(item(1),"dismiss"),{ok:true,outcome:"rejected",reason:"unavailable"});
  assert.equal(f.count(PATCH),0);
  assert.deepEqual(s.getSnapshot(),{status:"invalidated"});
  t.mock.restoreAll();
  assert.equal((await s.loadFirst()).ok,true,"session is usable again after an explicit reload");
});
