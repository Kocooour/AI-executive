/** R3-FE-1: framework-free, default-off target data client runtime.
 *
 * Owns ONE non-secret auth-generation per page load. Existing per-feature
 * sessions (attention, global index, ...) take `runtime.generation` as their
 * `contextVersion`; whenever the generation changes the runtime disposes every
 * registered session so features must recreate them. It also forwards page
 * lifecycle (hidden / pagehide / offline -> suspend, visible / pageshow /
 * online -> resume). resume() never fetches data. No persistence API is used and
 * nothing from a response other than the opaque generation is kept or logged. */
export type TargetRuntimeDisposable={
  dispose():void;suspend?():void;resume?():void;
};
export type TargetRuntimeRefreshResult="ok"|"signed_out"|"unavailable";
/** Last completed verification, for UI copy only (never an auth decision). */
export type TargetRuntimeOutcome=TargetRuntimeRefreshResult|"feature_off";
type Listener=(event?:unknown)=>void;
type EventTargetLike={
  addEventListener(type:string,listener:Listener):void;
  removeEventListener(type:string,listener:Listener):void;
};
export type TargetRuntimeWindow=EventTargetLike&{
  document?:EventTargetLike&{visibilityState?:string};
  navigator?:{onLine?:boolean};
};
export type TargetRuntimeChannel={
  addEventListener?:(type:"message",listener:(event:{data?:unknown})=>void)=>void;
  onmessage?:((event:{data?:unknown})=>void)|null;
  close():void;
};
export type TargetClientRuntimeConfig={
  fetch?:typeof fetch;
  window?:TargetRuntimeWindow|null;
  broadcastChannelFactory?:((name:string)=>TargetRuntimeChannel)|null;
  now?:()=>number;
  /** Injectable timers for the passive revalidation poll (tests). */
  timers?:{
    setInterval(fn:()=>void,ms:number):unknown;
    clearInterval(handle:unknown):void;
  };
};
export const TARGET_SESSION_ENDPOINT="/api/target-staging/session";
import {TARGET_SIGNED_IN_EVENT,TARGET_SIGNED_IN_MESSAGE} from "./target-auth-signal";
export const TARGET_SESSION_CHANNEL="ai-executive-session";
const GENERATION=/^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES=1024;
const TIMEOUT_MS=8000;
const FOCUS_THROTTLE_MS=1000;
/** Passive revalidation while visible and online: a revoked session or lost
 * membership must not leave titles on screen until the next focus event. One
 * request a minute stays far below the session route rate limit. */
export const TARGET_POLL_MS=60_000;

export function createTargetClientRuntime(config:TargetClientRuntimeConfig={}){
  const fetchImpl:typeof fetch=config.fetch??((input,init)=>fetch(input,init));
  const win:TargetRuntimeWindow|null=config.window===undefined
    ?(typeof window!=="undefined"?(window as unknown as TargetRuntimeWindow):null)
    :config.window;
  const now=config.now??Date.now;
  const timers=config.timers??{
    setInterval:(fn:()=>void,ms:number)=>{
      const handle=setInterval(fn,ms);
      // A background poll must never keep a process alive.
      (handle as {unref?:()=>void}|undefined)?.unref?.();
      return handle;
    },
    clearInterval:(handle:unknown)=>clearInterval(handle as ReturnType<typeof setInterval>),
  };
  let counter=0;
  const unknownToken=()=>{
    let random="";
    try{
      const bytes=new Uint8Array(12);
      globalThis.crypto.getRandomValues(bytes);
      random=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
    }catch{random=Math.random().toString(36).slice(2);}
    return "unknown-"+random+"-"+(++counter);
  };

  let value="";
  let unknownState=false;
  let disposed=false;
  let suspended=false;
  let pageHidden=false;
  let localBumps=0;
  let lastEventRefresh=-Infinity;
  let controller:AbortController|null=null;
  const subscribers=new Set<()=>void>();
  const outcomeSubscribers=new Set<()=>void>();
  let lastOutcome:TargetRuntimeOutcome|null=null;
  function outcome(next:TargetRuntimeOutcome):void{
    if(disposed||lastOutcome===next)return;
    lastOutcome=next;
    for(const fn of [...outcomeSubscribers])guarded(fn);
  }
  const registered=new Set<TargetRuntimeDisposable>();

  const guarded=(fn:()=>void)=>{try{fn();}catch{/* one feature must not break others */}};
  function disposeAll(){
    const all=[...registered];
    registered.clear();
    for(const item of all)guarded(()=>item.dispose());
  }
  function set(next:string,unknown:boolean){
    unknownState=unknown;
    if(next===value)return;
    value=next;
    disposeAll();
    for(const fn of [...subscribers])guarded(fn);
  }
  /** Any refusal or sign-out: an unrecoverable, never-reused value. */
  function bumpUnknown(){
    localBumps++;
    controller?.abort();
    if(unknownState&&value!=="")return;
    set(unknownToken(),true);
  }

  async function readGeneration(response:Response,signal:AbortSignal):Promise<string|null> {
    const type=response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if(response.redirected||type!=="application/json"||
      !(response.headers.get("cache-control")??"").split(",")
        .some(d=>d.trim().toLowerCase()==="no-store"))return null;
    let text="";
    if(response.body){
      const reader=response.body.getReader();
      const decoder=new TextDecoder("utf-8",{fatal:true});
      let bytes=0;
      try{
        for(;;){
          if(signal.aborted)return null;
          const chunk=await reader.read();
          if(chunk.done)break;
          bytes+=chunk.value.byteLength;
          if(bytes>MAX_BODY_BYTES)return null;
          text+=decoder.decode(chunk.value,{stream:true});
        }
        text+=decoder.decode();
      }finally{
        void reader.cancel().catch(()=>{});
        try{reader.releaseLock();}catch{/* already released */}
      }
    }else{
      text=await response.text();
      if(text.length>MAX_BODY_BYTES)return null;
    }
    let body:unknown;
    try{body=JSON.parse(text);}catch{return null;}
    if(!body||typeof body!=="object"||Array.isArray(body))return null;
    const keys=Object.keys(body);
    const generation=(body as {generation?:unknown}).generation;
    if(keys.length!==1||keys[0]!=="generation"||typeof generation!=="string"||
      !GENERATION.test(generation))return null;
    return generation;
  }

  async function run():Promise<TargetRuntimeRefreshResult> {
    const bumps=localBumps;
    const own=new AbortController();
    controller=own;
    const timer=setTimeout(()=>own.abort(),TIMEOUT_MS);
    try{
      const response=await fetchImpl(TARGET_SESSION_ENDPOINT,{
        method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
        headers:{accept:"application/json"},signal:own.signal,
      });
      // A sign-out/refusal observed meanwhile outranks this older answer.
      if(disposed||bumps!==localBumps||own.signal.aborted)return "unavailable";
      if(response.status===401||response.status===403){
        void response.body?.cancel().catch(()=>{});
        bumpUnknown();
        outcome("signed_out");
        return "signed_out";
      }
      if(response.status===404){
        // Feature switched off server-side: nothing may stay bound to old data.
        void response.body?.cancel().catch(()=>{});
        bumpUnknown();
        outcome("feature_off");
        return "unavailable";
      }
      if(response.status!==200){
        void response.body?.cancel().catch(()=>{});
        outcome("unavailable");
        return "unavailable";
      }
      const generation=await readGeneration(response,own.signal);
      if(disposed||bumps!==localBumps||own.signal.aborted)return "unavailable";
      if(generation===null){outcome("unavailable");return "unavailable";}
      set(generation,false);
      outcome("ok");
      return "ok";
    }catch{
      if(!disposed&&bumps===localBumps)outcome("unavailable"); // incl. timeout
      return "unavailable";
    }finally{
      clearTimeout(timer);
      if(controller===own)controller=null;
    }
  }

  let flight:Promise<TargetRuntimeRefreshResult>|null=null;
  let queued:Promise<TargetRuntimeRefreshResult>|null=null;
  function refresh():Promise<TargetRuntimeRefreshResult> {
    if(disposed)return Promise.resolve("unavailable");
    if(!flight){
      flight=run().finally(()=>{flight=null;});
      return flight;
    }
    // Coalesce: everything asked while one request runs shares ONE follow-up.
    queued??=flight.then(()=>{queued=null;return refresh();});
    return queued;
  }

  function suspendAll(){
    suspended=true;
    for(const item of [...registered])guarded(()=>item.suspend?.());
  }
  const active=()=>!disposed&&!pageHidden&&win?.document?.visibilityState!=="hidden"&&
    win?.navigator?.onLine!==false;
  function resumeAll(){
    if(!suspended||!active())return;
    suspended=false;
    for(const item of [...registered])guarded(()=>item.resume?.());
  }
  // Poll only while a window exists and the page is visible and online.
  let poll:unknown=null;
  function syncPoll(){
    const want=win!==null&&active();
    if(want&&poll===null){
      poll=timers.setInterval(()=>{
        if(active()){lastEventRefresh=now();void refresh();}
        else syncPoll();
      },TARGET_POLL_MS);
    }else if(!want&&poll!==null){
      timers.clearInterval(poll);
      poll=null;
    }
  }
  function throttledRefresh(){
    const t=now();
    if(t-lastEventRefresh<FOCUS_THROTTLE_MS)return;
    lastEventRefresh=t;
    void refresh();
  }

  const onVisibility=()=>{
    if(win?.document?.visibilityState==="hidden")suspendAll();
    else{resumeAll();throttledRefresh();}
    syncPoll();
  };
  const onPageShow=(event?:unknown)=>{
    pageHidden=false;
    resumeAll();
    syncPoll();
    // Always verify after BFCache restore; other pageshows are throttled.
    if((event as {persisted?:boolean}|undefined)?.persisted===true){
      lastEventRefresh=now();void refresh();
    }else throttledRefresh();
  };
  const onPageHide=()=>{pageHidden=true;suspendAll();syncPoll();};
  const onOffline=()=>{suspendAll();syncPoll();};
  const onOnline=()=>{resumeAll();syncPoll();lastEventRefresh=now();void refresh();};
  const onFocus=()=>throttledRefresh();
  // Sign-in completed without a reload (this tab or another): re-verify immediately, unthrottled.
  const onSignedIn=()=>{if(disposed)return;lastEventRefresh=now();void refresh();};
  const windowEvents:[string,Listener][]=[
    ["pageshow",onPageShow],["pagehide",onPageHide],["online",onOnline],
    ["offline",onOffline],["focus",onFocus],[TARGET_SIGNED_IN_EVENT,onSignedIn],
  ];
  if(win)for(const [name,fn] of windowEvents)win.addEventListener(name,fn);
  win?.document?.addEventListener("visibilitychange",onVisibility);

  let channel:TargetRuntimeChannel|null=null;
  const onMessage=(event:{data?:unknown})=>{
    if(disposed)return;
    if(event?.data==="signed-out")bumpUnknown();
    else if(event?.data===TARGET_SIGNED_IN_MESSAGE)onSignedIn();
  };
  try{
    const factory=config.broadcastChannelFactory===undefined
      ?(typeof BroadcastChannel!=="undefined"?
        (name:string)=>new BroadcastChannel(name) as unknown as TargetRuntimeChannel:null)
      :config.broadcastChannelFactory;
    channel=factory?factory(TARGET_SESSION_CHANNEL):null;
    if(channel){
      if(typeof channel.addEventListener==="function")channel.addEventListener("message",onMessage);
      else channel.onmessage=onMessage;
    }
  }catch{channel=null;}

  // Initial verification; sessions stay unusable until a value is known.
  lastEventRefresh=now();
  void refresh();
  syncPoll();

  return {
    generation():string{return value;},
    /** True only for a server-confirmed generation (not "" and not unknown-...). */
    known():boolean{return value!==""&&!unknownState&&!disposed;},
    refresh,
    subscribe(fn:()=>void):()=>void{
      subscribers.add(fn);
      return ()=>{subscribers.delete(fn);};
    },
    /** Last completed verification outcome (null before the first one). */
    lastOutcome():TargetRuntimeOutcome|null{return lastOutcome;},
    subscribeOutcome(fn:()=>void):()=>void{
      outcomeSubscribers.add(fn);
      return ()=>{outcomeSubscribers.delete(fn);};
    },
    register(item:TargetRuntimeDisposable):()=>void{
      if(disposed){guarded(()=>item.dispose());return ()=>{};}
      registered.add(item);
      if(suspended)guarded(()=>item.suspend?.());
      return ()=>{registered.delete(item);};
    },
    /** Features call this on 401 / session_revoked from any target request. */
    reportRefusal(_kind:"unauthorized"|"session_revoked"|string="unauthorized"):Promise<TargetRuntimeRefreshResult>{
      if(disposed)return Promise.resolve("unavailable");
      bumpUnknown();
      return refresh();
    },
    dispose():void{
      if(disposed)return;
      disposed=true;
      syncPoll(); // active() is false once disposed: the interval is cleared
      controller?.abort();
      windowEvents.forEach(([name,fn])=>win?.removeEventListener?.(name,fn));
      win?.document?.removeEventListener("visibilitychange",onVisibility);
      if(channel){
        if(typeof channel.addEventListener!=="function")channel.onmessage=null;
        guarded(()=>channel?.close());
        channel=null;
      }
      disposeAll();
      subscribers.clear();
      outcomeSubscribers.clear();
    },
  };
}
export type TargetClientRuntime=ReturnType<typeof createTargetClientRuntime>;
