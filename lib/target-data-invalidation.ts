/** R3-FE-4b: in-memory change notice. After a committed edit/delete in the detail panel the
 * screens that show this item (scope lists, sidebar projects, My Plan rows) re-read through
 * the shared read queue. The notice carries only the kind and opaque ID; it is never
 * persisted, never leaves the page, and a subscriber decides if and when to re-read. */
export type TargetChange={kind:"task"|"note";id:string;change:"updated"|"deleted"};
const listeners=new Set<(change:TargetChange)=>void>();

export function subscribeTargetChange(listener:(change:TargetChange)=>void):()=>void{
  listeners.add(listener);
  return ()=>{listeners.delete(listener);};
}
export function emitTargetChange(change:TargetChange):void{
  for(const listener of [...listeners]){
    try{listener(change);}catch{/* one broken subscriber must not stop the others */}
  }
}
/** Test only. */
export const targetChangeListenerCount=():number=>listeners.size;

/** In-memory only: a write with unknown outcome suppresses all actor-scoped
 * Inbox badges until its ORIGINAL command receipt has been reconciled.
 * Generation scopes the suppression; a new signed-in actor cannot inherit it. */
const inboxUncertainListeners=new Set<()=>void>();
let inboxUncertainGeneration="";
export function subscribeInboxUncertain(listener:()=>void):()=>void{
  inboxUncertainListeners.add(listener);
  return ()=>inboxUncertainListeners.delete(listener);
}
export const inboxUncertainSnapshot=():string=>inboxUncertainGeneration;
export function setInboxUncertain(generation:string|null):void{
  const next=generation??"";
  if(inboxUncertainGeneration===next)return;
  inboxUncertainGeneration=next;
  for(const fn of [...inboxUncertainListeners]){try{fn();}catch{/*no blocked peers*/}}
}
