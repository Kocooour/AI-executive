import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {createStagingTitleSearchSession} from "../lib/target-staging-title-search-session.ts";
import {
  TARGET_MAIN_TITLE_SEARCH_FLAGS,targetMainTitleSearchEnabled,
  visibleMainTitleSearchResult,mainTitleSearchCopy,
  subscribeMainTitleSearchAclInvalidation,mainTitleSearchLegacySurfaces,
  mainTitleSearchDetailRoute,rememberMainTitleSearchReturn,
  consumeMainTitleSearchReturn,clearMainTitleSearchReturn,
} from "../lib/target-main-title-search-ui.ts";

const all=Object.fromEntries(TARGET_MAIN_TITLE_SEARCH_FLAGS.map(k=>[k,"true"]));
test("main Search is entirely opt-in, every scope/server flag is required",()=>{
  assert.equal(targetMainTitleSearchEnabled(all),true);
  for(const key of TARGET_MAIN_TITLE_SEARCH_FLAGS){
    const env={...all};delete env[key];
    assert.equal(targetMainTitleSearchEnabled(env),false,key+" missing");
    for(const bad of ["1","TRUE","yes","false",""]){
      assert.equal(targetMainTitleSearchEnabled({...all,[key]:bad}),false,key+" "+bad);
    }
  }
  assert.equal(targetMainTitleSearchEnabled({}),false);
});
const snapshot={status:"ready",query:"school",scope:"all",limit:25,items:[
  {kind:"note",id:"note",title:"School",areaId:"private",areaKind:"private",projectId:null},
],hasMore:false,limitReached:false,nextCursor:null,failure:null};
const binding={input:"school",scope:"all",generation:"g1"};
const bound={binding,snapshot,failure:null};
test("titles and count vanish immediately on actor, scope, raw query or gate change",()=>{
  assert.equal(visibleMainTitleSearchResult(bound,binding,true),bound);
  assert.equal(visibleMainTitleSearchResult(bound,{...binding,generation:"g2"},true),null);
  assert.equal(visibleMainTitleSearchResult(bound,{...binding,generation:""},true),null);
  assert.equal(visibleMainTitleSearchResult(bound,{...binding,scope:"shared"},true),null);
  assert.equal(visibleMainTitleSearchResult(bound,{...binding,input:"school "},true),null);
  assert.equal(visibleMainTitleSearchResult(bound,binding,false),null);
  assert.equal(visibleMainTitleSearchResult(null,binding,true),null);
  assert.equal(visibleMainTitleSearchResult({...bound,snapshot:{...snapshot,scope:"personal"}},binding,true),null);
  assert.equal(visibleMainTitleSearchResult({...bound,snapshot:{...snapshot,query:"other"}},binding,true),null);
});
test("Search opens only existing target view destinations, with valid IDs and kind gates",()=>{
  const gates={task:true,project:true,note:true};
  const views=["Projects","Notes","MyPlanPreview"];
  for(const [kind,view] of [["project","Projects"],["task","MyPlanPreview"],["note","Notes"]]){
    const item={kind,id:kind+"-1",title:"Title",areaId:"area-1",areaKind:"private",
      ...(kind==="project"?{}:{projectId:kind==="task"?"project-1":null})};
    const route=mainTitleSearchDetailRoute(item,gates,views);
    assert.deepEqual(route,{kind,id:item.id,view},kind);
    assert.equal(mainTitleSearchDetailRoute(item,{...gates,[kind]:false},views),null,kind+" off");
    for(const badId of [" padded ","bad/id",".","..","x".repeat(257),"x\\\\y"]){
      assert.equal(mainTitleSearchDetailRoute({...item,id:badId},gates,views),null,kind+" "+badId);
    }
    assert.equal(mainTitleSearchDetailRoute(item,gates,[]),null,kind+" no target destination");
    if(kind!=="task"){
      assert.equal(mainTitleSearchDetailRoute(item,gates,views.filter(v=>v!==view)),null,
        kind+" destination disabled");
    }
  }
  const task={kind:"task",id:"task-1",title:"Task",areaId:"area-1",areaKind:"private",projectId:"project-1"};
  assert.deepEqual(mainTitleSearchDetailRoute(task,gates,["Projects"]),
    {kind:"task",id:"task-1",view:"Projects",projectId:"project-1"},
    "project task can open from Search without My Plan");
  assert.equal(mainTitleSearchDetailRoute({...task,projectId:null},gates,["Projects"]),null,
    "standalone task cannot open via a fake Projects link");
  assert.equal(mainTitleSearchDetailRoute({...task,projectId:"bad/id"},gates,["Projects"]),null,
    "invalid project ID cannot open a Projects task detail");
  assert.equal(mainTitleSearchDetailRoute(task,gates,["Notes"]),null,
    "task is not clickable when only Notes is active");
  assert.equal(mainTitleSearchDetailRoute(task,{...gates,task:false},["Projects"]),null);
});

test("one-use Search return bridge is erased across A→B→A rotation and security clears",()=>{
  const before=Object.fromEntries(["window","document","navigator"].map(key=>
    [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const win=new EventTarget();
  const doc=Object.assign(new EventTarget(),{visibilityState:"visible"});
  Object.defineProperty(globalThis,"window",{configurable:true,value:win});
  Object.defineProperty(globalThis,"document",{configurable:true,value:doc});
  Object.defineProperty(globalThis,"navigator",{configurable:true,value:{onLine:true}});
  const generations=new Set(),security=new Set(),ticks=new Set(),outcomes=new Set();
  let generation="g1";
  const observe=set=>fn=>{set.add(fn);return ()=>set.delete(fn);};
  const runtime={
    generation:()=>generation,lastOutcome:()=>"ok",
    subscribe:observe(generations),subscribeSecurityClear:observe(security),
    subscribeTick:observe(ticks),subscribeOutcome:observe(outcomes),
  };
  const fire=set=>{for(const callback of [...set])callback();};
  try{
    clearMainTitleSearchReturn();
    rememberMainTitleSearchReturn(bound,binding,runtime);
    assert.equal(consumeMainTitleSearchReturn(binding,runtime)?.snapshot.items[0].title,"School",
      "unchanged identity gets one focus-return result");
    assert.equal(consumeMainTitleSearchReturn(binding,runtime),null,"bridge is single-use");

    rememberMainTitleSearchReturn(bound,binding,runtime);
    generation="g2";fire(generations);
    generation="g1";fire(generations);
    assert.equal(consumeMainTitleSearchReturn(binding,runtime),null,
      "A→B→A must not recover A's old titles");

    rememberMainTitleSearchReturn(bound,binding,runtime);
    fire(security);
    assert.equal(consumeMainTitleSearchReturn(binding,runtime),null,"explicit sign-out erases titles");

    rememberMainTitleSearchReturn(bound,binding,runtime);
    fire(ticks);
    assert.equal(consumeMainTitleSearchReturn(binding,runtime),null,
      "same-generation ACL revalidation also erases titles");

    rememberMainTitleSearchReturn(bound,binding,runtime);
    generation="g3";
    assert.equal(consumeMainTitleSearchReturn(binding,runtime),null,
      "consume checks generation even if a listener did not fire");
  }finally{
    clearMainTitleSearchReturn();
    for(const key of ["window","document","navigator"]){
      const descriptor=before[key];
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  }
});

test("main Search copy is bilingual and never calls All my personal work",()=>{
  const cs=mainTitleSearchCopy.cs,en=mainTitleSearchCopy.en;
  assert.deepEqual(Object.keys(cs).sort(),Object.keys(en).sort());
  assert.deepEqual(Object.keys(cs.failures).sort(),Object.keys(en.failures).sort());
  assert.match(cs.intro,/Vše není Můj plán/);
  assert.match(en.intro,/All is not My Plan/);
  assert.ok(cs.count(3).includes("3")&&en.count(3).includes("3"));
});
test("shell switches exactly the Search view to server titles; no new bottom nav link",()=>{
  const root=readFileSync("app/ui/lumi-app-root.tsx","utf8");
  const topbar=readFileSync("app/ui/views/topbar.tsx","utf8");
  const nav=readFileSync("app/ui/views/mobile-nav.tsx","utf8");
  const page=readFileSync("app/page.tsx","utf8");
  const ui=readFileSync("app/ui/target-main-title-search.tsx","utf8");
  assert.match(root,/TargetMainTitleSearch/);
  assert.match(root,/targetSearch\s*&&\s*view==="Search"/);
  assert.match(page,/targetMainTitleSearchEnabled/);
  assert.match(topbar,/setView\("Search"\)/);
  assert.match(topbar,/TARGET_MAIN_SEARCH_SUBMIT_EVENT/);
  assert.match(ui,/addEventListener\(TARGET_MAIN_SEARCH_SUBMIT_EVENT/);
  assert.doesNotMatch(nav,/\bSearch\b/);
  assert.match(ui,/useTargetScope\(\)/);
  assert.match(ui,/useTargetSession\(/);
  assert.match(ui,/subscribeMainTitleSearchAclInvalidation\(runtime/);
  assert.match(ui,/const verificationReady=runtime\?\.lastOutcome\(\)==="ok"/);
  assert.match(ui,/if\(!session\|\|!allowed\)return/);
  assert.match(ui,/window\.addEventListener\("offline"/);
  assert.match(ui,/session\.next\(\)/);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|indexedDB|document\.cookie/i);
});


test("authorized Search never mounts legacy task or held-back titles, including before submit and during paging",()=>{
  // Guard the actual root JSX, not just the target-only SearchResults ternary.
  // A pre-existing local task or held-back record must never be present on the
  // authorized Search screen regardless of the remote response lifecycle.
  const root=readFileSync("app/ui/lumi-app-root.tsx","utf8");
  assert.match(root,/const legacySearchSurfaces = mainTitleSearchLegacySurfaces\(targetSearch,view\);/);
  assert.match(root,/\{legacySearchSurfaces\.heldBack && <HeldBack app=\{app\} \/>\}/);
  assert.match(root,/: legacySearchSurfaces\.entityList\s*\? <EntityList app=\{app\} \/>\s*: null\}/);
  const legacyTask="PRIVATE LEGACY TASK NOT AUTHORIZED BY TARGET";
  const heldBack="PRIVATE HELD-BACK TITLE NOT AUTHORIZED BY TARGET";
  const presentTitles=(enabled,view)=>{
    const surfaces=mainTitleSearchLegacySurfaces(enabled,view);
    return [
      ...(surfaces.entityList?[legacyTask]:[]),
      ...(surfaces.heldBack?[heldBack]:[]),
    ];
  };
  for(const phase of ["before-submit","loading","ready","load-more","empty","error"]){
    assert.deepEqual(presentTitles(true,"Search"),[],phase);
    assert.deepEqual(mainTitleSearchLegacySurfaces(true,"Search"),
      {heldBack:false,entityList:false},phase);
  }
  // Default-off Search and unrelated views retain existing legacy behaviour.
  assert.deepEqual(presentTitles(false,"Search"),[legacyTask,heldBack]);
  for(const view of ["Today","Projects","Notes","Home","Inbox"])
    assert.deepEqual(presentTitles(true,view),[legacyTask,heldBack],view);
  // The target component continues to own result pagination, never a fallback
  // into local task rows even while no server data has loaded.
  assert.match(root,/\{view==="Search" && targetSearch\s*\? <TargetMainTitleSearch/);
  assert.match(root,/: <SearchResults app=\{app\} \/>\}/);
});

test("same-generation ACL revocation tick removes shared titles and aborts late results",async()=>{
  const subscribers=new Set(),outcomeSubscribers=new Set();
  let outcome="ok";
  const runtime={
    subscribeTick(listener){
      subscribers.add(listener);
      return ()=>subscribers.delete(listener);
    },
    subscribeOutcome(listener){
      outcomeSubscribers.add(listener);
      return ()=>outcomeSubscribers.delete(listener);
    },
    lastOutcome(){return outcome;},
  };
  const emitVerifiedTick=()=>{for(const fn of [...subscribers])fn();};
  const item={kind:"task",id:"shared-id",title:"Confidential shared title",
    areaId:"shared-area",areaKind:"shared",projectId:null};
  const page=()=>new Response(JSON.stringify({
    query:"school",scope:"shared",items:[item],hasMore:false,nextCursor:null,
  }),{headers:{"content-type":"application/json","cache-control":"private, no-store"}});
  let pendingResolve=null,neverSettled=false;
  const fetchImpl=async()=>{
    if(!neverSettled)return page();
    return new Promise(resolve=>{pendingResolve=resolve;});
  };
  const session=createStagingTitleSearchSession(fetchImpl);
  const current={input:"school",scope:"shared",generation:"same-generation"};
  let displayed=null,epoch=0;
  const subscribe=subscribeMainTitleSearchAclInvalidation(runtime,()=>{
    epoch++;
    session.reset();
    displayed=null;
  });
  const first=await session.first({query:"school",scope:"shared",limit:25});
  assert.deepEqual(first,{ok:true});
  displayed={binding:current,snapshot:session.getSnapshot(),failure:null};
  assert.equal(visibleMainTitleSearchResult(displayed,current,true)?.snapshot.items[0].title,
    "Confidential shared title");
  // The server revoked the membership before its next successful runtime
  // verification. Authentication remains the same; only the ACL changed.
  emitVerifiedTick();
  assert.equal(current.generation,"same-generation");
  assert.equal(displayed,null,"titles and counts must be discarded, not refreshed");
  assert.equal(session.getSnapshot().items.length,0);
  assert.equal(session.getSnapshot().status,"idle");

  // If an old explicit request resolves AFTER the ACL tick it cannot refill
  // the screen, even if its fetch adapter disregards AbortSignal.
  neverSettled=true;
  const run=++epoch;
  const old=session.first({query:"school",scope:"shared",limit:25}).then(outcome=>{
    if(run===epoch&&outcome.ok)displayed={
      binding:current,snapshot:session.getSnapshot(),failure:null,
    };
    return outcome;
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof pendingResolve,"function");
  emitVerifiedTick();
  pendingResolve(page());
  assert.deepEqual(await old,{ok:false,reason:"aborted"});
  assert.equal(displayed,null);
  assert.equal(session.getSnapshot().items.length,0);
  assert.equal(subscribers.size,1);
  subscribe();
  assert.equal(subscribers.size,0);
  assert.equal(outcomeSubscribers.size,0);
  assert.doesNotMatch(
    (await import("node:fs")).readFileSync("app/ui/target-main-title-search.tsx","utf8"),
    /setInterval\(|setTimeout\(/,
    "no search polling/prefetch should be added by the ACL invalidation");
});

test("failed same-generation revalidation removes shared titles, aborts late reads and gates Enter",async()=>{
  const ticks=new Set(),outcomes=new Set();
  let outcome="ok";
  const runtime={
    lastOutcome:()=>outcome,
    subscribeTick(fn){ticks.add(fn);return ()=>ticks.delete(fn);},
    subscribeOutcome(fn){outcomes.add(fn);return ()=>outcomes.delete(fn);},
  };
  let displayed=null,epoch=0;
  let resolvePending=null;
  let slow=false;
  const page=()=>new Response(JSON.stringify({
    query:"school",scope:"shared",items:[{
      kind:"task",id:"revoked-task",title:"Private shared title",
      areaId:"shared-area",areaKind:"shared",projectId:null,
    }],hasMore:false,nextCursor:null,
  }),{headers:{"content-type":"application/json","cache-control":"private, no-store"}});
  const fetchImpl=async()=>slow
    ?new Promise(resolve=>{resolvePending=resolve;}):page();
  const session=createStagingTitleSearchSession(fetchImpl);
  const binding={input:"school",scope:"shared",generation:"unchanged-login"};
  const unbind=subscribeMainTitleSearchAclInvalidation(runtime,()=>{
    ++epoch;session.reset();displayed=null;
  });
  const confirmed=()=>runtime.lastOutcome()==="ok";
  const first=await session.first({query:"school",scope:"shared",limit:25});
  assert.deepEqual(first,{ok:true});
  displayed={binding,snapshot:session.getSnapshot(),failure:null};
  assert.equal(visibleMainTitleSearchResult(displayed,binding,confirmed())?.snapshot.items.length,1);

  // A passive 503 / timeout does NOT change login generation or emit a tick.
  // A lost Area ACL cannot be ruled out, so the result must disappear anyway.
  outcome="unavailable";
  for(const fn of [...outcomes])fn();
  assert.equal(binding.generation,"unchanged-login");
  assert.equal(ticks.size,1);
  assert.equal(displayed,null);
  assert.equal(session.getSnapshot().status,"idle");
  assert.equal(session.getSnapshot().items.length,0);
  assert.equal(confirmed(),false,"button and topbar Enter must refuse new reads");

  // Recovery merely permits another explicit submit; it never resurrects rows.
  outcome="ok";
  for(const fn of [...outcomes])fn();
  assert.equal(confirmed(),true);
  assert.equal(displayed,null);
  slow=true;
  const run=++epoch;
  const old=session.first({query:"school",scope:"shared",limit:25}).then(result=>{
    if(run===epoch&&confirmed()&&result.ok)
      displayed={binding,snapshot:session.getSnapshot(),failure:null};
    return result;
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof resolvePending,"function");
  outcome="unavailable";
  for(const fn of [...outcomes])fn();
  resolvePending(page());
  assert.deepEqual(await old,{ok:false,reason:"aborted"});
  assert.equal(displayed,null);
  assert.equal(session.getSnapshot().status,"idle");

  for(const refusal of ["signed_out","feature_off"]){
    outcome="ok";
    for(const fn of [...outcomes])fn();
    displayed={binding,snapshot,failure:null};
    outcome=refusal;
    for(const fn of [...outcomes])fn();
    assert.equal(displayed,null,refusal+" must fail closed");
    assert.equal(confirmed(),false);
  }
  unbind();
  assert.equal(ticks.size,0);
  assert.equal(outcomes.size,0);
});
