import assert from "node:assert/strict";
import {test} from "node:test";

const {createStagingTitleSearchSession}=
  await import("../lib/target-staging-title-search-session.ts");

const cursorA="e30."+"A".repeat(43);
const cursorB="e30."+"B".repeat(43);
const cursorC="e30."+"C".repeat(43);
const one=(kind,id)=>({
  kind,id,title:"Shared project",areaId:"shared-area",areaKind:"shared",
  ...(kind==="project"?{}:{projectId:"parent"}),
});
const page=(items,hasMore=false,nextCursor=null,query="Shared project")=>({
  query,scope:"shared",items,hasMore,nextCursor,
});
const json=(value,status=200)=>new Response(JSON.stringify(value),{
  status,headers:{"content-type":"application/json","cache-control":"no-store"},
});
const params=url=>new URL(url,"http://localhost").searchParams;
const options={query:"Shared project",scope:"shared",limit:1};

test("BE-17 loads exactly one explicit page at a time and isolates snapshots",async()=>{
  const urls=[];
  const responses=[
    page([one("project","same")],true,cursorA),
    page([one("task","same")],true,cursorB),
    page([one("note","z")],false),
  ];
  const session=createStagingTitleSearchSession(async(url,init)=>{
    urls.push(url);
    assert.equal(init.credentials,"same-origin");
    assert.equal(init.cache,"no-store");
    assert.equal(init.redirect,"error");
    return json(responses[urls.length-1]);
  });
  assert.deepEqual(session.getSnapshot().items,[]);
  assert.deepEqual(await session.next(),{ok:false,reason:"invalid-request"});
  assert.deepEqual(await session.first(options),{ok:true});
  assert.equal(urls.length,1,"no implicit prefetch");
  assert.deepEqual(session.getSnapshot().items.map(x=>x.kind),["project"]);
  const stolen=session.getSnapshot();
  stolen.items[0].title="mutated";stolen.items.push(one("task","danger"));
  assert.equal(session.getSnapshot().items.length,1);
  assert.equal(session.getSnapshot().items[0].title,"Shared project");
  assert.deepEqual(await session.next(),{ok:true});
  assert.equal(params(urls[1]).get("cursor"),cursorA);
  assert.deepEqual(await session.next(),{ok:true});
  assert.equal(params(urls[2]).get("cursor"),cursorB);
  assert.deepEqual(session.getSnapshot().items.map(x=>x.kind),
    ["project","task","note"]);
  assert.equal(session.getSnapshot().hasMore,false);
  assert.equal(session.getSnapshot().nextCursor,null);
  assert.deepEqual(await session.next(),{ok:false,reason:"invalid-request"});
  assert.equal(urls.length,3);
});

test("BE-17 rejects duplicate/reordered pages, clears all previous titles",async()=>{
  for(const lateItem of [one("project","a"),one("note","a")]){
    let calls=0;
    const session=createStagingTitleSearchSession(async()=>{
      calls++;
      return json(calls===1
        ?page([one("task","b")],true,cursorA)
        :page([lateItem],false));
    });
    assert.deepEqual(await session.first(options),{ok:true});
    assert.deepEqual(await session.next(),{ok:false,reason:"invalid-response"});
    assert.equal(calls,2);
    assert.deepEqual(session.getSnapshot().items,[]);
    assert.equal(session.getSnapshot().query,null);
    assert.equal(session.getSnapshot().nextCursor,null);
    assert.equal(session.getSnapshot().status,"error");
  }
});

test("BE-17 fails closed on cursor replay/cycle without automatic retry",async()=>{
  for(const secondCursor of [cursorA,cursorB]){
    let calls=0;
    const session=createStagingTitleSearchSession(async()=>{
      calls++;
      if(calls===1)return json(page([one("project","a")],true,cursorA));
      if(calls===2)return json(page([one("task","b")],true,cursorB));
      return json(page([one("note","c")],true,secondCursor));
    });
    assert.deepEqual(await session.first(options),{ok:true});
    assert.deepEqual(await session.next(),{ok:true});
    assert.deepEqual(await session.next(),{ok:false,reason:"invalid-response"});
    assert.deepEqual(session.getSnapshot().items,[]);
    assert.equal(calls,3);
  }
});

test("BE-17 revoked, stale, offline or malformed continuation purges all results",async()=>{
  for(const late of [
    json({error:"revoked"},401),
    json({error:"stale"},409),
    json({x:1}),
    new Error("network"),
  ]){
    let calls=0;
    const session=createStagingTitleSearchSession(async()=>{
      calls++;
      if(calls===1)return json(page([one("project","a")],true,cursorA));
      if(late instanceof Error)throw late;
      return late;
    });
    assert.deepEqual(await session.first(options),{ok:true});
    const result=await session.next();
    assert.equal(result.ok,false);
    assert.deepEqual(session.getSnapshot().items,[]);
    assert.equal(session.getSnapshot().hasMore,false);
    assert.equal(session.getSnapshot().query,null);
    assert.equal(session.getSnapshot().failure,result.reason);
    assert.equal(calls,2,"no 409 restart, 401 retry or fallback fetch");
  }
});

test("BE-17 new search wins race over late older response",async()=>{
  let releaseOld;
  const old=new Promise(resolve=>{releaseOld=resolve;});
  const seen=[];
  const session=createStagingTitleSearchSession(async(url)=>{
    seen.push(params(url).get("q"));
    if(seen.length===1)return old;
    return json(page([one("project","z-new")],false,null,"Newest"));
  });
  const first=session.first(options);
  const newer=session.first({query:"Newest",scope:"shared",limit:1});
  assert.deepEqual(await newer,{ok:true});
  releaseOld(json(page([one("project","a-old")],false)));
  assert.deepEqual(await first,{ok:false,reason:"aborted"});
  assert.deepEqual(session.getSnapshot().items.map(x=>x.id),["z-new"]);
  assert.equal(session.getSnapshot().query,"Newest");
  assert.deepEqual(seen,["Shared project","Newest"]);
});

test("BE-17 explicit reset aborts and invalidates pending response",async()=>{
  let resolveResponse;
  const promise=new Promise(resolve=>{resolveResponse=resolve;});
  const session=createStagingTitleSearchSession(async()=>promise);
  const pending=session.first(options);
  assert.equal(session.getSnapshot().status,"loading");
  session.reset();
  assert.equal(session.getSnapshot().status,"idle");
  assert.deepEqual(session.getSnapshot().items,[]);
  resolveResponse(json(page([one("project","a")],false)));
  assert.deepEqual(await pending,{ok:false,reason:"aborted"});
  assert.deepEqual(session.getSnapshot().items,[]);
});

test("BE-17 blocks double continuation while loading",async()=>{
  let finish;
  const pendingResponse=new Promise(resolve=>{finish=resolve;});
  let calls=0;
  const session=createStagingTitleSearchSession(async()=>{
    calls++;
    return calls===1?json(page([one("project","a")],true,cursorA)):pendingResponse;
  });
  await session.first(options);
  const ongoing=session.next();
  assert.equal(session.getSnapshot().status,"loading");
  assert.deepEqual(await session.next(),{ok:false,reason:"invalid-request"});
  assert.equal(calls,2);
  finish(json(page([one("task","b")],false)));
  assert.deepEqual(await ongoing,{ok:true});
  assert.deepEqual(session.getSnapshot().items.map(x=>x.id),["a","b"]);
});

test("BE-17 invalid first request erases earlier titles without network call",async()=>{
  let calls=0;
  const session=createStagingTitleSearchSession(async()=>{
    calls++;
    return json(page([one("project","a")],false));
  });
  assert.deepEqual(await session.first(options),{ok:true});
  assert.deepEqual(await session.first({...options,query:"x"}),
    {ok:false,reason:"invalid-request"});
  assert.equal(calls,1);
  assert.deepEqual(session.getSnapshot().items,[]);
  assert.equal(session.getSnapshot().failure,"invalid-request");
  session.reset();
  assert.equal(session.getSnapshot().failure,null);
});

test("BE-17 bounded retained search pages purge an oversized multi-page result",async()=>{
  let calls=0;
  const itemsFor=i=>Array.from({length:50},(_,j)=>
    one("project",String(i*50+j).padStart(5,"0")));
  const session=createStagingTitleSearchSession(async()=>{
    const i=calls++;
    return json({
      ...page(itemsFor(i),true,i===0?cursorA:cursorC),
      // use unique valid cursor each time
      nextCursor:"e30."+String(i+1).padStart(43,"A"),
    });
  });
  const big={...options,limit:50};
  assert.deepEqual(await session.first(big),{ok:true});
  for(let i=1;i<20;i++)assert.deepEqual(await session.next(),{ok:true});
  assert.equal(session.getSnapshot().items.length,1000);
  assert.deepEqual(await session.next(),{ok:false,reason:"invalid-response"});
  assert.deepEqual(session.getSnapshot().items,[]);
  assert.equal(calls,21);
});
