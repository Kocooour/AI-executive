import assert from "node:assert/strict";
import {test} from "node:test";
import {
  beginGlobalIndexPageChain,advanceGlobalIndexPageChain,
  fetchGlobalIndexPage,
} from "../lib/target-staging-global-index-client.ts";

const project=id=>({kind:"project",item:{
  id,title:"Project "+id,areaId:"a-private",areaKind:"private",
}});
const task=(id,kind="private")=>({kind:"task",item:{
  id,title:"Task "+id,projectId:null,areaId:kind==="private"?"a-private":"s-shared",
  areaKind:kind,status:"open",dueOn:null,
  ...(kind==="shared"?{assignedToMe:false}:{}),
}});
const note=id=>({kind:"note",item:{
  id,title:"Note "+id,projectId:null,areaId:"a-private",areaKind:"private",revision:1,
}});
const page=(items,nextCursor=null,scope="all")=>({
  scope,items,hasMore:nextCursor!==null,nextCursor,
});
const ok=page=>({ok:true,page});
const fail=reason=>({ok:false,reason});
const params={scope:"all",limit:2};
const c1="aA.bA",c2="bB.cC",c3="dD.eE";

test("BE-17 keeps explicit three-page BINARY ordering and stops at the final page",()=>{
  const first=page([project("a"),task("a")],c1);
  const one=beginGlobalIndexPageChain(ok(first),params);
  assert.deepEqual(one.page,first);
  assert.deepEqual(one.issuedCursors,[c1]);

  const two=advanceGlobalIndexPageChain(one,c1,
    ok(page([note("a"),task("b","shared")],c2)));
  assert.deepEqual(two.page.items,[
    project("a"),task("a"),note("a"),task("b","shared"),
  ]);
  assert.deepEqual(two.issuedCursors,[c1,c2]);
  assert.equal(two.page.nextCursor,c2);

  const three=advanceGlobalIndexPageChain(two,c2,ok(page([note("b")])));
  assert.deepEqual(three.page.items,[
    project("a"),task("a"),note("a"),task("b","shared"),note("b"),
  ]);
  assert.equal(three.page.hasMore,false);
  assert.equal(three.page.nextCursor,null);
  assert.deepEqual(three.issuedCursors,[c1,c2]);
  assert.equal(advanceGlobalIndexPageChain(three,c2,ok(page([]))),null);
  assert.deepEqual(one.page,first,"previous generation remains unchanged");
});

test("BE-17 detects a non-adjacent cursor cycle on the third page",()=>{
  const one=beginGlobalIndexPageChain(ok(page([project("a")],c1)),params);
  const two=advanceGlobalIndexPageChain(one,c1,ok(page([project("b")],c2)));
  assert.ok(two);
  assert.equal(advanceGlobalIndexPageChain(two,c2,ok(page([project("c")],c1))),null);
  // Earlier page and issued-cursor history cannot be silently reused.
  assert.deepEqual(two.issuedCursors,[c1,c2]);
  assert.equal(two.page.nextCursor,c2);
});

test("BE-17 rejects wrong continuation, duplicate/reordered IDs and excess page size",()=>{
  const one=beginGlobalIndexPageChain(ok(page([project("a"),task("a")],c1)),params);
  assert.equal(advanceGlobalIndexPageChain(one,c2,ok(page([note("a")]))),null);
  assert.equal(advanceGlobalIndexPageChain(one,"unsigned",ok(page([note("a")]))),null);
  assert.equal(advanceGlobalIndexPageChain(one,c1,ok(page([project("a")]))),null);
  assert.equal(advanceGlobalIndexPageChain(one,c1,ok(page([project("A")]))),null);
  assert.equal(advanceGlobalIndexPageChain(one,c1,
    ok(page([note("a"),project("b"),task("b")]))),null);
  assert.equal(advanceGlobalIndexPageChain(one,c1,
    ok(page([note("a")],c1))),null);
  assert.equal(advanceGlobalIndexPageChain(one,c1,
    ok(page([note("a")],c3,"shared"))),null);
});

test("BE-17 refuses invalid or failed initial pages and cross-scope blending",()=>{
  assert.equal(beginGlobalIndexPageChain(fail("signed-out"),params),null);
  assert.equal(beginGlobalIndexPageChain(ok(page([project("a")],c1)),
    {scope:"all",limit:0}),null);
  assert.equal(beginGlobalIndexPageChain(ok(page([project("a")],c1)),
    {scope:"all",limit:101}),null);
  assert.equal(beginGlobalIndexPageChain(ok(page([project("a")],c1)),
    {scope:"personal",limit:2}),null);
  const personal=beginGlobalIndexPageChain(
    ok(page([project("a")],c1,"personal")),{scope:"personal",limit:2});
  assert.ok(personal);
  assert.equal(advanceGlobalIndexPageChain(personal,c1,
    ok(page([task("b","shared")],null,"personal"))),null);
  assert.equal(advanceGlobalIndexPageChain(personal,c1,
    ok(page([project("b")],null,"shared"))),null);
});

test("BE-17 fails closed on 401, 409, offline and abort, with no partial titles",()=>{
  const first=page([project("a")],c1);
  const one=beginGlobalIndexPageChain(ok(first),params);
  for(const reason of ["signed-out","stale","offline","aborted","unavailable","invalid-response"]){
    assert.equal(advanceGlobalIndexPageChain(one,c1,fail(reason)),null,reason);
    assert.deepEqual(one.page,first,"failures do not mutate the prior generation");
  }
  assert.equal(advanceGlobalIndexPageChain(one,c1,
    ok({...page([project("b")]),actorUserId:"leak"})),null);
});

test("BE-17 is network-silent; caller explicitly authorizes each no-store GET",async()=>{
  let calls=0;
  const serverPages=[
    page([project("a")],c1),
    page([project("b")],c2),
    page([project("c")]),
  ];
  const fetcher=async(url,opts)=>{
    const expectedCursor=calls===0?null:calls===1?c1:c2;
    const query=new URL(url,"https://lumi.invalid").searchParams;
    assert.equal(query.get("scope"),"all");
    assert.equal(query.get("limit"),"2");
    assert.equal(query.get("cursor"),expectedCursor);
    assert.equal(opts.credentials,"same-origin");
    assert.equal(opts.cache,"no-store");
    return Response.json(serverPages[calls++],{headers:{"cache-control":"no-store"}});
  };
  const first=await fetchGlobalIndexPage(params,fetcher);
  const one=beginGlobalIndexPageChain(first,params);
  assert.equal(calls,1);
  const second=await fetchGlobalIndexPage({...params,cursor:one.page.nextCursor},fetcher);
  const two=advanceGlobalIndexPageChain(one,one.page.nextCursor,second);
  assert.equal(calls,2);
  const third=await fetchGlobalIndexPage({...params,cursor:two.page.nextCursor},fetcher);
  const three=advanceGlobalIndexPageChain(two,two.page.nextCursor,third);
  assert.equal(calls,3);
  assert.deepEqual(three.page.items,[project("a"),project("b"),project("c")]);
});
