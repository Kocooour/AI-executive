/** R3-FE-4a: typed address of an authorized detail opened INSIDE the main app.
 * Pure and serializable. An address names the requested target only; it is
 * never an authorization claim: every open is re-verified by the server.
 * The global reading scope (`scope`) is orthogonal and always preserved. */
import {
  scopeFromSearch,searchForTarget,searchForView,searchWithScope,searchWithoutScope,targetFromSearch,
  type UrlScope,
} from "./view-url";

export type TargetDetailKind="task"|"project"|"note";
export type TargetDetailView="Projects"|"Notes"|"MyPlanPreview";
export type TargetDetailRoute={
  kind:TargetDetailKind;id:string;view:TargetDetailView;projectId?:string;
};
export type TargetDetailGates={task:boolean;project:boolean;note:boolean};
export type TargetDetailRequest=
  |{state:"none"}
  /** A typed address that cannot be opened (malformed, ambiguous, or its kind is not enabled). */
  |{state:"unavailable"}
  |{state:"route";route:TargetDetailRoute};

/** In-memory address change notification (pushState does not emit one). */
export const TARGET_ADDRESS_EVENT="lumi-target-address-changed";
const START_VIEW="Home";
const KNOWN_VIEWS:readonly string[]=[START_VIEW,"Projects","Notes","MyPlanPreview"];
const DETAIL_VIEWS:readonly TargetDetailView[]=["Projects","Notes","MyPlanPreview"];
const typedKeys=["projectId","taskId","noteId"] as const;

/** True when the address asks for a typed record at all (valid or not). */
export function requestsTargetRecord(search:string):boolean{
  const params=new URLSearchParams(search);
  return typedKeys.some(key=>params.has(key));
}

const controls=/[\u0000-\u001f\u007f]/u;
/** The one ID rule of the detail layer: the INTERSECTION of the address rules
 * (lib/view-url.ts: 1..256 UTF-16 units, no control characters) and the rules of
 * every strict detail client and server route (non-empty, not padded, not "." / "..",
 * no path separators, well-formed UTF-16, at most 512 UTF-8 bytes). A row whose ID
 * fails this rule is shown as plain text, never as a button that cannot open.
 * (The server accepts a few more legacy IDs - empty, padded, very long ones - which
 * therefore stay readable only through their text row. Parity is tested.) */
export function detailIdOk(id:unknown):id is string{
  if(typeof id!=="string"||id.length===0||id.length>256||id.trim()!==id||
    id==="."||id===".."||id.includes("/")||id.includes("\\")||controls.test(id))return false;
  try{
    if(decodeURIComponent(encodeURIComponent(id))!==id)return false;
  }catch{return false;}
  return new TextEncoder().encode(id).length<=512;
}

/** The view an address names (before any validation), else null. */
export function viewOfSearch(search:string):string|null{
  return new URLSearchParams(searchWithoutScope(search)).get("view");
}

/** Strict parse: only the route shapes the app itself generates are accepted. */
export function detailRouteFromSearch(search:string):TargetDetailRoute|null{
  const params=new URLSearchParams(searchWithoutScope(search));
  // A record address always names its view explicitly.
  if(!params.has("view"))return null;
  const target=targetFromSearch(search,KNOWN_VIEWS,START_VIEW);
  if(!target||target.kind==="view")return null;
  if(!detailIdOk(target.id)||("projectId" in target&&target.projectId!==undefined&&!detailIdOk(target.projectId)))
    return null;
  if(target.kind==="project")
    return {kind:"project",id:target.id,view:"Projects"};
  if(target.kind==="task"){
    if(target.view==="Projects"&&target.projectId!==undefined)
      return {kind:"task",id:target.id,view:"Projects",projectId:target.projectId};
    if(target.view==="MyPlanPreview"&&target.projectId===undefined)
      return {kind:"task",id:target.id,view:"MyPlanPreview"};
    return null;
  }
  if(target.view==="Notes"&&target.projectId===undefined)
    return {kind:"note",id:target.id,view:"Notes"};
  return null;
}

/** True for the My Plan address that carries a task detail (so the shell shows the plan). */
export function isPlanDetailSearch(search:string):boolean{
  return detailRouteFromSearch(search)?.view==="MyPlanPreview";
}

export function detailRequestFromSearch(search:string,gates:TargetDetailGates):TargetDetailRequest{
  if(!requestsTargetRecord(search))return {state:"none"};
  const route=detailRouteFromSearch(search);
  // Same calm answer for malformed addresses and for kinds that are switched off.
  if(!route||gates[route.kind]!==true)return {state:"unavailable"};
  return {state:"route",route};
}

export function searchForDetail(route:TargetDetailRoute,scope:UrlScope):string{
  if(!detailIdOk(route.id)||(route.projectId!==undefined&&!detailIdOk(route.projectId)))
    throw new TypeError("Invalid detail ID");
  const base=searchForTarget(
    route.kind==="project"?{kind:"project",id:route.id}
      :{kind:route.kind,id:route.id,view:route.view,
        ...(route.projectId===undefined?{}:{projectId:route.projectId})},
    START_VIEW,KNOWN_VIEWS);
  return searchWithScope(base,scope);
}

/** Where "close" leads: a task in a project returns to the project, anything else to
 * the view's own list. Without a route (the unavailable overlay) the view named by
 * the CURRENT address is kept, so address and shell never disagree. */
export function parentSearchForDetail(route:TargetDetailRoute|null,scope:UrlScope,currentSearch=""):string{
  if(route?.kind==="task"&&route.view==="Projects"&&route.projectId!==undefined)
    return searchForDetail({kind:"project",id:route.projectId,view:"Projects"},scope);
  const named=viewOfSearch(currentSearch);
  const view=(route?.view??(named!==null&&(DETAIL_VIEWS as readonly string[]).includes(named)?named:"Projects")) as TargetDetailView;
  return searchWithScope(view==="MyPlanPreview"?"?view=MyPlanPreview":searchForView(view,START_VIEW),scope);
}

export const detailRouteKey=(route:TargetDetailRoute):string=>
  `${route.kind}:${route.id}${route.projectId===undefined?"":`@${route.projectId}`}`;
/** Attribute value a list row carries so focus can return to it. */
export const detailRowKey=(kind:TargetDetailKind,id:string):string=>`${kind}:${id}`;

/** The route that stays "open" while closing steps back to its parent. */
export function isParentOf(parent:TargetDetailRoute|null,child:TargetDetailRoute|null):boolean{
  return child?.kind==="task"&&child.projectId!==undefined&&
    parent?.kind==="project"&&parent.id===child.projectId;
}

/** The marker is bound to the exact entry it was pushed with (its address), so a
 * copy of the state on another entry - e.g. a later scope change - never counts. */
export type TargetDetailHistoryState={lumiTargetDetail:{scope:UrlScope;search:string}};
export function detailHistoryState(scope:UrlScope,search:string):TargetDetailHistoryState{
  return {lumiTargetDetail:{scope,search}};
}
/** True when the current history entry was pushed by opening a detail IN THIS TAB
 * for exactly this address and scope: only then may close step Back. */
export function canStepBack(state:unknown,search:string):boolean{
  if(state===null||typeof state!=="object")return false;
  const flag=(state as Partial<TargetDetailHistoryState>).lumiTargetDetail;
  return flag!==undefined&&flag!==null&&typeof flag==="object"&&
    flag.scope===scopeFromSearch(search)&&flag.search===search;
}
/** History state for a NEW entry (scope change, ...): never carries the detail marker. */
export function withoutDetailMarker(state:unknown):unknown{
  if(state===null||typeof state!=="object"||!("lumiTargetDetail" in (state as object)))return state;
  const {lumiTargetDetail:_marker,...rest}=state as Record<string,unknown>;
  void _marker;
  return Object.keys(rest).length===0?null:rest;
}

// ---- which addresses the detail layer may act on --------------------------
/** An address is a TARGET address only for a view that really renders target
 * data; for every other view typed addresses keep their exact legacy behaviour. */
export function isTargetAddress(search:string,targetViews:readonly string[]):boolean{
  const view=viewOfSearch(search);
  return requestsTargetRecord(search)&&view!==null&&targetViews.includes(view);
}
/** Choosing a view leaves an open target detail (one new history step) unless the
 * caller keeps the address (startup/restore, or pushing the target address itself). */
export function shouldLeaveTypedAddress(input:{
  enabled:boolean;keepAddress:boolean;search:string;targetViews:readonly string[];
}):boolean{
  return input.enabled&&!input.keepAddress&&isTargetAddress(input.search,input.targetViews);
}
/** The address effect keeps a target address while the shell shows its view. */
export function holdTypedAddress(input:{
  enabled:boolean;search:string;navigationView:string;targetViews:readonly string[];
}):boolean{
  return input.enabled&&isTargetAddress(input.search,input.targetViews)&&
    viewOfSearch(input.search)===input.navigationView;
}
export type DetailActivation=
  |{state:"none"}
  |{state:"unavailable"}
  |{state:"route";route:TargetDetailRoute};
/** Single decision for the shell: a detail (or its calm unavailable answer) exists
 * only for the target view that is actually on screen and named by the address. */
export function detailActivation(input:{
  search:string;gates:TargetDetailGates;
  /** The target view currently rendered (target Projects / Notes list, target My Plan), else null. */
  activeTargetView:TargetDetailView|null;
}):DetailActivation{
  if(input.activeTargetView===null)return {state:"none"};
  const request=detailRequestFromSearch(input.search,input.gates);
  if(request.state==="none"||viewOfSearch(input.search)!==input.activeTargetView)return {state:"none"};
  if(request.state==="unavailable")return {state:"unavailable"};
  return {state:"route",route:request.route};
}
