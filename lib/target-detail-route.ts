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
const typedKeys=["projectId","taskId","noteId"] as const;

/** True when the address asks for a typed record at all (valid or not). */
export function requestsTargetRecord(search:string):boolean{
  const params=new URLSearchParams(search);
  return typedKeys.some(key=>params.has(key));
}

/** Strict parse: only the route shapes the app itself generates are accepted. */
export function detailRouteFromSearch(search:string):TargetDetailRoute|null{
  const params=new URLSearchParams(searchWithoutScope(search));
  // A record address always names its view explicitly.
  if(!params.has("view"))return null;
  const target=targetFromSearch(search,KNOWN_VIEWS,START_VIEW);
  if(!target||target.kind==="view")return null;
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
  const base=searchForTarget(
    route.kind==="project"?{kind:"project",id:route.id}
      :{kind:route.kind,id:route.id,view:route.view,
        ...(route.projectId===undefined?{}:{projectId:route.projectId})},
    START_VIEW,KNOWN_VIEWS);
  return searchWithScope(base,scope);
}

/** Where "close" leads: a task in a project returns to the project, anything else to its list. */
export function parentSearchForDetail(route:TargetDetailRoute|null,scope:UrlScope):string{
  if(route?.kind==="task"&&route.view==="Projects"&&route.projectId!==undefined)
    return searchForDetail({kind:"project",id:route.projectId,view:"Projects"},scope);
  const view=route?.view??"Projects";
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

export type TargetDetailHistoryState={lumiTargetDetail:{scope:UrlScope}};
export function detailHistoryState(scope:UrlScope):TargetDetailHistoryState{
  return {lumiTargetDetail:{scope}};
}
/** True when the current history entry was pushed by opening a detail IN THIS TAB
 * under the same reading scope: only then may close step Back. */
export function canStepBack(state:unknown,search:string):boolean{
  if(state===null||typeof state!=="object")return false;
  const flag=(state as Partial<TargetDetailHistoryState>).lumiTargetDetail;
  return flag!==undefined&&flag!==null&&typeof flag==="object"&&flag.scope===scopeFromSearch(search);
}
