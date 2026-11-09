import assert from "node:assert/strict";
import {test} from "node:test";

/** Minimal browser: location + history with Back/Forward and popstate. */
function installBrowser(initial){
  const events=new EventTarget();
  const entries=[initial];let index=0;
  const parse=url=>{const u=new URL(url,"https://lumi.test");return {pathname:u.pathname,search:u.search,hash:u.hash};};
  const win={
    location:{...parse(initial)},
    history:{
      state:null,
      pushState(state,_t,url){entries.length=index+1;entries.push(url);index++;this.state=state;Object.assign(win.location,parse(url));},
      replaceState(state,_t,url){entries[index]=url;this.state=state;Object.assign(win.location,parse(url));},
    },
    addEventListener:(t,fn)=>events.addEventListener(t,fn),
    removeEventListener:(t,fn)=>events.removeEventListener(t,fn),
    dispatchEvent:e=>events.dispatchEvent(e),
  };
  const go=delta=>{index+=delta;Object.assign(win.location,parse(entries[index]));events.dispatchEvent(new Event("popstate"));};
  globalThis.window=win;
  return {win,go,entries:()=>[...entries]};
}

test("R3-FE-3 URL scope state: select pushes a history entry; Back/Forward/reload restore it",async()=>{
  const {writeTargetScope}=await import("../app/ui/target-scope-state.ts");
  const {scopeFromSearch}=await import("../lib/view-url.ts");
  const {win,go,entries}=installBrowser("/?view=Projects");
  const seen=[];
  win.addEventListener("lumi-target-scope-changed",()=>seen.push(scopeFromSearch(win.location.search)));
  writeTargetScope("personal");
  writeTargetScope("shared");
  writeTargetScope("shared"); // no duplicate history step
  assert.deepEqual(entries(),["/?view=Projects","/?view=Projects&scope=personal","/?view=Projects&scope=shared"]);
  go(-1);
  assert.equal(scopeFromSearch(win.location.search),"personal");
  go(-1);
  assert.equal(scopeFromSearch(win.location.search),"all");
  go(+2);
  assert.equal(scopeFromSearch(win.location.search),"shared");
  // Subscribers are told about every write (the hook re-reads the address).
  assert.deepEqual(seen,["personal","shared"]);
  // Selecting "all" removes the key (default) but keeps the view.
  writeTargetScope("all");
  assert.equal(win.location.search,"?view=Projects");
  delete globalThis.window;
});

test("R3-FE-3 URL scope state: history failure leaves the address untouched and never throws",async()=>{
  const {writeTargetScope}=await import("../app/ui/target-scope-state.ts");
  const {win}=installBrowser("/?view=Notes");
  win.history.pushState=()=>{throw new Error("blocked");};
  assert.doesNotThrow(()=>writeTargetScope("shared"));
  assert.equal(win.location.search,"?view=Notes");
  delete globalThis.window;
});
