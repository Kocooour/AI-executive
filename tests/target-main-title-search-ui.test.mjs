import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {createStagingTitleSearchSession} from "../lib/target-staging-title-search-session.ts";
import {
  TARGET_MAIN_TITLE_SEARCH_FLAGS,targetMainTitleSearchEnabled,
  visibleMainTitleSearchResult,mainTitleSearchCopy,
  subscribeMainTitleSearchAclInvalidation,
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
  assert.match(ui,/window\.addEventListener\("offline"/);
  assert.match(ui,/session\.next\(\)/);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|indexedDB|document\.cookie/i);
});

test("same-generation ACL revocation tick removes shared titles and aborts late results",async()=>{
  const subscribers=new Set();
  const runtime={subscribeTick(listener){
    subscribers.add(listener);
    return ()=>subscribers.delete(listener);
  }};
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
  assert.doesNotMatch(
    (await import("node:fs")).readFileSync("app/ui/target-main-title-search.tsx","utf8"),
    /setInterval\(|setTimeout\(/,
    "no search polling/prefetch should be added by the ACL invalidation");
});
