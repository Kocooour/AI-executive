import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {createTargetClientRuntime} from "../lib/target-client-runtime.ts";
import {createGlobalIndexReadSession} from "../lib/target-staging-global-index-read-session.ts";
import {createKindIndexReadSession,kindIndexFetch} from "../lib/target-staging-kind-index-client.ts";
import {groupIndexRowsByArea} from "../lib/target-scope-rows.ts";
import {createRefusalBudget,targetMyPlanGate} from "../lib/target-my-plan-embed.ts";

const root=path.resolve(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");
const GEN_A="A".repeat(43);
const GEN_B="B".repeat(43);
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
const json=(body,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});

const project=(id,areaId,areaKind)=>({kind:"project",item:{id,title:"Project "+id,areaId,areaKind}});
const note=(id,areaId,areaKind)=>({kind:"note",item:{id,title:"Note "+id,projectId:null,areaId,areaKind,revision:1}});
const task=(id,areaId,areaKind)=>({kind:"task",item:{id,title:"Task "+id,projectId:null,areaId,areaKind,
  status:"open",dueOn:null,...(areaKind==="shared"?{assignedToMe:false}:{})}});

class Channel{
  static last=null;
  constructor(){Channel.last=this;this.l=[];}
  addEventListener(_t,fn){this.l.push(fn);}
  close(){}
  emit(data){for(const fn of this.l)fn({data});}
}
/** One fetch fake for the session route and the global-index route; records every URL. */
function fakeServer({generations=[GEN_A],index=()=>json({scope:"all",items:[],hasMore:false,nextCursor:null})}={}){
  const calls=[];
  const queue=[...generations];
  const fetchFake=async(url,init)=>{
    const text=String(url);
    calls.push(text);
    if(text.includes("/api/target-staging/session")){
      const next=queue.shift()??GEN_A;
      if(next==="401")return new Response("{}",{status:401});
      return json({generation:next});
    }
    return index(new URL(text,"https://lumi.test"),init);
  };
  return {fetchFake,calls,indexCalls:()=>calls.filter(c=>c.includes("global-index"))};
}
const makeRuntime=server=>createTargetClientRuntime({
  fetch:server.fetchFake,window:null,broadcastChannelFactory:()=>new Channel(),
});
const sessionFor=(runtime,server,scope)=>{
  const created=createGlobalIndexReadSession({scope,contextVersion:runtime.generation},server.fetchFake);
  runtime.register(created);
  return created;
};

test("scope maps to the server query scope and nothing else (no actor, no client filter)",async()=>{
  for(const scope of ["all","personal","shared"]){
    const server=fakeServer({index:url=>{
      assert.equal(url.pathname,"/api/target-staging/global-index");
      assert.deepEqual([...url.searchParams.keys()].sort(),["limit","scope"]);
      assert.equal(url.searchParams.get("scope"),scope);
      return json({scope,items:[project("p1","a1",scope==="shared"?"shared":"private")],hasMore:false,nextCursor:null});
    }});
    const runtime=makeRuntime(server);
    await settle();
    const session=sessionFor(runtime,server,scope);
    const result=await session.loadFirst();
    assert.equal(result.ok,true,scope);
    assert.equal(result.page.scope,scope);
    assert.equal(server.indexCalls().length,1);
    runtime.dispose();
  }
});

test("grouping by Area keeps the rows it is given: nothing dropped, added or reordered",()=>{
  const rows=[
    project("1","a","private"),project("2","b","shared"),project("3","a","private"),
    project("4","c","shared"),project("5","b","shared"),
  ];
  const groups=groupIndexRowsByArea(rows);
  assert.deepEqual(groups.map(g=>g.areaId),["a","b","c"]); // first appearance order
  assert.deepEqual(groups.map(g=>g.areaKind),["private","shared","shared"]);
  assert.deepEqual(groups.map(g=>g.items.map(i=>i.item.id)),[["1","3"],["2","5"],["4"]]);
  const flat=groups.flatMap(g=>g.items);
  assert.equal(flat.length,rows.length);
  assert.deepEqual(flat.map(i=>i.item.id).sort(),rows.map(i=>i.item.id).sort());
  assert.deepEqual(groupIndexRowsByArea([]),[]);
  // Rows are the same objects: nothing is copied, rewritten or counted.
  assert.ok(flat.every(item=>rows.includes(item)));
});

test("the list component applies no client-side filter at all (no kind picking either)",()=>{
  const source=read("app/ui/target-scope-lists.tsx");
  assert.deepEqual(source.match(/\.filter\([^)]*\)/g)??[],[]);
  assert.doesNotMatch(source,/entry\.kind===kind|createGlobalIndexReadSession/);
  assert.match(source,/createKindIndexReadSession\(kind,\{scope,contextVersion\}\),\[kind,scope\]/);
  assert.doesNotMatch(source,/\.sort\(|\.slice\(|\.length\s*[+\-*]/);
  assert.doesNotMatch(source,/areaKind\s*===\s*scope|areaKind\s*!==\s*scope/);
});

test("scope change: the old scope's session is disposed and its late response is never delivered",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const server=fakeServer({index:async url=>{
    const scope=url.searchParams.get("scope");
    if(scope==="personal")await gate;
    return json({scope,items:[project(scope+"1","a1",scope==="shared"?"shared":"private")],hasMore:false,nextCursor:null});
  }});
  const runtime=makeRuntime(server);
  await settle();
  const personal=sessionFor(runtime,server,"personal");
  const pending=personal.loadFirst();
  // The user switches to Shared: the component's session for Personal is disposed first.
  personal.dispose();
  const shared=sessionFor(runtime,server,"shared");
  release();
  const stale=await pending;
  assert.equal(stale.ok,false);
  assert.equal(stale.page,undefined);
  const fresh=await shared.loadFirst();
  assert.equal(fresh.ok,true);
  assert.equal(fresh.page.scope,"shared");
  assert.deepEqual(fresh.page.items.map(i=>i.item.id),["shared1"]);
  assert.deepEqual((await personal.loadMore()).ok,false);
  runtime.dispose();
});

test("generation change disposes registered sessions: no row of the old identity survives",async()=>{
  const server=fakeServer({generations:[GEN_A,GEN_B],index:()=>json({scope:"all",
    items:[project("p1","a1","private")],hasMore:true,nextCursor:"aA.bA"})});
  const runtime=makeRuntime(server);
  await settle();
  assert.equal(runtime.generation(),GEN_A);
  const session=sessionFor(runtime,server,"all");
  assert.equal((await session.loadFirst()).ok,true);
  assert.equal(session.getSnapshot().status,"ready");
  await runtime.reportRefusal("session_revoked");
  await settle();
  assert.equal(session.getSnapshot().status,"disposed");
  assert.equal((await session.loadMore()).ok,false);
  assert.equal((await session.loadFirst()).ok,false);
  runtime.dispose();
});

test("a session never exists before the runtime knows a server-confirmed generation",async()=>{
  const gateOf=runtime=>targetMyPlanGate(runtime,runtime.generation(),runtime.lastOutcome(),false);
  const server=fakeServer({generations:["401"]});
  const runtime=makeRuntime(server);
  assert.equal(gateOf(runtime).kind,"checking");
  await settle();
  assert.equal(gateOf(runtime).kind,"signed_out");
  assert.equal(server.indexCalls().length,0,"no global-index request without a confirmed generation");
  runtime.dispose();
  // And the hook creates sessions only when known().
  const hook=read("app/ui/target-data-provider.tsx");
  assert.match(hook,/if\(!runtime\|\|!known\)\{setSession\(null\);return;\}/);
});

test("401 on the index read -> signed-out and a bounded refusal budget (no refusal loop)",async()=>{
  const server=fakeServer({index:()=>new Response("{}",{status:401})});
  const runtime=makeRuntime(server);
  await settle();
  const session=sessionFor(runtime,server,"all");
  const result=await session.loadFirst();
  assert.deepEqual(result,{ok:false,reason:"signed-out"});
  assert.equal(session.getSnapshot().status,"failed");
  const budget=createRefusalBudget();
  assert.deepEqual([budget.admit(),budget.admit(),budget.admit()],[true,true,false]);
  const gate=targetMyPlanGate(runtime,runtime.generation(),runtime.lastOutcome(),true);
  assert.equal(gate.kind,"refused");
  runtime.dispose();
});

test("hidden / offline: suspend hides titles at once and resume fetches nothing by itself",async()=>{
  const server=fakeServer({index:()=>json({scope:"all",items:[project("p1","a1","private")],hasMore:false,nextCursor:null})});
  const runtime=makeRuntime(server);
  await settle();
  const session=sessionFor(runtime,server,"all");
  await session.loadFirst();
  assert.equal(session.getSnapshot().page.items.length,1);
  session.suspend();
  assert.deepEqual(session.getSnapshot(),{status:"suspended"});
  assert.equal((await session.loadFirst()).reason,"not-ready");
  const before=server.indexCalls().length;
  assert.equal(session.resume(),true);
  await settle();
  assert.equal(server.indexCalls().length,before,"resume never fetches");
  assert.equal(session.getSnapshot().status,"idle"); // old rows are gone
  assert.equal((await session.loadFirst()).ok,true);
  runtime.dispose();
});

test("paging uses the server cursor and 'Load more' only while the server says hasMore",async()=>{
  const pages=[
    {scope:"all",items:[project("p1","a1","private")],hasMore:true,nextCursor:"aA.bA"},
    {scope:"all",items:[project("p2","a2","shared")],hasMore:false,nextCursor:null},
  ];
  const cursors=[];
  const server=fakeServer({index:url=>{cursors.push(url.searchParams.get("cursor"));return json(pages[cursors.length-1]);}});
  const runtime=makeRuntime(server);
  await settle();
  const session=sessionFor(runtime,server,"all");
  await session.loadFirst();
  const more=await session.loadMore();
  assert.equal(more.ok,true,JSON.stringify(more));
  assert.deepEqual(more.page.items.map(i=>i.item.id),["p1","p2"]);
  assert.deepEqual(cursors,[null,"aA.bA"]);
  assert.equal(more.page.hasMore,false);
  assert.equal((await session.loadMore()).ok,true);
  assert.equal(cursors.length,2,"no request after the final page");
  runtime.dispose();
  void task;void note;
});

test("wiring: flags off -> legacy tree, lazy chunks only, no eager import, no request from page/root",()=>{
  const root_=read("app/ui/lumi-app-root.tsx");
  assert.match(root_,/dynamic\(\(\) => import\("\.\/target-scope-switcher"\), \{ ssr: false \}\)/);
  assert.match(root_,/dynamic\(\(\) => import\("\.\/target-scope-lists"\), \{ ssr: false \}\)/);
  assert.doesNotMatch(root_,/^import .*target-scope/m);
  assert.match(root_,/const scopesOn = Boolean\(targetScopes\?\.enabled\)/);
  // The per-view decision lives in a pure helper (lib/target-shell-views.ts).
  assert.match(root_,/activeTargetViewFor\(\{ \.\.\.shellInput, view, planActive \}\)/);
  const helper=read("lib/target-shell-views.ts");
  assert.match(helper,/input\.scopesOn&&input\.view==="Projects"&&input\.projectsList\?"project"/);
  assert.match(helper,/input\.scopesOn&&input\.view==="Notes"&&input\.notesList\?"note":null/);
  assert.match(root_,/\{scopeSwitcher && <TargetScopeSwitcher language=\{language\} variant=/);
  // Legacy lists stay the fallback for every other case.
  assert.match(root_,/: <EntityList app=\{app\} \/>/);
  const page=read("app/page.tsx");
  assert.match(page,/targetScopes=\{config\?\.scopes\}/);
  assert.match(page,/: <LumiAppRoot \/>/);
  assert.doesNotMatch(page,/target-scope|fetch\(|api\/target-staging/);
  assert.doesNotMatch(root_,/api\/target-staging|fetch\(|useTargetScope|IndexReadSession/);
});

test("wiring: the switcher is a real radio group with arrows, aria-checked and roving focus",()=>{
  const source=read("app/ui/target-scope-switcher.tsx");
  assert.match(source,/role="radiogroup"/);
  assert.match(source,/role="radio"/);
  assert.match(source,/aria-checked=\{checked\}/);
  assert.match(source,/tabIndex=\{checked\?0:-1\}/);
  for(const key of ["ArrowRight","ArrowLeft","ArrowDown","ArrowUp","Home","End"])
    assert.match(source,new RegExp(key));
  assert.doesNotMatch(source,/fetch\(|localStorage|sessionStorage|indexedDB/);
  const css=read("app/ui/target-scopes.css");
  assert.match(css,/#8B5CF6/);assert.match(css,/#16A34A/);assert.match(css,/#2563EB/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/:focus-visible/);
  assert.match(css,/#DCFCE7/);assert.match(css,/#DBEAFE/);
});

test("wiring: scope screens persist and log nothing, show no counts or Area headings",()=>{
  for(const file of ["app/ui/target-scope-lists.tsx","app/ui/target-scope-state.ts","app/ui/target-scope-switcher.tsx","app/ui/use-target-gate.ts"]){
    const source=read(file);
    assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|caches\.|console\./,file);
  }
  const lists=read("app/ui/target-scope-lists.tsx");
  assert.doesNotMatch(lists,/<h[1-6]/);
  assert.doesNotMatch(lists,/items\.length|rows\.length\s*\}/);
  assert.match(lists,/useTargetSession\(contextVersion=>createKindIndexReadSession\(kind,\{scope,contextVersion\}\),\[kind,scope\]\)/);
  assert.match(lists,/state\.session===session&&state\.rowKind===kind&&state\.page\.scope===scope/);
  assert.match(lists,/visibilitychange/);assert.match(lists,/pagehide/);assert.match(lists,/"offline"/);
  assert.match(lists,/refusalRef\.current\(\)/);
});

test("wiring: My Plan follows the global scope and hides its own filter only in that mode",()=>{
  const wrapper=read("app/ui/target-my-plan.tsx");
  assert.match(wrapper,/areaFilter=\{scopeDriven\?scope:undefined\}/);
  const preview=read("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(preview,/const areaFilter=controlledFilter\?\?ownFilter/);
  assert.match(preview,/\{controlledFilter===undefined&&<label>\{copy\.toolbarWork\}/);
  // The standalone staging page passes no controlled filter, so it keeps its toolbar.
  assert.doesNotMatch(read("app/target-staging/my-plan/preview/page.tsx"),/areaFilter/);
});

const projectRow=(id,areaKind="private")=>({id,title:"P "+id,areaId:areaKind+"-a",areaKind});
const noteRow=(id,areaKind="private")=>({id,title:"N "+id,projectId:null,areaId:areaKind+"-a",areaKind,revision:1});

test("endpoint mapping: Projects -> project-index/global, Notes -> note-index/global, per scope",async()=>{
  for(const [kind,path,key,row] of [
    ["project","/api/target-staging/project-index/global","projects",projectRow],
    ["note","/api/target-staging/note-index/global","notes",noteRow],
  ])for(const scope of ["all","personal","shared"]){
    const seen=[];
    const fetchFake=async url=>{
      const u=new URL(String(url),"https://lumi.test");
      seen.push(u.pathname);
      assert.equal(u.searchParams.get("scope"),scope);
      assert.deepEqual([...u.searchParams.keys()].sort(),["limit","scope"]);
      return json({[key]:[row("a1",scope==="shared"?"shared":"private")],scope,hasMore:false,nextCursor:null});
    };
    const session=createKindIndexReadSession(kind,{scope,contextVersion:()=>GEN_A},fetchFake);
    const result=await session.loadFirst();
    assert.equal(result.ok,true,kind+scope);
    assert.deepEqual(seen,[path]);
    assert.ok(result.page.items.every(entry=>entry.kind===kind),"server rows only, no kind picking");
    assert.equal(result.page.items.length,1);
  }
});

test("kind index: strict DTO parsing refuses off-contract bodies, wrong scope and extra metadata",async()=>{
  const bodies=[
    {projects:[projectRow("a")],scope:"all",hasMore:false,nextCursor:null,revision:"x"},
    {projects:[{...projectRow("a"),members:["bob"]}],scope:"all",hasMore:false,nextCursor:null},
    {projects:[projectRow("a","shared")],scope:"personal",hasMore:false,nextCursor:null},
    {projects:[projectRow("a")],scope:"shared",hasMore:false,nextCursor:null},
    {projects:[projectRow("b"),projectRow("a")],scope:"all",hasMore:false,nextCursor:null},
    {projects:[projectRow("a")],scope:"all",hasMore:true,nextCursor:null},
    {notes:[noteRow("a")],scope:"all",hasMore:false,nextCursor:null}, // wrong envelope key for projects
    {items:[projectRow("a")],scope:"all",hasMore:false,nextCursor:null},
    [],"text",null,
  ];
  for(const body of bodies){
    const session=createKindIndexReadSession("project",{scope:body?.scope==="personal"||body?.scope==="shared"?body.scope:"all",contextVersion:()=>GEN_A},
      async()=>json(body));
    assert.deepEqual(await session.loadFirst(),{ok:false,reason:"invalid-response"},JSON.stringify(body));
  }
  // A malformed note (missing revision) is refused too.
  const note={id:"a",title:"t",projectId:null,areaId:"x",areaKind:"private"};
  const session=createKindIndexReadSession("note",{scope:"all",contextVersion:()=>GEN_A},
    async()=>json({notes:[note],scope:"all",hasMore:false,nextCursor:null}));
  assert.equal((await session.loadFirst()).ok,false);
});

test("kind index: status codes map like the combined index; cursor paging stays server-driven",async()=>{
  for(const [status,reason] of [[401,"signed-out"],[403,"signed-out"],[409,"stale"],[400,"invalid-request"],[404,"unavailable"],[503,"unavailable"]]){
    const session=createKindIndexReadSession("note",{scope:"all",contextVersion:()=>GEN_A},
      async()=>new Response("{}",{status}));
    assert.deepEqual(await session.loadFirst(),{ok:false,reason},String(status));
  }
  const cursors=[];
  const pages=[
    {projects:[projectRow("a")],scope:"all",hasMore:true,nextCursor:"aA.bA"},
    {projects:[projectRow("b","shared")],scope:"all",hasMore:false,nextCursor:null},
  ];
  const session=createKindIndexReadSession("project",{scope:"all",contextVersion:()=>GEN_A},async url=>{
    cursors.push(new URL(String(url),"https://lumi.test").searchParams.get("cursor"));
    return json(pages[cursors.length-1]);
  });
  await session.loadFirst();
  const more=await session.loadMore();
  assert.deepEqual(more.page.items.map(entry=>entry.item.id),["a","b"]);
  assert.deepEqual(cursors,[null,"aA.bA"]);
  // The adapter refuses requests for any other endpoint.
  await assert.rejects(()=>kindIndexFetch("project",async()=>json({}))("/api/other?scope=all"),TypeError);
});

test("kind index client keeps nothing: no storage, logging or global state",()=>{
  const source=read("lib/target-staging-kind-index-client.ts");
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|console\./);
});

test("429 maps to the rate_limited kind: client reason, distinct calm copy, retry later",async()=>{
  const {mapTargetClientFailure}=await import("../lib/target-client-errors.ts");
  for(const kind of ["project","note"]){
    const session=createKindIndexReadSession(kind,{scope:"all",contextVersion:()=>GEN_A},
      async()=>new Response("{}",{status:429}));
    assert.deepEqual(await session.loadFirst(),{ok:false,reason:"rate-limited"});
  }
  for(const language of ["cs","en"]){
    const mapped=mapTargetClientFailure("rate_limited",language);
    assert.equal(mapped.kind,"rate_limited");
    assert.equal(mapped.action,"retry_later");
  }
  const lists=read("app/ui/target-scope-lists.tsx");
  assert.match(lists,/state\.reason==="rate-limited"/);
  assert.match(lists,/<TargetDataStatus failure="rate_limited"/);
});

test("wiring: lists keyed by kind in the root; legacy unresolved-link notice suppressed for target lists",()=>{
  const root_=read("app/ui/lumi-app-root.tsx");
  assert.match(root_,/<TargetScopeLists key=\{scopeList\} kind=\{scopeList\}/);
  assert.match(root_,/app\.navigationUnavailable && !scopeList &&/);
  assert.match(root_,/variant=\{scopeList === null \? "plan" : "lists"\}/);
  const lists=read("app/ui/target-scope-lists.tsx");
  assert.match(lists,/state\.rowKind===kind&&state\.page\.scope===scope/);
  // Phone start ignores the scope key.
  const app=read("app/ui/use-lumi-app.tsx");
  assert.match(app,/previewMobileStart = isPreviewPhone && searchWithoutScope\(window\.location\.search\) === ""/);
});

test("CSS: scope ring/dot tones keep >= 3:1 on the track in light and dark",()=>{
  const lin=c=>{c/=255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;};
  const lum=hex=>{const n=parseInt(hex.slice(1),16);return 0.2126*lin(n>>16)+0.7152*lin((n>>8)&255)+0.0722*lin(n&255);};
  const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
  const css=read("app/ui/target-scopes.css");
  const tone=(selector)=>css.match(new RegExp(selector.replace(/[[\]"().]/g,"\\$&")+"\\{--scope-color:(#[0-9A-Fa-f]{6})"))?.[1];
  const light={all:tone('.targetScopeOption'),personal:tone('.targetScopeOption[data-scope-option="personal"]'),
    shared:tone('.targetScopeOption[data-scope-option="shared"]')};
  const dark={all:tone(':root[data-theme="dark"] .targetScopeOption'),
    personal:tone(':root[data-theme="dark"] .targetScopeOption[data-scope-option="personal"]'),
    shared:tone(':root[data-theme="dark"] .targetScopeOption[data-scope-option="shared"]')};
  for(const [name,hex] of Object.entries(light)){assert.ok(hex,"light "+name);assert.ok(ratio(hex,"#f2f2f5")>=3,"light "+name);}
  for(const [name,hex] of Object.entries(dark)){assert.ok(hex,"dark "+name);assert.ok(ratio(hex,"#313133")>=3,"dark "+name);}
  assert.notEqual(light.personal.toUpperCase(),"#16A34A"); // the UX tone itself is 2.95:1 on the track
});

test("kind index: the ORIGINAL body is size-bounded and strictly decoded before adaptation",async()=>{
  const okHeaders={"content-type":"application/json","cache-control":"no-store"};
  // Oversized Content-Length is refused without reading the body.
  let pulled=0;
  const huge=new ReadableStream({pull(controller){pulled++;controller.enqueue(new Uint8Array(1024));}});
  let session=createKindIndexReadSession("project",{scope:"all",contextVersion:()=>GEN_A},
    async()=>new Response(huge,{status:200,headers:{...okHeaders,"content-length":String(9*1024*1024)}}));
  assert.deepEqual(await session.loadFirst(),{ok:false,reason:"invalid-response"});
  assert.ok(pulled<=2,`body read despite oversized length (${pulled} pulls)`);
  // Chunked body without Content-Length is cut off past 8 MiB.
  const chunk=new Uint8Array(1024*1024).fill(0x20);
  let sent=0;
  const chunked=new ReadableStream({pull(controller){
    sent++;
    if(sent>20){controller.close();return;}
    controller.enqueue(chunk);
  }});
  session=createKindIndexReadSession("project",{scope:"all",contextVersion:()=>GEN_A},
    async()=>new Response(chunked,{status:200,headers:okHeaders}));
  assert.deepEqual(await session.loadFirst(),{ok:false,reason:"invalid-response"});
  assert.ok(sent<=10,`read past the bound (${sent} chunks)`);
  // Invalid UTF-8 is refused (strict decoder, not response.json()).
  session=createKindIndexReadSession("project",{scope:"all",contextVersion:()=>GEN_A},
    async()=>new Response(new Uint8Array([0x7b,0x22,0xff,0x22,0x3a,0x31,0x7d]),{status:200,headers:okHeaders}));
  assert.deepEqual(await session.loadFirst(),{ok:false,reason:"invalid-response"});
  const source=read("lib/target-staging-kind-index-client.ts");
  assert.doesNotMatch(source,/response\.json\(\)/);
  assert.match(source,/boundedJson\(response,/);
});

test("kind index: an abort during the body read rejects like an aborted fetch",async()=>{
  const controller=new AbortController();
  const body=new ReadableStream({pull(){return new Promise(()=>{});}});
  const pending=kindIndexFetch("note",async()=>new Response(body,{status:200,headers:{"cache-control":"no-store"}}))(
    "/api/target-staging/global-index?scope=all",{signal:controller.signal});
  controller.abort();
  await assert.rejects(pending);
});
