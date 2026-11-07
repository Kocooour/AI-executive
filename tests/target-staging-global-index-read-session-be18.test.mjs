import assert from "node:assert/strict";
import {test} from "node:test";
import {createGlobalIndexReadSession}
  from "../lib/target-staging-global-index-read-session.ts";

const cursor1="aA.bA",cursor2="bB.cC";
const project=id=>({kind:"project",item:{
  id,title:"Project "+id,areaId:"private-a",areaKind:"private",
}});
const task=(id,areaKind="private")=>({kind:"task",item:{
  id,title:"Task "+id,projectId:null,areaId:areaKind+"-a",areaKind,
  status:"open",dueOn:null,...(areaKind==="shared"?{assignedToMe:false}:{})
}});
const note=id=>({kind:"note",item:{
  id,title:"Note "+id,projectId:null,areaId:"private-a",areaKind:"private",revision:1,
}});
const page=(items,more=null,scope="all")=>({
  scope,items,hasMore:more!==null,nextCursor:more,
});
const answer=(body,status=200)=>Response.json(body,{
  status,headers:{"cache-control":"no-store"},
});
const reader=(fetcher,contextVersion=()=> "account-epoch-1",scope="all",limit=2)=>
  createGlobalIndexReadSession({scope,limit,contextVersion},fetcher);

test("BE-18 remains network-silent until each explicit call; three pages and exhausted end",async()=>{
  const pages=[
    page([project("a"),task("a")],cursor1),
    page([note("a"),project("b")],cursor2),
    page([task("b","shared")]),
  ];
  let calls=0;
  const controller=reader(async(url,init)=>{
    const index=calls++;
    const query=new URL(url,"https://invalid.example").searchParams;
    assert.equal(query.get("scope"),"all");
    assert.equal(query.get("limit"),"2");
    assert.equal(query.get("cursor"),index===0?null:index===1?cursor1:cursor2);
    assert.equal(init.method,"GET");
    assert.equal(init.credentials,"same-origin");
    assert.equal(init.cache,"no-store");
    assert.equal(init.redirect,"error");
    return answer(pages[index]);
  });
  assert.deepEqual(controller.getSnapshot(),{status:"idle"});
  assert.equal(calls,0);
  assert.equal((await controller.loadFirst()).ok,true);
  assert.equal(calls,1);
  assert.equal(controller.getSnapshot().page.items.length,2);
  assert.equal((await controller.loadMore()).ok,true);
  assert.equal(calls,2);
  assert.equal(controller.getSnapshot().page.items.length,4);
  const final=await controller.loadMore();
  assert.equal(final.ok,true);
  assert.equal(final.page.items.length,5);
  assert.equal(final.page.hasMore,false);
  assert.equal((await controller.loadMore()).ok,true);
  assert.equal(calls,3,"no prefetch or request after final page");
});

test("BE-18 returns detached snapshots and results so callers cannot forge cursors",async()=>{
  let calls=0;
  const controller=reader(async()=>{calls++;return answer(
    calls===1?page([project("a")],cursor1):page([project("b")])
  );});
  const first=await controller.loadFirst();
  assert.equal(first.ok,true);
  first.page.nextCursor="xY.zZ";
  first.page.items[0].item.id="evil";
  const snapshot=controller.getSnapshot();
  assert.equal(snapshot.status,"ready");
  snapshot.page.nextCursor="xY.zZ";
  snapshot.page.items[0].item.title="Forged";
  const second=await controller.loadMore();
  assert.equal(second.ok,true);
  assert.deepEqual(second.page.items,[project("a"),project("b")]);
  assert.equal(calls,2);
});

test("BE-18 rejects a second continuation while the first is in flight",async()=>{
  let calls=0,release;
  const controller=reader(()=> {
    calls++;
    return calls===1?Promise.resolve(answer(page([project("a")],cursor1))):
      new Promise(resolve=>{release=resolve;});
  });
  await controller.loadFirst();
  const pending=controller.loadMore();
  assert.deepEqual(controller.getSnapshot(),{status:"loading"},
    "no old titles visible while the next authorized page is pending");
  assert.deepEqual(await controller.loadMore(),{ok:false,reason:"busy"});
  assert.equal(calls,2,"no duplicate continuation");
  release(answer(page([project("b")])));
  assert.equal((await pending).ok,true);
});

test("BE-18 changing the non-secret auth epoch immediately invalidates visible items",async()=>{
  let epoch="user-a-session-1",calls=0;
  const controller=reader(async()=>{calls++;return answer(page([project("a")]));},()=>epoch);
  assert.equal((await controller.loadFirst()).ok,true);
  epoch="user-b-session-2";
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"stale"});
  assert.deepEqual(await controller.loadMore(),{ok:false,reason:"stale"});
  assert.deepEqual(await controller.loadFirst(),{ok:false,reason:"stale"});
  assert.equal(calls,1,"no more GET from a stale reader");
});

test("BE-18 cannot resurrect a revoked reader after auth-epoch ABA reuse",async()=>{
  let epoch="a",calls=0;
  const controller=reader(async()=>{
    calls++;return answer(page([project("private")]));
  },()=>epoch);
  assert.equal((await controller.loadFirst()).ok,true);
  epoch="b";
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"stale"});
  epoch="a";
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"stale"});
  assert.deepEqual(await controller.loadFirst(),{ok:false,reason:"stale"});
  assert.equal(calls,1,"stale session must be recreated instead of revived");
});

test("BE-18 a throwing auth epoch reader fails closed without network",async()=>{
  let calls=0,epoch="stable";
  const controller=reader(async()=>{calls++;return answer(page([project("a")]));},
    ()=>{if(epoch==="expired")throw Error("auth unavailable");return epoch;});
  await controller.loadFirst();
  epoch="expired";
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"stale"});
  assert.equal(calls,1);
});

test("BE-18 invalid context, scope, and limit never send a request",async()=>{
  let calls=0;
  const fetcher=async()=>{calls++;return answer(page([]));};
  const invalid=[
    reader(fetcher,()=>""),reader(fetcher,()=>{throw Error("no identity");}),
    reader(fetcher,()=>"valid","my-plan"),reader(fetcher,()=>"valid","all",0),
    reader(fetcher,()=>"valid","all",101),
  ];
  for(const controller of invalid){
    assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"invalid-request"});
    assert.deepEqual(await controller.loadFirst(),{ok:false,reason:"invalid-request"});
    assert.deepEqual(await controller.loadMore(),{ok:false,reason:"invalid-request"});
  }
  assert.equal(calls,0);
});

test("BE-18 a slow old first read cannot restore titles after explicit reload",async()=>{
  let releaseOld,calls=0;
  const controller=reader(async()=>{
    calls++;
    if(calls===1)return new Promise(resolve=>{releaseOld=resolve;});
    return answer(page([project("new")]));
  });
  const old=controller.loadFirst();
  assert.deepEqual(controller.getSnapshot(),{status:"loading"});
  const fresh=controller.loadFirst();
  assert.deepEqual(await old,{ok:false,reason:"superseded"});
  const result=await fresh;
  assert.equal(result.ok,true);
  assert.deepEqual(controller.getSnapshot().page.items,[project("new")]);
  let canceled;
  const canceledPromise=new Promise(resolve=>{canceled=resolve;});
  releaseOld(new Response(new ReadableStream({cancel(){canceled();}},{highWaterMark:0}),
    {headers:{"cache-control":"no-store","content-type":"application/json"}}));
  await Promise.race([canceledPromise,new Promise((_,reject)=>
    setTimeout(()=>reject(Error("late body was not discarded")),1500))]);
  assert.deepEqual(controller.getSnapshot().page.items,[project("new")]);
  assert.equal(calls,2);
});

test("BE-18 dispose aborts a stalled header response and never resurrects titles",async()=>{
  let release,calls=0;
  const controller=reader(async()=>{
    calls++;
    return new Promise(resolve=>{release=resolve;});
  });
  const pending=controller.loadFirst();
  controller.dispose();
  assert.deepEqual(controller.getSnapshot(),{status:"disposed"});
  assert.deepEqual(await pending,{ok:false,reason:"superseded"});
  assert.deepEqual(await controller.loadFirst(),{ok:false,reason:"aborted"});
  assert.deepEqual(await controller.loadMore(),{ok:false,reason:"aborted"});
  let cancel;
  const canceled=new Promise(resolve=>{cancel=resolve;});
  release(new Response(new ReadableStream({cancel(){cancel();}},{highWaterMark:0}),
    {headers:{"cache-control":"no-store","content-type":"application/json"}}));
  await Promise.race([canceled,new Promise((_,reject)=>
    setTimeout(()=>reject(Error("late private stream leaked")),1500))]);
  assert.deepEqual(controller.getSnapshot(),{status:"disposed"});
  assert.equal(calls,1);
});

test("BE-18 context change during in-flight continuation wipes all earlier titles",async()=>{
  let epoch="a",calls=0,release;
  const controller=reader(async()=>{
    calls++;
    return calls===1?answer(page([project("a")],cursor1)):
      new Promise(resolve=>{release=resolve;});
  },()=>epoch);
  await controller.loadFirst();
  const pending=controller.loadMore();
  epoch="b";
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"stale"});
  assert.deepEqual(await pending,{ok:false,reason:"superseded"});
  release(answer(page([project("b")])));
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"stale"});
  assert.equal(calls,2);
});

test("BE-18 server 401, 409, invalid DTO and offline clear all accumulated items",async()=>{
  for(const [second,reason] of [
    [()=>answer({error:"Signed out"},401),"signed-out"],
    [()=>answer({error:"Cursor stale"},409),"stale"],
    [()=>answer({...page([project("b")]),actorId:"private"}),"invalid-response"],
    [()=>Promise.reject(Error("network offline")),"offline"],
  ]){
    let calls=0;
    const controller=reader(async()=>{
      calls++;
      return calls===1?answer(page([project("a")],cursor1)):second();
    });
    await controller.loadFirst();
    const actual=await controller.loadMore();
    assert.deepEqual(actual,{ok:false,reason});
    assert.deepEqual(controller.getSnapshot(),{status:"failed",reason});
    assert.deepEqual(await controller.loadMore(),{ok:false,reason:"not-ready"});
    assert.equal(calls,2);
  }
});

test("BE-18 old cursor cycles cause a failed state, not partial aggregated content",async()=>{
  let calls=0;
  const pages=[
    page([project("a")],cursor1),
    page([task("a")],cursor2),
    page([note("a")],cursor1),
  ];
  const controller=reader(async()=>answer(pages[calls++]));
  assert.equal((await controller.loadFirst()).ok,true);
  assert.equal((await controller.loadMore()).ok,true);
  assert.deepEqual(await controller.loadMore(),{ok:false,reason:"invalid-response"});
  assert.deepEqual(controller.getSnapshot(),{status:"failed",reason:"invalid-response"});
  assert.equal(calls,3);
});

test("BE-18 a cross-scope response fails closed, while a new reader may use a new scope",async()=>{
  const shared=reader(async()=>answer(page([project("a")],null,"personal")),
    ()=>"user-1","shared");
  assert.deepEqual(await shared.loadFirst(),{ok:false,reason:"invalid-response"});
  assert.deepEqual(shared.getSnapshot(),{status:"failed",reason:"invalid-response"});
  shared.dispose();
  const personal=reader(async()=>answer(page([project("a")],null,"personal")),
    ()=>"user-1","personal");
  assert.equal((await personal.loadFirst()).ok,true);
});
