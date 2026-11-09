"use client";
/** R3-FE-3: the ONE global reading scope, kept in the address (`?scope=`) so
 * reload, Back/Forward and deep links restore it. The address is the single
 * source of truth: nothing is stored in browser storage, and the value is only
 * ever used to choose which server query to make (never an authorization claim). */
import {useCallback,useSyncExternalStore} from "react";
import {withoutDetailMarker} from "../../lib/target-detail-route";
import {defaultUrlScope,scopeFromSearch,searchWithScope,type UrlScope} from "../../lib/view-url";

const CHANGED="lumi-target-scope-changed";

function subscribe(notify:()=>void):()=>void{
  window.addEventListener("popstate",notify);
  window.addEventListener(CHANGED,notify);
  return ()=>{
    window.removeEventListener("popstate",notify);
    window.removeEventListener(CHANGED,notify);
  };
}
const snapshot=():UrlScope=>scopeFromSearch(window.location.search);
const serverSnapshot=():UrlScope=>defaultUrlScope;

/** Selecting a scope is a navigation step (a new history entry), so Back returns to the previous scope. */
export function writeTargetScope(next:UrlScope):void{
  if(snapshot()===next)return;
  try{
    // The target-detail marker belongs to the entry it was pushed with, never to this one.
    window.history.pushState(withoutDetailMarker(window.history.state),"",
      `${window.location.pathname}${searchWithScope(window.location.search,next)}${window.location.hash}`);
  }catch{/* History API blocked: the scope simply stays unchanged. */}
  window.dispatchEvent(new Event(CHANGED));
}

export function useTargetScope():UrlScope{
  return useSyncExternalStore(subscribe,snapshot,serverSnapshot);
}
export function useSetTargetScope():(next:UrlScope)=>void{
  return useCallback(next=>writeTargetScope(next),[]);
}
