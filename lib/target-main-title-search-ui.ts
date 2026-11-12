/** R3-FE-05: default-off main-app title search, gated separately from read ACL.
 * No client flag, URL scope or UI state grants visibility: only the server does. */
// Client-safe flags only: importing the server config would bundle node:crypto.
import type {TitleSearchFailure,TitleSearchScope,TitleSearchItem} from "./target-staging-title-search-client";
import {detailIdOk,type TargetDetailGates,type TargetDetailRoute,type TargetDetailView} from "./target-detail-route";
import type {TitleSearchSessionSnapshot} from "./target-staging-title-search-session";

/** Topbar Enter is a deliberate submit, not a fetch-on-keystroke. */
export const TARGET_MAIN_SEARCH_SUBMIT_EVENT="lumi-target-main-search-submit";
export const TARGET_MAIN_TITLE_SEARCH_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_SCOPES_ENABLED",
  "AI_EXECUTIVE_TARGET_UI_TITLE_SEARCH_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED",
] as const;

export function targetMainTitleSearchEnabled(env:Record<string,string|undefined>):boolean{
  return TARGET_MAIN_TITLE_SEARCH_FLAGS.every(name=>env[name]==="true");
}

/** An authorized Search view must not mount either legacy IndexedDB task rows
 * or local held-back titles. With the feature off, legacy Search is unchanged;
 * other screens keep their existing legacy fallback behaviour. */
export function mainTitleSearchLegacySurfaces(targetSearch:boolean,view:string):{
  heldBack:boolean;entityList:boolean;
}{
  const showLegacy=!(targetSearch&&view==="Search");
  return {heldBack:showLegacy,entityList:showLegacy};
}

/** A successful runtime revalidation can follow ACL revocation with exactly
 * the SAME login generation. Unsuccessful revalidation also makes previously
 * disclosed titles untrustworthy: purge on EITHER a verified tick or a failed
 * outcome, aborting pending reads without automatically searching again. */
export function subscribeMainTitleSearchAclInvalidation(
  runtime:{
    subscribeTick(listener:()=>void):()=>void;
    subscribeOutcome(listener:()=>void):()=>void;
    lastOutcome():string|null;
  }|null,
  invalidate:()=>void,
):()=>void {
  if(!runtime)return ()=>{};
  const stopTick=runtime.subscribeTick(invalidate);
  const stopOutcome=runtime.subscribeOutcome(()=>{
    if(runtime.lastOutcome()!=="ok")invalidate();
  });
  return ()=>{stopTick();stopOutcome();};
}

export type MainTitleSearchBinding={
  input:string;scope:TitleSearchScope;generation:string;
};
export type BoundMainTitleSearch={
  binding:MainTitleSearchBinding;
  snapshot:TitleSearchSessionSnapshot;
  failure:TitleSearchFailure|null;
};
/** A change of raw query, global scope or auth generation hides titles immediately,
 * even before the session-reset effect runs or a stale network promise settles. */
export function visibleMainTitleSearchResult(
  value:BoundMainTitleSearch|null,current:MainTitleSearchBinding,authorized:boolean,
):BoundMainTitleSearch|null{
  if(!authorized||!value||!current.generation||
    value.binding.input!==current.input||
    value.binding.scope!==current.scope||
    value.binding.generation!==current.generation)return null;
  const snapshot=value.snapshot;
  if(snapshot.status==="ready"&&(snapshot.query!==current.input.trim()||
    snapshot.scope!==current.scope))return null;
  return value;
}

export type MainTitleSearchLanguage="cs"|"en";
const failures:Record<MainTitleSearchLanguage,Record<TitleSearchFailure,string>>={
  cs:{
    "invalid-request":"Zadejte 2–80 znaků, nejvýše osm slov.",
    "signed-out":"Přístup již neplatí. Výsledky byly skryty.",
    "stale":"Výsledky už nejsou aktuální. Spusťte nové hledání.",
    "disabled":"Autorizované hledání není dostupné.",
    "rate-limited":"Příliš mnoho dotazů. Zkuste to později.",
    "unavailable":"Hledání se nepodařilo. Zkuste to znovu.",
    "offline":"Bez připojení nelze hledat. Výsledky byly skryty.",
    "aborted":"Hledání bylo přerušeno.",
    "invalid-response":"Odpověď nebyla ověřena. Výsledky byly skryty.",
  },
  en:{
    "invalid-request":"Enter 2–80 characters, at most eight words.",
    "signed-out":"Access is no longer valid. Results were hidden.",
    "stale":"Results are out of date. Search again.",
    "disabled":"Authorized search is not available.",
    "rate-limited":"Too many searches. Try again later.",
    "unavailable":"Search failed. Try again.",
    "offline":"Search requires a connection. Results were hidden.",
    "aborted":"Search was interrupted.",
    "invalid-response":"The response could not be verified. Results were hidden.",
  },
};
export const mainTitleSearchCopy={
  cs:{
    intro:"Hledání pouze v názvech aktuálně přístupných projektů, úkolů a poznámek. Vše není Můj plán.",
    instruction:"Napište dotaz do pole Hledání v horní liště a spusťte ho tlačítkem.",
    submit:"Vyhledat",loading:"Ověřuji přístupné výsledky…",
    idle:"Zadejte dotaz a spusťte hledání. Výsledky se nenačítají při psaní.",
    count:(n:number)=>"Zobrazeno "+n+" oprávněných výsledků.",
    empty:"Žádné přístupné názvy neodpovídají dotazu.",
    more:"Načíst další",cap:"Dosažen limit zobrazených výsledků. Upřesněte dotaz.",
    privacy:"Poznámky zobrazují jen název, nikdy text. Výsledky se nikam neukládají.",
    verifying:"Ověřuji přihlášení…",unavailable:"Hledání není nyní dostupné.",
    retry:"Ověřit přístup",offline:"Bez připojení jsou výsledky skryté.",
    project:"Projekt",task:"Úkol",note:"Poznámka",personal:"Osobní",shared:"Sdílené",
    failures:failures.cs,
  },
  en:{
    intro:"Search titles of currently accessible projects, tasks and notes. All is not My Plan.",
    instruction:"Type in the search field at the top, then start the search with the button.",
    submit:"Search",loading:"Verifying accessible results…",
    idle:"Enter a query and start searching. Typing does not send requests.",
    count:(n:number)=>"Showing "+n+" authorized results.",
    empty:"No accessible titles match your query.",
    more:"Load more",cap:"Result limit reached. Refine your query.",
    privacy:"Only note titles are shown, never their text. Results are not stored.",
    verifying:"Verifying sign-in…",unavailable:"Search is currently unavailable.",
    retry:"Check access again",offline:"Results are hidden while offline.",
    project:"Project",task:"Task",note:"Note",personal:"Personal",shared:"Shared",
    failures:failures.en,
  },
} as const;

/** Open only kinds whose existing detail UI is enabled. Invalid legacy IDs
 * remain text, as in Projects/Notes/My Plan. Server re-authorizes on open. */
export function mainTitleSearchDetailRoute(
  item:TitleSearchItem,gates:TargetDetailGates,views:readonly TargetDetailView[],
):TargetDetailRoute|null{
  if(!gates[item.kind]||!detailIdOk(item.id))return null;
  if(item.kind==="project")return views.includes("Projects")
    ?{kind:"project",id:item.id,view:"Projects"}:null;
  if(item.kind==="note")return views.includes("Notes")
    ?{kind:"note",id:item.id,view:"Notes"}:null;
  // My Plan supports both standalone and project tasks, including undated ones.
  if(views.includes("MyPlanPreview"))return {kind:"task",id:item.id,view:"MyPlanPreview"};
  // If My Plan is off, a project task may still open in the authorized Projects
  // detail; a standalone task has no valid Projects address and stays text.
  if(views.includes("Projects")&&detailIdOk(item.projectId))
    return {kind:"task",id:item.id,view:"Projects",projectId:item.projectId};
  return null;
}

// A single-use, in-memory return bridge: the Search component unmounts while
// the existing details UI navigates to Projects/Notes/My Plan. No web storage,
// auto-query or speculative prefetch. A revalidation (including same-login
// ACL changes), hidden tab, blur, offline or pagehide invalidates the bridge.
type SearchRuntime=NonNullable<Parameters<typeof subscribeMainTitleSearchAclInvalidation>[0]>;
let returnBridge:{result:BoundMainTitleSearch;expires:number;stop:()=>void}|null=null;
export function clearMainTitleSearchReturn():void{
  const held=returnBridge;
  returnBridge=null;
  held?.stop();
}
export function rememberMainTitleSearchReturn(
  result:BoundMainTitleSearch,binding:MainTitleSearchBinding,runtime:SearchRuntime|null,
):void{
  clearMainTitleSearchReturn();
  if(typeof window==="undefined"||typeof document==="undefined"||!runtime||
    runtime.lastOutcome()!=="ok"||document.visibilityState==="hidden"||
    !navigator.onLine||!visibleMainTitleSearchResult(result,binding,true)||
    result.snapshot.status!=="ready")return;
  const invalidate=()=>clearMainTitleSearchReturn();
  const onVisibility=()=>{if(document.visibilityState==="hidden")invalidate();};
  const stopAcl=subscribeMainTitleSearchAclInvalidation(runtime,invalidate);
  window.addEventListener("pagehide",invalidate);
  window.addEventListener("blur",invalidate);
  window.addEventListener("offline",invalidate);
  document.addEventListener("visibilitychange",onVisibility);
  returnBridge={
    result:{...result,binding:{...binding},
      snapshot:{...result.snapshot,items:result.snapshot.items.map(item=>({...item}))}},
    expires:Date.now()+120000,
    stop:()=>{
      stopAcl();
      window.removeEventListener("pagehide",invalidate);
      window.removeEventListener("blur",invalidate);
      window.removeEventListener("offline",invalidate);
      document.removeEventListener("visibilitychange",onVisibility);
    },
  };
}
export function consumeMainTitleSearchReturn(
  binding:MainTitleSearchBinding,runtime:SearchRuntime|null,
):BoundMainTitleSearch|null{
  const held=returnBridge;
  const valid=held!==null&&Date.now()<held.expires&&runtime?.lastOutcome()==="ok"&&
    typeof document!=="undefined"&&document.visibilityState!=="hidden"&&
    typeof navigator!=="undefined"&&navigator.onLine&&
    visibleMainTitleSearchResult(held.result,binding,true)!==null;
  clearMainTitleSearchReturn();
  return valid&&held?held.result:null;
}
