import assert from "node:assert/strict";
import {test} from "node:test";
import {createGlobalIndexReadSession} from "../lib/target-staging-global-index-read-session.ts";

const project=id=>({kind:"project",item:{
  id,title:"Private "+id,areaId:"area-private",areaKind:"private",
}});
const page=(items,cursor=null)=>({
  scope:"all",items,hasMore:cursor!==null,nextCursor:cursor,
});
const response=body=>Response.json(body,{headers:{"cache-control":"no-store"}});
const make=(fetcher,contextVersion=()=>"identity-epoch-1")=>
  createGlobalIndexReadSession({scope:"all",limit:2,contextVersion},fetcher);

test("BE-19 suspend clears ready titles, blocks GET, and resume never fetches itself",async()=>{
  let calls=0;
  const reader=make(async()=>{
    calls++;
    return response(page([project(calls===1?"before":"after")]));
  });
  assert.equal((await reader.loadFirst()).ok,true);
  assert.equal(reader.getSnapshot().status,"ready");
  reader.suspend();
  assert.deepEqual(reader.getSnapshot(),{status:"suspended"});
  assert.deepEqual(await reader.loadFirst(),{ok:false,reason:"not-ready"});
  assert.deepEqual(await reader.loadMore(),{ok:false,reason:"not-ready"});
  assert.equal(calls,1);
  assert.equal(reader.resume(),true);
  assert.deepEqual(reader.getSnapshot(),{status:"idle"});
  assert.equal(calls,1,"resume never reads or reuses a cached page");
  assert.deepEqual(await reader.loadMore(),{ok:false,reason:"not-ready"});
  assert.deepEqual(reader.getSnapshot(),{status:"idle"});
  const fresh=await reader.loadFirst();
  assert.deepEqual(fresh,{ok:true,page:page([project("after")])});
  assert.equal(calls,2,"only explicit loadFirst reauthorizes on the server");
});

test("BE-19 suspension during stalled headers aborts immediately and discards late private body",async()=>{
  let release,calls=0;
  const reader=make(async()=>{
    calls++;
    return new Promise(resolve=>{release=resolve;});
  });
  const pending=reader.loadFirst();
  assert.equal(calls,1);
  reader.suspend();
  assert.deepEqual(reader.getSnapshot(),{status:"suspended"});
  assert.deepEqual(await Promise.race([
    pending,new Promise((_,reject)=>setTimeout(()=>reject(Error("old read hung")),2000)),
  ]),{ok:false,reason:"superseded"});
  let cancel;
  const cancelled=new Promise(resolve=>{cancel=resolve;});
  release(new Response(new ReadableStream({cancel(){cancel();}},{highWaterMark:0}),
    {headers:{"cache-control":"no-store","content-type":"application/json"}}));
  await Promise.race([cancelled,new Promise((_,reject)=>
    setTimeout(()=>reject(Error("late title stream was not discarded")),2000))]);
  assert.deepEqual(reader.getSnapshot(),{status:"suspended"});
  assert.equal(calls,1);
});

test("BE-19 suspend during continuation invalidates cursor and old aggregated titles",async()=>{
  let calls=0,release;
  const reader=make(async()=>{
    calls++;
    if(calls===1)return response(page([project("initial")],"aA.bA"));
    if(calls===2)return new Promise(resolve=>{release=resolve;});
    return response(page([project("fresh")]));
  });
  assert.equal((await reader.loadFirst()).ok,true);
  const pending=reader.loadMore();
  assert.deepEqual(reader.getSnapshot(),{status:"loading"});
  reader.suspend();
  assert.deepEqual(reader.getSnapshot(),{status:"suspended"});
  assert.deepEqual(await pending,{ok:false,reason:"superseded"});
  release(response(page([project("stale-continuation")])));
  assert.equal(reader.resume(),true);
  assert.deepEqual(await reader.loadMore(),{ok:false,reason:"not-ready"});
  assert.deepEqual((await reader.loadFirst()).page.items,[project("fresh")]);
  assert.equal(calls,3);
});

test("BE-19 observed context change while suspended is terminal even on A B A",async()=>{
  let epoch="a",calls=0;
  const reader=make(async()=>{
    calls++;
    return response(page([project("private")]));
  },()=>epoch);
  assert.equal((await reader.loadFirst()).ok,true);
  reader.suspend();
  epoch="b";
  assert.equal(reader.resume(),false);
  assert.deepEqual(reader.getSnapshot(),{status:"failed",reason:"stale"});
  epoch="a";
  reader.suspend();
  assert.equal(reader.resume(),false);
  assert.deepEqual(await reader.loadFirst(),{ok:false,reason:"stale"});
  assert.deepEqual(reader.getSnapshot(),{status:"failed",reason:"stale"});
  assert.equal(calls,1,"terminal auth change can never be reactivated");
});

test("BE-19 repeated suspend/resume and disposal remain silent and terminal",async()=>{
  let calls=0;
  const reader=make(async()=>{
    calls++;
    return response(page([project("private")]));
  });
  reader.suspend();
  reader.suspend();
  assert.deepEqual(reader.getSnapshot(),{status:"suspended"});
  assert.equal(reader.resume(),true);
  assert.equal(reader.resume(),true);
  assert.equal(calls,0);
  reader.dispose();
  reader.suspend();
  assert.equal(reader.resume(),false);
  assert.deepEqual(reader.getSnapshot(),{status:"disposed"});
  assert.deepEqual(await reader.loadFirst(),{ok:false,reason:"aborted"});
  assert.equal(calls,0);
});

test("BE-19 an invalid auth context cannot become usable via resume",async()=>{
  let calls=0;
  const reader=createGlobalIndexReadSession({
    scope:"all",contextVersion:()=>"",
  },async()=>{calls++;return response(page([project("secret")]))});
  reader.suspend();
  assert.equal(reader.resume(),false);
  assert.deepEqual(reader.getSnapshot(),{status:"failed",reason:"invalid-request"});
  assert.deepEqual(await reader.loadFirst(),{ok:false,reason:"invalid-request"});
  assert.equal(calls,0);
});
