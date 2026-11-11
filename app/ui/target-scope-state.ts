"use client";
/** R3-FE-3: the ONE global reading scope, kept in the address (`?scope=`) so
 * reload, Back/Forward and deep links restore it. The address is the single
 * source of truth: nothing is stored in browser storage, and the value is only
 * ever used to choose which server query to make (never an authorization claim). */
import {useCallback,useSyncExternalStore} from "react";
import {TARGET_SCOPE_CHANGED,writeTargetReadingScope} from "../../lib/target-reading-scope-nav";
import {defaultUrlScope,scopeFromSearch,type UrlScope} from "../../lib/view-url";

const CHANGED=TARGET_SCOPE_CHANGED;

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

/** Selecting a scope is a navigation step; all target UI call sites share the same rule. */
export const writeTargetScope=writeTargetReadingScope;

export function useTargetScope():UrlScope{
  return useSyncExternalStore(subscribe,snapshot,serverSnapshot);
}
export function useSetTargetScope():(next:UrlScope)=>void{
  return useCallback(next=>writeTargetScope(next),[]);
}
