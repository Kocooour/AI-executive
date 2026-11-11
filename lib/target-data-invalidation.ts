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
