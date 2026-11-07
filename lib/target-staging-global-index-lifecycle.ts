/** UI-09a: privacy wake gate for global Vše staging preview.
 * A hidden/offline/pagehide transition must defeat focus coalescing. */
export type GlobalIndexWakeGate={lastWakeAt:number;requiresReauthorization:boolean};
export const initialGlobalIndexWakeGate=():GlobalIndexWakeGate=>({
  lastWakeAt:0,requiresReauthorization:false,
});
export function invalidateGlobalIndexWakeGate(gate:GlobalIndexWakeGate):GlobalIndexWakeGate{
  return {...gate,requiresReauthorization:true};
}
export function consumeGlobalIndexWake(gate:GlobalIndexWakeGate,now:number,force=false):{
  reload:boolean;gate:GlobalIndexWakeGate;
}{
  const reload=force||gate.requiresReauthorization||
    !Number.isFinite(now)||now<gate.lastWakeAt||now-gate.lastWakeAt>=350;
  return {reload,gate:reload
    ?{lastWakeAt:now,requiresReauthorization:false}:gate};
}
