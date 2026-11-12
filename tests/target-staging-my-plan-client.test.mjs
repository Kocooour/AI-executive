import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  appendMyPlanSlice,fetchMyPlanSlice,localMyPlanDate,
  parseMyPlanSlice,validMyPlanDate,
} from "../lib/target-staging-my-plan-client.ts";

const date="2026-11-05";
const task=(id,on,areaKind="private")=>({
  taskId:id,title:"Task "+id,projectId:null,
  areaId:areaKind==="private"?"area-a":"shared-a",
  areaKind,dueOn:on,whenOn:null,attentionOn:on,
  ...(areaKind==="shared"?{assignedToMe:true}:{})
});
const page=(today,tomorrow,opts={})=>({
  evaluationDate:date,areaFilter:"all",
  today:{tasks:today,hasMore:opts.todayMore??false},
  tomorrow:{tasks:tomorrow,hasMore:opts.tomorrowMore??false},
  undated:{tasks:opts.undated??[],hasMore:opts.undatedMore??false},
  hasMore:(opts.todayMore??false)||(opts.tomorrowMore??false)||
    (opts.undatedMore??false),
  nextCursor:opts.cursor??null,
});
const current=()=>page([task("old","2026-11-04")],
  [task("shared","2026-11-06","shared")]);
const params={evaluationDate:date,areaFilter:"all",limit:2};
const goodResponse=body=>Response.json(body,{
  headers:{"cache-control":"no-store"},
});

test("reads real public slice DTO with strict allowlist and both day buckets",async()=>{
  const expected=current();
  const result=parseMyPlanSlice(expected,params);
  assert.deepEqual(result,expected);
  const r=await fetchMyPlanSlice(params,async(url,opts)=>{
    assert.equal(opts.method,"GET");
    assert.equal(opts.credentials,"same-origin");
    assert.equal(opts.cache,"no-store");
    assert.equal(opts.redirect,"error");
    assert.match(String(url),/^\/api\/target-staging\/my-plan\/slice\?/);
    const q=new URL("http://localhost"+url).searchParams;
    assert.equal(q.get("evaluationDate"),date);
    assert.equal(q.get("areaFilter"),"all");
    assert.equal(q.get("limit"),"2");
    assert.equal(q.has("cursor"),false);
    return goodResponse(expected);
  });
  assert.deepEqual(r,{ok:true,page:expected});
});

test("rejects unexpected actor/revision fields, duplicate task, wrong scope and day",()=>{
  const fixture=current();
  for(const [name,mutate] of [
    ["actor leak",x=>{x.today.tasks[0].userId="bob";}],
    ["raw epochs",x=>{x.areaEpochs=[{areaId:"secret"}];}],
    ["duplicate",x=>{x.tomorrow.tasks.push({...x.today.tasks[0]});}],
    ["wrong window",x=>{x.tomorrow.tasks[0].attentionOn=date;
      x.tomorrow.tasks[0].dueOn=date;}],
    ["viewer shared",x=>{delete x.tomorrow.tasks[0].assignedToMe;}],
    ["wrong cursor",x=>{x.nextCursor="not-signed";x.hasMore=true;
      x.tomorrow.hasMore=true;}],
    ["unknown area",x=>{x.today.tasks[0].areaKind="world";}],
    ["secret id",x=>{x.today.tasks[0].taskId="x\0y";}],
  ]){
    const item=structuredClone(fixture);
    mutate(item);
    assert.equal(parseMyPlanSlice(item,params),null,name);
  }
  const personal={...current(),areaFilter:"personal"};
  assert.equal(parseMyPlanSlice(personal,{...params,areaFilter:"personal"}),null);
  assert.equal(parseMyPlanSlice(current(),{...params,evaluationDate:"2026-11-06"}),null);
});

test("bounded cursor pages append without duplicates, reordering or changed scope",()=>{
  const first=parseMyPlanSlice(page(
    [task("a","2026-11-04")],[task("b","2026-11-06")],
    {todayMore:true,tomorrowMore:true,cursor:"abc.def"}),{...params,limit:1});
  const next=parseMyPlanSlice(page(
    [task("c","2026-11-05")],[task("d","2026-11-06")]),{...params,limit:1});
  assert.ok(first&&next);
  const combined=appendMyPlanSlice(first,next);
  assert.ok(combined);
  assert.deepEqual(combined.today.tasks.map(t=>t.taskId),["a","c"]);
  assert.deepEqual(combined.tomorrow.tasks.map(t=>t.taskId),["b","d"]);
  assert.equal(combined.hasMore,false);
  assert.equal(combined.nextCursor,null);
  assert.equal(appendMyPlanSlice(first,first),null);
  assert.equal(appendMyPlanSlice(next,first),null);
  const wrong=structuredClone(next);
  wrong.evaluationDate="2026-11-06";
  assert.equal(appendMyPlanSlice(first,wrong),null);
  const reordered=structuredClone(next);
  reordered.today.tasks[0].attentionOn="2026-11-03";
  assert.equal(appendMyPlanSlice(first,reordered),null);
});

test("401/403 revoke, 409 stale, disabled and network loss never serve old data",async()=>{
  for(const [status,reason] of [[401,"signed-out"],[403,"signed-out"],
    [409,"stale"],[404,"unavailable"],[429,"unavailable"],[503,"unavailable"],
    [400,"invalid-request"]]){
    const result=await fetchMyPlanSlice(params,async()=>new Response(
      JSON.stringify(current()),{status,headers:{"cache-control":"no-store"}}));
    assert.deepEqual(result,{ok:false,reason},String(status));
  }
  assert.deepEqual(await fetchMyPlanSlice(params,async()=>{throw Error("offline");}),
    {ok:false,reason:"offline"});
  const controller=new AbortController();
  controller.abort();
  assert.deepEqual(await fetchMyPlanSlice({...params,signal:controller.signal},
    async()=>goodResponse(current())),{ok:false,reason:"aborted"});
});

test("client rejects non-no-store responses, redirects and malformed success",async()=>{
  const noCache=Response.json(current());
  assert.deepEqual(await fetchMyPlanSlice(params,async()=>noCache),
    {ok:false,reason:"invalid-response"});
  const extra=structuredClone(current());
  extra.today.privateEpoch=4;
  assert.deepEqual(await fetchMyPlanSlice(params,async()=>goodResponse(extra)),
    {ok:false,reason:"invalid-response"});
  assert.deepEqual(await fetchMyPlanSlice(params,
    async()=>new Response("not-json",{status:200,headers:{
      "cache-control":"no-store","content-type":"application/json",
    }})),{ok:false,reason:"invalid-response"});
});

test("calendar anchor is strictly local and rejects invalid/leaking input",async()=>{
  assert.equal(localMyPlanDate(new Date("2026-12-31T12:00:00Z")),
    new Date("2026-12-31T12:00:00Z").getFullYear()+"-"+String(
      new Date("2026-12-31T12:00:00Z").getMonth()+1).padStart(2,"0")+"-"+String(
      new Date("2026-12-31T12:00:00Z").getDate()).padStart(2,"0"));
  assert.equal(validMyPlanDate("2028-02-29"),true);
  assert.equal(validMyPlanDate("2026-02-29"),false);
  assert.equal(validMyPlanDate("2026-11-05T00:00Z"),false);
  for(const bad of ["2026-02-29","2026-12-31T23:00Z","9999-12-31"]){
    const result=await fetchMyPlanSlice({...params,evaluationDate:bad},
      async()=>{throw Error("must not call fetch");});
    assert.deepEqual(result,{ok:false,reason:"invalid-request"},bad);
  }
});

test("preview stays server-gated and direct HTTP writes are isolated in the transport",()=>{
  const root=path.join(import.meta.dirname,"..");
  const source=readFileSync(path.join(root,
    "app/target-staging/my-plan/preview/page.tsx"),"utf8");
  const ui=readFileSync(path.join(root,
    "app/ui/target-staging-my-plan-preview.tsx"),"utf8");
  for(const name of [
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_CLIENT_PREVIEW_ENABLED",
  ])assert.ok(source.includes(name),name);
  assert.match(source,/notFound\(\)/);
  assert.match(source,/myPlanStagingWriteUiEnabled\(process\.env\)/);
  assert.match(ui,/statusWriteEnabled=false/);
  assert.doesNotMatch(ui,/method:\s*["'](?:PATCH|POST|PUT|DELETE)/);
  assert.doesNotMatch(ui,/indexedDB|localStorage|sessionStorage|serviceWorker/);
});

test("BE-14 accepts legitimate 200 heavily JSON-escaped task titles",async()=>{
  const escaped="\u0001".repeat(4096);
  const today=Array.from({length:100},(_,i)=>({
    ...task("t"+String(i).padStart(3,"0"),date),title:escaped,
  }));
  const tomorrow=Array.from({length:100},(_,i)=>({
    ...task("n"+String(i).padStart(3,"0"),"2026-11-06"),title:escaped,
  }));
  const body=page(today,tomorrow);
  const encoded=new TextEncoder().encode(JSON.stringify(body));
  assert.ok(encoded.byteLength>4*1024*1024,"large valid page");
  const result=await fetchMyPlanSlice({...params,limit:100},
    async()=>goodResponse(body));
  assert.equal(result.ok,true);
  assert.equal(result.page.today.tasks.length,100);
  assert.equal(result.page.tomorrow.tasks.length,100);
  assert.equal(result.page.today.tasks[0].title.length,4096);
});

test("BE-14 bounds actual received bytes, not understated Content-Length",async()=>{
  let cancelled=false,pulls=0;
  const stream=new ReadableStream({
    pull(controller){
      pulls++;
      controller.enqueue(new Uint8Array(1024*1024).fill(32));
    },
    cancel(){cancelled=true;},
  });
  const result=await fetchMyPlanSlice(params,async()=>new Response(stream,{
    headers:{"content-type":"application/json","cache-control":"no-store",
      "content-length":"1"},
  }));
  assert.deepEqual(result,{ok:false,reason:"invalid-response"});
  assert.equal(cancelled,true);
  assert.ok(pulls<=12,"should not buffer unbounded response");
});

test("BE-14 rejects oversized or malformed Content-Length before reading",async()=>{
  for(const length of [String(8*1024*1024+1),"999999999999999999999",
    "1e7","-1","42,42","12x"]){
    let cancelled=false;
    const stream=new ReadableStream({cancel(){cancelled=true;}},{
      highWaterMark:0,
    });
    const result=await fetchMyPlanSlice(params,async()=>new Response(stream,{
      headers:{"content-type":"application/json","cache-control":"no-store",
        "content-length":length},
    }));
    assert.deepEqual(result,{ok:false,reason:"invalid-response"},length);
    assert.equal(cancelled,true,length);
  }
});

test("BE-14 strict UTF-8 and reject spoofed cache/MIME metadata",async()=>{
  const valid=JSON.stringify(current());
  const bytes=new TextEncoder().encode(valid);
  const marker=valid.indexOf('"title":"')+'"title":"'.length;
  assert.ok(marker>8);
  bytes[marker]=0xff;
  assert.deepEqual(await fetchMyPlanSlice(params,async()=>new Response(bytes,{
    headers:{"content-type":"application/json","cache-control":"no-store"},
  })),{ok:false,reason:"invalid-response"});
  for(const [cache,mime] of [
    ["x-no-store","application/json"],
    ['max-age=60, private="no-store"',"application/json"],
    ["no-store","text/plain; charset=application/json"],
  ]){
    let cancelled=false;
    const response=new Response(new ReadableStream({
      cancel(){cancelled=true;},
    },{highWaterMark:0}),{headers:{"cache-control":cache,
      "content-type":mime}});
    assert.deepEqual(await fetchMyPlanSlice(params,async()=>response),
      {ok:false,reason:"invalid-response"});
    assert.equal(cancelled,true);
  }
});

test("BE-14 abort cancels a stalled My Plan response body",async()=>{
  const controller=new AbortController();
  let begun;
  const started=new Promise(resolve=>{begun=resolve;});
  let cancelled=false;
  const stream=new ReadableStream({
    pull(){
      begun();
      return new Promise(()=>{});
    },
    cancel(){cancelled=true;},
  },{highWaterMark:0});
  const pending=fetchMyPlanSlice({...params,signal:controller.signal},
    async()=>new Response(stream,{headers:{
      "content-type":"application/json","cache-control":"no-store",
    }}));
  await started;
  controller.abort();
  const result=await Promise.race([
    pending,new Promise((_,reject)=>setTimeout(
      ()=>reject(Error("stalled My Plan reader")),2000)),
  ]);
  assert.deepEqual(result,{ok:false,reason:"aborted"});
  assert.equal(cancelled,true);
});


test("BE-15 pre-header abort settles when adapter ignores AbortSignal",async()=>{
  const controller=new AbortController();
  let calls=0,release;
  const pending=fetchMyPlanSlice({...params,signal:controller.signal},
    async(url,init)=>{
      calls++;
      assert.equal(init.signal,controller.signal);
      assert.equal(init.credentials,"same-origin");
      assert.equal(init.cache,"no-store");
      assert.equal(init.redirect,"error");
      return new Promise(resolve=>{release=resolve;});
    });
  assert.equal(calls,1,"GET dispatch remains synchronous");
  controller.abort();
  assert.deepEqual(await Promise.race([
    pending,
    new Promise((_,reject)=>setTimeout(()=>reject(Error("stalled headers")),2000)),
  ]),{ok:false,reason:"aborted"});
  let didCancel;
  const cancelled=new Promise(resolve=>{didCancel=resolve;});
  release(new Response(new ReadableStream({
    cancel(){didCancel();},
  },{highWaterMark:0}),{headers:{
    "content-type":"application/json","cache-control":"no-store",
  }}));
  await Promise.race([
    cancelled,
    new Promise((_,reject)=>setTimeout(()=>reject(Error("late body leaked")),2000)),
  ]);
  assert.equal(calls,1,"never retry aborted GET");
});

test("BE-15 adapter abort in dispatch cannot publish a late private page",async()=>{
  const controller=new AbortController();
  let cancelled=false;
  const response=new Response(new ReadableStream({
    cancel(){cancelled=true;},
  },{highWaterMark:0}),{headers:{
    "content-type":"application/json","cache-control":"no-store",
  }});
  const result=await fetchMyPlanSlice({...params,signal:controller.signal},
    async()=>{
      controller.abort();
      return response;
    });
  assert.deepEqual(result,{ok:false,reason:"aborted"});
  assert.equal(cancelled,true,"already returned body is discarded on abort");
});

test("BE-15 aborted signal never sends GET; overlapping reads stay ordered",async()=>{
  const firstController=new AbortController();
  const alreadyAborted=new AbortController();
  alreadyAborted.abort();
  let calls=0;
  assert.deepEqual(await fetchMyPlanSlice({
    ...params,signal:alreadyAborted.signal,
  },async()=>{calls++;return goodResponse(current());}),
  {ok:false,reason:"aborted"});
  assert.equal(calls,0);
  let releaseOld;
  const previous=fetchMyPlanSlice({...params,signal:firstController.signal},
    async()=>{
      calls++;
      return new Promise(resolve=>{releaseOld=resolve;});
    });
  assert.equal(calls,1);
  const newest=fetchMyPlanSlice(params,async()=>{
    calls++;
    return goodResponse(current());
  });
  assert.equal(calls,2,"a subsequent explicit request starts immediately");
  firstController.abort();
  assert.deepEqual(await previous,{ok:false,reason:"aborted"});
  assert.deepEqual(await newest,{ok:true,page:current()});
  let cancel;
  const cancelled=new Promise(resolve=>{cancel=resolve;});
  releaseOld(new Response(new ReadableStream({
    cancel(){cancel();},
  },{highWaterMark:0}),{headers:{
    "content-type":"application/json","cache-control":"no-store",
  }}));
  await Promise.race([
    cancelled,new Promise((_,reject)=>setTimeout(
      ()=>reject(Error("old stream remained open")),2000)),
  ]);
  assert.equal(calls,2);
});
