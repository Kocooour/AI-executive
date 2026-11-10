"use client";
/** R3-FE-4a: the open authorized detail lives ONLY in the address (reload,
 * Back/Forward and deep links restore it) and every open is re-verified by the
 * server. Nothing is stored in browser storage; the only in-memory extras are
 * the key of the row focus returns to. */
import {useSyncExternalStore} from "react";
import {scopeFromSearch} from "../../lib/view-url";
import {
  canStepBack,detailHistoryState,detailIdOk,detailRouteKey,detailRowKey,parentSearchForDetail,
  searchForDetail,TARGET_ADDRESS_EVENT,type TargetDetailRoute,
} from "../../lib/target-detail-route";

const noopSubscribe=()=>()=>{};
function subscribe(notify:()=>void):()=>void{
  window.addEventListener("popstate",notify);
  window.addEventListener(TARGET_ADDRESS_EVENT,notify);
  return ()=>{
    window.removeEventListener("popstate",notify);
    window.removeEventListener(TARGET_ADDRESS_EVENT,notify);
  };
}
/** Current `location.search` (a primitive, so the snapshot is stable). Inert when disabled. */
export function useTargetSearch(enabled:boolean):string{
  return useSyncExternalStore(enabled?subscribe:noopSubscribe,
    ()=>enabled?window.location.search:"",()=>"");
}

function announce():void{window.dispatchEvent(new Event(TARGET_ADDRESS_EVENT));}

// Row focus return: keyed (not by element) so it survives list/detail remounts.
const origins=new Map<string,string>();
let pendingFocus:{key:string;expires:number}|null=null;

/** Opening is a navigation step (a new history entry), so Back returns to the origin. */
export function openTargetDetail(route:TargetDetailRoute,opener?:Element|null):void{
  // Rows are only rendered as buttons for IDs this passes; never a silent no-op click.
  if(!detailIdOk(route.id)||(route.projectId!==undefined&&!detailIdOk(route.projectId)))return;
  const scope=scopeFromSearch(window.location.search);
  const row=opener?.closest("[data-detail-row]")?.getAttribute("data-detail-row");
  if(row)origins.set(detailRouteKey(route),row);
  pendingFocus=null;
  try{
    const search=searchForDetail(route,scope);
    window.history.pushState(detailHistoryState(scope,search),"",`${window.location.pathname}${search}`);
  }catch{return;/* History API blocked: nothing opens. */}
  announce();
}

/** Close steps Back only when this tab pushed the entry under the same scope;
 * otherwise (pasted link, other tab, scope changed meanwhile) it replaces the
 * address with the parent for the CURRENT scope, never leaving the site. */
export function closeTargetDetail(route:TargetDetailRoute|null):void{
  if(canStepBack(window.history.state,window.location.search)){
    window.history.back();
    return;
  }
  try{
    window.history.replaceState(null,"",`${window.location.pathname}${parentSearchForDetail(
      route,scopeFromSearch(window.location.search),window.location.search)}`);
  }catch{/* The address stays; the detail simply remains open. */}
  announce();
}

/** Remember where focus should return when the given route stops being shown. */
export function expectFocusReturn(route:TargetDetailRoute):void{
  pendingFocus={key:origins.get(detailRouteKey(route))??"",expires:Date.now()+3000};
}
/** Focus the originating row if it exists (call again after rows render). */
export function focusPendingRow(fallback?:HTMLElement|null,allowMissingRow=false):boolean{
  const pending=pendingFocus;
  if(!pending)return false;
  if(Date.now()>pending.expires){pendingFocus=null;return false;}
  const rows=pending.key?document.querySelectorAll<HTMLElement>("[data-detail-row]"):[];
  for(const row of Array.from(rows)){
    if(row.getAttribute("data-detail-row")===pending.key&&row.isConnected&&row.getClientRects().length){
      row.focus({preventScroll:false});
      pendingFocus=null;
      return true;
    }
  }
  if(fallback?.isConnected&&(!pending.key||allowMissingRow)){fallback.focus();pendingFocus=null;return true;}
  return false;
}
export {detailRowKey};
