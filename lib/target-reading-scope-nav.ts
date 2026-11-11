/** Shared, UI-only reading-scope navigation. This changes a server query filter,
 * NEVER write permissions or identity. The inert helper is safe to import in
 * the default-off app shell; only an explicit navigation calls it. */
import {withoutDetailMarker} from "./target-detail-route";
import {defaultUrlScope,scopeFromSearch,searchWithScope,type UrlScope} from "./view-url";

export const TARGET_SCOPE_CHANGED="lumi-target-scope-changed";
export function writeTargetReadingScope(next:UrlScope):boolean{
  if(scopeFromSearch(window.location.search)===next)return true;
  try{
    window.history.pushState(withoutDetailMarker(window.history.state),"",
      `${window.location.pathname}${searchWithScope(window.location.search,next)}${window.location.hash}`);
  }catch{return false;}
  window.dispatchEvent(new Event(TARGET_SCOPE_CHANGED));
  return true;
}
