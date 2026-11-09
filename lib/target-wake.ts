/** R3-FE-4a: hide / wake state machine of a target screen (detail, sidebar list).
 * Pure: the runtime refresh, the page state and the timer are injected, so the real
 * event order (offline -> online -> runtime refresh -> read -> tick) is tested.
 *
 *  - hide(): content is removed at once (hidden tab, pagehide, offline, BFCache).
 *  - wake(): only after a hide and only when visible AND online. It waits for the
 *    runtime's FRESH verification (the runtime has already resumed its sessions and
 *    started that refresh on the same event), but it NEVER gives up before reading:
 *    unless the session ended (signed_out), the screen reads again whatever the
 *    refresh said - the read itself reports its specific error. A failed read right
 *    after a wake (network not ready yet) is retried automatically with a bounded
 *    back-off (wakeRetryDelay) instead of stopping on a manual "try again". */
export type WakeRefreshResult="ok"|"signed_out"|"unavailable";
export type WakeHandlers={
  hide(reason:"hidden"|"offline"):void;
  /** The screen may read again (resume the session, bump the read). */
  ready():void;
  /** The session ended: show the signed-out state, do not stay hidden. */
  signedOut():void;
};

/** Delay before an automatic re-read after a wake-triggered read failed; null = stop. */
export function wakeRetryDelay(reason:string,attempt:number):number|null{
  if(reason!=="offline"&&reason!=="unavailable")return null;
  return [1500,4000][attempt]??null;
}

export function createWakeMachine(deps:{
  refresh:()=>Promise<WakeRefreshResult>;
  visible:()=>boolean;
  online:()=>boolean;
  handlers:()=>WakeHandlers;
}){
  let hidden=false;
  let epoch=0;
  let disposed=false;
  return {
    /** The screen starts (or finds itself) hidden/offline. */
    markHidden():void{hidden=true;},
    hide(reason:"hidden"|"offline"):void{
      if(disposed)return;
      hidden=true;
      epoch++;
      deps.handlers().hide(reason);
    },
    async wake(force=false):Promise<void>{
      if(disposed||(!hidden&&!force)||!deps.visible()||!deps.online())return;
      hidden=false;
      const id=++epoch;
      let result:WakeRefreshResult;
      try{result=await deps.refresh();}catch{result="unavailable";}
      if(disposed||epoch!==id)return;
      if(result==="signed_out")deps.handlers().signedOut();
      else deps.handlers().ready();
    },
    dispose():void{disposed=true;epoch++;},
  };
}
