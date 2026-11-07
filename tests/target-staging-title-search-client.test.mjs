import assert from "node:assert/strict";
import {test} from "node:test";

const {loadStagingTitleSearchPage,parseTitleSearchPage,validTitleSearchQuery}=
  await import("../lib/target-staging-title-search-client.ts");

const cursor="e30."+ "X".repeat(43);
const item=(kind,id,areaKind="shared")=>({
  kind,id,title:"Shared project",areaId:"family-area",areaKind,
  ...(kind==="project"?{}:{projectId:"p-main"}),
});
const page=(items=[item("project","a-project"),item("task","b-task")],
  hasMore=true)=>({
  query:"Shared project",scope:"shared",items,hasMore,
  nextCursor:hasMore?cursor:null,
});
function json(body,options={}){
  return new Response(JSON.stringify(body),{
    status:options.status??200,
    headers:{"content-type":"application/json","cache-control":"no-store",
      ...(options.headers??{})},
  });
}

test("BE-16 query validation matches server word and literal-wildcard domain",()=>{
  for(const q of ["Shared project","100% _plan!","a b c d e f g h",
    "České projekty", "Shared    project"])
    assert.equal(validTitleSearchQuery(q),true,q);
  for(const q of ["","x"," Shared","Shared ","\u0000x","a\nb",
    "a b c d e f g h i","x".repeat(81),"\ud800bad"])
    assert.equal(validTitleSearchQuery(q),false,JSON.stringify(q));
});

test("BE-16 safe same-origin GET, typed results and explicit HMAC continuation",async()=>{
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url,init});
    const q=new URL(url,"http://localhost").searchParams;
    assert.deepEqual([...q.keys()].sort(),
      calls.length===1?["limit","q","scope"]:["cursor","limit","q","scope"]);
    assert.equal(q.get("q"),"Shared project");
    assert.equal(q.get("scope"),"shared");
    assert.equal(q.get("limit"),"2");
    if(calls.length===2)assert.equal(q.get("cursor"),cursor);
    assert.equal(init.method,"GET");
    assert.equal(init.credentials,"same-origin");
    assert.equal(init.cache,"no-store");
    assert.equal(init.redirect,"error");
    assert.deepEqual(init.headers,{accept:"application/json"});
    return calls.length===1?json(page()):json(page(
      [item("note","c-note")],false));
  };
  const first=await loadStagingTitleSearchPage({
    query:"Shared project",scope:"shared",limit:2,
  },fetcher);
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.equal(first.page.hasMore,true);
  assert.equal(first.page.nextCursor,cursor);
  const second=await loadStagingTitleSearchPage({
    query:"Shared project",scope:"shared",limit:2,cursor:first.page.nextCursor,
  },fetcher);
  assert.equal(second.ok,true,JSON.stringify(second));
  assert.deepEqual(second.page.items.map(x=>x.id),["c-note"]);
  assert.equal(second.page.nextCursor,null);
  assert.equal(calls.length,2);
  assert.equal(calls[0].url.split("?")[0],"/api/target-staging/title-search");
});

test("BE-16 stale/revoked responses never retry or preserve a false success",async()=>{
  for(const [status,reason] of [
    [401,"signed-out"],[403,"signed-out"],[404,"disabled"],
    [409,"stale"],[400,"invalid-request"],[429,"rate-limited"],
    [503,"unavailable"]]){
    let count=0;
    const result=await loadStagingTitleSearchPage({
      query:"Shared project",scope:"shared",limit:2,cursor,
    },async()=>{count++;return json({error:"status"},{status});});
    assert.deepEqual(result,{ok:false,reason});
    assert.equal(count,1,"no implicit restart or retry after stale cursor");
  }
});

test("BE-16 hard limits prevent invalid requests reaching fetch",async()=>{
  let count=0;
  const fetcher=async()=>{count++;throw Error("must not fetch");};
  for(const options of [
    {query:"x"},{query:"Shared project",scope:"foreign"},
    {query:"Shared project",limit:0},
    {query:"Shared project",limit:51},
    {query:"Shared project",limit:1.5},
    {query:"Shared project",cursor:"bad"},
    {query:"Shared project",cursor:"A".repeat(4097)+".x"},
  ]){
    const r=await loadStagingTitleSearchPage(options,fetcher);
    assert.deepEqual(r,{ok:false,reason:"invalid-request"});
  }
  assert.equal(count,0);
});

test("BE-16 strict DTO refuses extra fields, bad ordering, scope and cursor",async()=>{
  const good=page();
  assert.ok(parseTitleSearchPage(good,{query:good.query,scope:"shared",limit:2}));
  const corrupt=[
    {...good,query:"other"},
    {...good,scope:"all"},
    {...good,extra:"owner_user_id"},
    {...good,items:[{...good.items[0],assigneeUserId:"bob"},good.items[1]]},
    {...good,items:[{...good.items[0],areaKind:"private"},good.items[1]]},
    {...good,items:[{...good.items[0],title:" "},good.items[1]]},
    {...good,items:[{...good.items[0],id:".."},good.items[1]]},
    {...good,items:[good.items[1],good.items[0]]},
    {...good,items:[good.items[0],good.items[0]]},
    {...good,items:[{...good.items[0],projectId:"secret"},good.items[1]]},
    {...good,items:[good.items[0],{...good.items[1],projectId:"\u0000"}]},
    {...good,hasMore:true,items:[good.items[0]]},
    {...good,hasMore:true,nextCursor:null},
    {...good,hasMore:false,nextCursor:cursor},
    {...good,hasMore:false,items:[good.items[0]],nextCursor:"unsafe"},
  ];
  for(const [idx,payload] of corrupt.entries()){
    assert.equal(parseTitleSearchPage(payload,
      {query:good.query,scope:"shared",limit:2}),null,"corrupt "+idx);
  }
  const sameId=page([item("project","same"),item("task","same")]);
  assert.ok(parseTitleSearchPage(sameId,
    {query:good.query,scope:"shared",limit:2}),
    "same ID across different kinds follows server rank ordering");
  assert.equal(parseTitleSearchPage(page([item("task","same"),
    item("project","same")]),{query:good.query,scope:"shared",limit:2}),null);
});

test("BE-16 rejects redirect/unsafe MIME/cache and network errors",async()=>{
  for(const response of [
    json(page(),{headers:{"cache-control":"public, max-age=300"}}),
    json(page(),{headers:{"content-type":"text/html"}}),
    new Response("{bad json",{headers:{
      "content-type":"application/json","cache-control":"no-store"}}),
    json(page([item("task","b"),item("project","a")])),
  ]){
    assert.deepEqual(await loadStagingTitleSearchPage({
      query:"Shared project",scope:"shared",limit:2,
    },async()=>response),{ok:false,reason:"invalid-response"});
  }
  assert.deepEqual(await loadStagingTitleSearchPage({
    query:"Shared project",
  },async()=>{throw Error("offline");}),{ok:false,reason:"offline"});
});

test("BE-16 abort before dispatch or during network/JSON never returns stale data",async()=>{
  const before=new AbortController();before.abort();
  let count=0;
  assert.deepEqual(await loadStagingTitleSearchPage({
    query:"Shared project",signal:before.signal,
  },async()=>{count++;return json(page());}),{ok:false,reason:"aborted"});
  assert.equal(count,0);
  const during=new AbortController();
  const result=await loadStagingTitleSearchPage({
    query:"Shared project",signal:during.signal,
  },async()=>{during.abort();return json(page());});
  assert.deepEqual(result,{ok:false,reason:"aborted"});
});

// Regression for P2 on merged PR #291: neither header may be authorized by a
// substring inside a different directive, a quoted parameter or a wrong MIME.
test("BE-16: reject deceptive cache directives instead of substring no-store",async()=>{
  const options={query:"Shared project",scope:"shared",limit:2};
  for(const cacheControl of [
    "x-no-store",
    "public, max-age=3600, x-no-store",
    "no-store-extra",
    "no-store=1",
    'private="foo,no-store,bar"',
    'private="unfinished, no-store',
  ]){
    let calls=0;
    const result=await loadStagingTitleSearchPage(options,async()=>{
      calls++;
      return json(page(),{headers:{"cache-control":cacheControl}});
    });
    assert.deepEqual(result,{ok:false,reason:"invalid-response"},cacheControl);
    assert.equal(calls,1,"no implicit retry");
  }
  for(const cacheControl of [
    "no-store",
    "NO-STORE",
    "private, max-age=0, no-store",
    'private="foo,no-store,bar", No-StOrE',
  ]){
    const result=await loadStagingTitleSearchPage(options,async()=>
      json(page(),{headers:{"cache-control":cacheControl}}));
    assert.equal(result.ok,true,cacheControl);
  }
});

test("BE-16: require JSON media type, not application/json in a parameter",async()=>{
  const options={query:"Shared project",scope:"shared",limit:2};
  for(const contentType of [
    "text/html; charset=application/json",
    "application/json-patch+json",
    "text/plain; name=application/json",
    "application/json-extra",
    "application/json, text/html",
  ]){
    const result=await loadStagingTitleSearchPage(options,async()=>
      json(page(),{headers:{"content-type":contentType}}));
    assert.deepEqual(result,{ok:false,reason:"invalid-response"},contentType);
  }
  for(const contentType of [
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    " application/json ; charset=UTF-8",
  ]){
    const result=await loadStagingTitleSearchPage(options,async()=>
      json(page(),{headers:{"content-type":contentType}}));
    assert.equal(result.ok,true,contentType);
  }
});


test("BE-18 accepts a streamed UTF-8 JSON page across byte boundaries",async()=>{
  const bytes=new TextEncoder().encode(JSON.stringify(page([
    {...item("project","a"),title:"Český projekt – úkol"},
  ],false)));
  let offset=0;
  const stream=new ReadableStream({
    pull(controller){
      if(offset===bytes.length){controller.close();return;}
      controller.enqueue(bytes.slice(offset,offset+1));
      offset++;
    },
  });
  const result=await loadStagingTitleSearchPage({
    query:"Shared project",scope:"shared",limit:2,
  },async()=>new Response(stream,{headers:{
    "content-type":"application/json","cache-control":"no-store",
  }}));
  assert.equal(result.ok,true);
  assert.equal(result.page.items[0].title,"Český projekt – úkol");
});

test("BE-18 retains legitimate 50-item pages with heavily escaped titles",async()=>{
  const largeTitle="\\u0001".repeat(4096);
  const items=Array.from({length:50},(_,i)=>({
    ...item("project",String(i).padStart(3,"0")),title:largeTitle,
  }));
  const body=JSON.stringify(page(items,false));
  assert.ok(new TextEncoder().encode(body).byteLength>1_000_000,
    "valid escaped JSON is larger than a simplistic 512 KiB cap");
  const result=await loadStagingTitleSearchPage({
    query:"Shared project",scope:"shared",limit:50,
  },async()=>new Response(body,{headers:{
    "content-type":"application/json","cache-control":"no-store",
  }}));
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.page.items.length,50);
  assert.equal(result.page.items[0].title.length,4096);
});

test("BE-18 rejects an over-limit stream without buffering its remainder",async()=>{
  let pulls=0,cancelled=false;
  const stream=new ReadableStream({
    pull(controller){
      pulls++;
      controller.enqueue(new Uint8Array(256*1024).fill(32));
    },
    cancel(){cancelled=true;},
  });
  const result=await loadStagingTitleSearchPage({
    query:"Shared project",scope:"shared",limit:2,
  },async()=>new Response(stream,{headers:{
    "content-type":"application/json","cache-control":"no-store",
  }}));
  assert.deepEqual(result,{ok:false,reason:"invalid-response"});
  assert.equal(cancelled,true,"cancel surplus response data");
  assert.ok(pulls<=12,"do not consume unlimited response chunks");
});

test("BE-18 rejects oversized or forged Content-Length without reading body",async()=>{
  for(const length of [String(2*1024*1024+1),"999999999999999999999",
    "1e6","-1","20,20"," 12","12abc"]){
    let cancelled=false,pulls=0;
    const stream=new ReadableStream({
      pull(controller){
        pulls++;
        controller.enqueue(new Uint8Array([123,125]));
        controller.close();
      },
      cancel(){cancelled=true;},
    });
    const result=await loadStagingTitleSearchPage({
      query:"Shared project",scope:"shared",limit:2,
    },async()=>new Response(stream,{headers:{
      "content-type":"application/json","cache-control":"no-store",
      "content-length":length,
    }}));
    assert.deepEqual(result,{ok:false,reason:"invalid-response"},length);
    assert.equal(cancelled,true,length);
    assert.ok(pulls<=1,"reject before parsing response body");
  }
});

test("BE-18 fails closed on invalid UTF-8 and mid-stream abort",async()=>{
  const body=JSON.stringify(page([item("project","a")],false));
  const bytes=new TextEncoder().encode(body);
  const marker=body.indexOf('"title":"')+'"title":"'.length;
  assert.ok(marker>8);
  bytes[marker]=0xff;
  const result=await loadStagingTitleSearchPage({
    query:"Shared project",scope:"shared",limit:2,
  },async()=>new Response(bytes,{headers:{
    "content-type":"application/json","cache-control":"no-store",
  }}));
  assert.deepEqual(result,{ok:false,reason:"invalid-response"});
  const controller=new AbortController();
  let cancelled=false;
  const stream=new ReadableStream({
    pull(chunkController){
      chunkController.enqueue(new TextEncoder().encode(body.slice(0,10)));
      controller.abort();
    },
    cancel(){cancelled=true;},
  });
  const aborted=await loadStagingTitleSearchPage({
    query:"Shared project",scope:"shared",limit:2,signal:controller.signal,
  },async()=>new Response(stream,{headers:{
    "content-type":"application/json","cache-control":"no-store",
  }}));
  assert.deepEqual(aborted,{ok:false,reason:"aborted"});
  assert.equal(cancelled,true);
});
