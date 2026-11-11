import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  TARGET_MAIN_TITLE_SEARCH_FLAGS,targetMainTitleSearchEnabled,
  visibleMainTitleSearchResult,mainTitleSearchCopy,
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
  assert.doesNotMatch(nav,/\bSearch\b/);
  assert.match(ui,/useTargetScope\(\)/);
  assert.match(ui,/useTargetSession\(/);
  assert.match(ui,/window\.addEventListener\("offline"/);
  assert.match(ui,/session\.next\(\)/);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|indexedDB|document\.cookie/i);
});
