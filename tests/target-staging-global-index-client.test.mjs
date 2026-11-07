import assert from "node:assert/strict";
import {test} from "node:test";
import {
  appendGlobalIndexPage,fetchGlobalIndexPage,parseGlobalIndexPage,
} from "../lib/target-staging-global-index-client.ts";

const project=(id="a",areaKind="private")=>({
  kind:"project",item:{id,title:"Project "+id,areaId:areaKind+"-area",areaKind},
});
const task=(id="a",areaKind="private",assignedToMe=false)=>({
  kind:"task",item:{id,title:"Task "+id,projectId:null,
    areaId:areaKind+"-area",areaKind,status:"open",dueOn:null,
    ...(areaKind==="shared"?{assignedToMe}:{}),
  },
});
const note=(id="a",areaKind="private")=>({
  kind:"note",item:{id,title:"Note "+id,projectId:null,
    areaId:areaKind+"-area",areaKind,revision:1},
});
const make=(items,scope="all",hasMore=false,nextCursor=null)=>({
  scope,items,hasMore,nextCursor,
});
const response=body=>Response.json(body,{headers:{"cache-control":"no-store"}});
const valid=()=>make([project("a"),task("a"),note("a"),
  project("s","shared"),task("s","shared",false),note("s","shared")]);
const params={scope:"all",limit:20};
const cursor="aA.bA";
test("R3 BE-16 Vše is not Můj plán: includes unassigned shared items and all three kinds",async()=>{
  const page=valid(),actual=parseGlobalIndexPage(page,params);
  assert.deepEqual(actual,page);
  assert.equal(actual.items[4].item.assignedToMe,false);
  assert.deepEqual(parseGlobalIndexPage(make(page.items.slice(0,3),"personal"),
    {scope:"personal",limit:20}).items,page.items.slice(0,3));
  assert.deepEqual(parseGlobalIndexPage(make(page.items.slice(3),"shared"),
    {scope:"shared",limit:20}).items,page.items.slice(3));
  assert.equal(parseGlobalIndexPage(page,{scope:"shared",limit:20}),null);
});

test("R3 BE-16 sends one explicit same-origin, no-store GET and signed cursor only",async()=>{
  const result=await fetchGlobalIndexPage({...params,cursor},async(url,init)=>{
    assert.equal(url,"/api/target-staging/global-index?scope=all&limit=20&cursor=aA.bA");
    assert.equal(init.method,"GET");
    assert.equal(init.credentials,"same-origin");
    assert.equal(init.cache,"no-store");
    assert.equal(init.redirect,"error");
    assert.deepEqual(init.headers,{accept:"application/json"});
    assert.equal(init.signal,undefined);
    return response(valid());
  });
  assert.deepEqual(result,{ok:true,page:valid()});
});

test("R3 BE-16 exact-key DTO rejects notes body and server-only ACL epoch/actor metadata",async()=>{
  const payload=valid();
  for(const altered of [
    {...payload,actorUserId:"alice"},
    {...payload,areaEpochs:[]},
    {...payload,linearization:{}},
    {...payload,items:[{...payload.items[0],actorId:"alice"}]},
    {...payload,items:[...payload.items.slice(0,5),{
      kind:"note",item:{...note("s","shared").item,body:"Secret"}},
    ]},
    {...payload,items:[{kind:"task",item:{...task("s","shared").item,
      assignedToUserId:"bob"}}]},
    {...payload,items:[{kind:"task",item:{...task("s","shared").item,
      assignedToMe:undefined}}]},
  ]){
    assert.equal(parseGlobalIndexPage(altered,params),null);
    assert.deepEqual(await fetchGlobalIndexPage(params,
      async()=>response(altered)),{ok:false,reason:"invalid-response"});
  }
});

test("R3 BE-16 enforces scope before rendering, including viewer and unassigned shared work",()=>{
  for(const scope of ["personal","shared"]){
    const wrong=scope==="shared"?project("a"):project("s","shared");
    assert.equal(parseGlobalIndexPage(make([wrong],scope),{scope,limit:20}),null);
  }
  assert.equal(parseGlobalIndexPage(make([{...task("s","shared"),
    item:{...task("s","shared").item,assignedToMe:"true"}}]),params),null);
  assert.deepEqual(parseGlobalIndexPage(make([task("s","shared",false)],"shared"),
    {scope:"shared",limit:20}).items,[task("s","shared",false)]);
});

test("R3 BE-16 strict id/status/date/revision, no extra task assignment metadata",()=>{
  for(const bad of [
    {...project(),item:{...project().item,id:".."}},
    {...project(),item:{...project().item,id:"\0x"}},
    {...task(),item:{...task().item,status:"active"}},
    {...task(),item:{...task().item,dueOn:"2026-02-30"}},
    {...note(),item:{...note().item,revision:-1}},
    {...note(),item:{...note().item,revision:0.5}},
    {...note(),item:{...note().item,id:" x"}},
    {...task(),item:{...task().item,assignedToMe:false}},
  ])assert.equal(parseGlobalIndexPage(make([bad]),params),null);
});

test("R3 BE-16 preserves UTF-8 BINARY order, kind ties, and distinct-id pagination",()=>{
  const first=make([project("a"),task("a"),note("a")],"all",true,cursor);
  const second=make([project("á"),task("á")]);
  assert.deepEqual(appendGlobalIndexPage(first,second),
    make([...first.items,...second.items]));
  assert.equal(parseGlobalIndexPage(make([project("á"),project("z")]),params),null,
    "UTF-8 z (0x7a) sorts before accented á (0xc3)");
  assert.equal(parseGlobalIndexPage(make([note("a"),task("a")]),params),null);
  assert.equal(parseGlobalIndexPage(make([project("a"),project("a")]),params),null);
  assert.equal(appendGlobalIndexPage(first,make([note("a")])),null);
  assert.equal(appendGlobalIndexPage(first,make([project("a")])),null);
  assert.equal(appendGlobalIndexPage(first,make([project("á")],"all",true,cursor)),null);
  assert.equal(appendGlobalIndexPage(first,make([project("á")],"shared")),null);
});

test("R3 BE-16 pagination rejects empty, oversized, duplicated or unsigned continuation",()=>{
  for(const v of [
    make([], "all",true,cursor),
    make([project()], "all",true,"malformed"),
    make([project()], "all",false,cursor),
    make([project(),project()], "all",false),
  ])assert.equal(parseGlobalIndexPage(v,params),null);
  assert.equal(parseGlobalIndexPage(make([project(),task()]),
    {scope:"all",limit:1}),null);
});

test("R3 BE-16 status mapping and body discard fail closed before parsing",async()=>{
  for(const [status,reason] of [[401,"signed-out"],[403,"signed-out"],
    [409,"stale"],[400,"invalid-request"],[429,"unavailable"],
    [404,"unavailable"],[503,"unavailable"]]){
    let cancelled=false;
    const x=await fetchGlobalIndexPage(params,async()=>new Response(
      new ReadableStream({cancel(){cancelled=true;}},{highWaterMark:0}),
      {status,headers:{"cache-control":"no-store","content-type":"application/json"}}));
    assert.deepEqual(x,{ok:false,reason});
    assert.equal(cancelled,true);
  }
});
test("R3 BE-16 rejects cache/MIME spoofing and invalid UTF-8",async()=>{
  for(const [cache,mime] of [
    ["max-age=60, private=\"no-store\"","application/json"],
    ["x-no-store","application/json"],
    ["no-store","text/plain; charset=application/json"],
  ]){
    let cancelled=false;
    const result=await fetchGlobalIndexPage(params,async()=>new Response(
      new ReadableStream({cancel(){cancelled=true;}},{highWaterMark:0}),
      {headers:{"cache-control":cache,"content-type":mime}}));
    assert.deepEqual(result,{ok:false,reason:"invalid-response"});
    assert.equal(cancelled,true);
  }
  assert.deepEqual(await fetchGlobalIndexPage(params,async()=>new Response(
    Uint8Array.of(0x7b,0xff,0x7d),{headers:{
      "cache-control":"no-store","content-type":"application/json"}})),
    {ok:false,reason:"invalid-response"});
});

test("R3 BE-16 refuses actual >8MiB and false low Content-Length",async()=>{
  let cancelled=false;
  const stream=new ReadableStream({
    pull(c){c.enqueue(new Uint8Array(1024*1024));},
    cancel(){cancelled=true;},
  });
  assert.deepEqual(await fetchGlobalIndexPage(params,async()=>new Response(
    stream,{headers:{"cache-control":"no-store",
      "content-type":"application/json","content-length":"1"}})),
    {ok:false,reason:"invalid-response"});
  assert.equal(cancelled,true);
});

test("R3 BE-16 rejects invalid scope, limit, signed cursor and pre-aborted calls without GET",async()=>{
  let calls=0;const fetcher=async()=>{calls++;return response(valid());};
  for(const props of [
    {scope:"my-plan"},{scope:"all",limit:0},{scope:"all",limit:101},
    {scope:"all",cursor:"../../actor"},{scope:"all",limit:1.1},
  ])assert.deepEqual(await fetchGlobalIndexPage(props,fetcher),
    {ok:false,reason:"invalid-request"});
  const controller=new AbortController();controller.abort();
  assert.deepEqual(await fetchGlobalIndexPage(
    {...params,signal:controller.signal},fetcher),
    {ok:false,reason:"aborted"});
  assert.equal(calls,0);
});

test("R3 BE-16 aborts before headers despite ignoring fetch adapter; cancels late private body",async()=>{
  const controller=new AbortController();
  let calls=0,release;
  const pending=fetchGlobalIndexPage({...params,signal:controller.signal},
    async(_url,init)=>{
      calls++;assert.equal(init.signal,controller.signal);
      return new Promise(resolve=>{release=resolve;});
    });
  assert.equal(calls,1,"synchronous explicit GET");
  controller.abort();
  assert.deepEqual(await Promise.race([
    pending,new Promise((_,reject)=>setTimeout(()=>reject(Error("stalled headers")),2000)),
  ]),{ok:false,reason:"aborted"});
  let onCancel;
  const canceled=new Promise(resolve=>{onCancel=resolve;});
  release(new Response(new ReadableStream({cancel(){onCancel();}},
    {highWaterMark:0}),{headers:{
      "cache-control":"no-store","content-type":"application/json"}}));
  await Promise.race([
    canceled,new Promise((_,reject)=>setTimeout(()=>reject(Error("leaked body")),2000)),
  ]);
  assert.equal(calls,1);
});

test("R3 BE-16 aborts blocked response-body read and returns no partial titles",async()=>{
  const controller=new AbortController();
  let start,wasCancelled=false;
  const begun=new Promise(resolve=>{start=resolve;});
  const stream=new ReadableStream({
    pull(){start();return new Promise(()=>{});},
    cancel(){wasCancelled=true;},
  },{highWaterMark:0});
  const pending=fetchGlobalIndexPage({...params,signal:controller.signal},
    async()=>new Response(stream,{headers:{
      "cache-control":"no-store","content-type":"application/json"}}));
  await begun;
  controller.abort();
  assert.deepEqual(await Promise.race([
    pending,new Promise((_,reject)=>setTimeout(()=>reject(Error("stalled body")),2000)),
  ]),{ok:false,reason:"aborted"});
  assert.equal(wasCancelled,true);
});
