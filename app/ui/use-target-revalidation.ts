"use client";
/** R3-FE-4a: shared revalidation hooks for target screens.
 *  - useTargetTick: the runtime's 60 s passive poll (visible + online only, after a
 *    successful session re-verification). Membership loss does not change the auth
 *    generation, so screens re-read on this tick instead of waiting for a new one.
 *  - useTargetWake: hidden / offline / BFCache hide the content at once; on return it
 *    first waits for the runtime's FRESH verification and only then lets the screen
 *    read again (one automatic retry if the network is not ready yet), instead of
 *    racing the runtime refresh with an immediate read. */
import {useEffect,useMemo,useRef} from "react";
import {useTargetRuntime} from "./target-data-provider";

export function useTargetTick(tick:()=>void):void{
  const runtime=useTargetRuntime();
  const ref=useRef(tick);
  ref.current=tick;
  useEffect(()=>{
    if(!runtime)return;
    return runtime.subscribeTick(()=>{
      if(document.visibilityState==="hidden"||!navigator.onLine)return;
      ref.current();
    });
  },[runtime]);
}

export function useTargetWake(handlers:{
  hide:(reason:"hidden"|"offline")=>void;
  /** The runtime re-verified: the screen may read again. */
  ready:()=>void;
  /** The runtime could not re-verify (twice): show the retryable state. */
  failed:()=>void;
}):{markHidden:()=>void}{
  const runtime=useTargetRuntime();
  const ref=useRef(handlers);
  ref.current=handlers;
  const hidden=useRef(false);
  const epoch=useRef(0);
  const markHidden=useMemo(()=>()=>{hidden.current=true;},[]);
  useEffect(()=>{
    let alive=true;
    const hide=(reason:"hidden"|"offline")=>{
      hidden.current=true;
      epoch.current++;
      ref.current.hide(reason);
    };
    const wake=()=>{
      if(!hidden.current||document.visibilityState==="hidden"||!navigator.onLine)return;
      hidden.current=false;
      const id=++epoch.current;
      const verify=async(attempt:number):Promise<void>=>{
        if(!runtime){ref.current.failed();return;}
        const result=await runtime.refresh();
        if(!alive||epoch.current!==id)return;
        if(result==="ok"){ref.current.ready();return;}
        if(result==="unavailable"&&attempt===0){
          await new Promise(resolve=>setTimeout(resolve,1500));
          if(!alive||epoch.current!==id)return;
          return verify(1);
        }
        // signed_out: the gate/generation handling takes over; unavailable twice: retryable.
        if(result==="unavailable")ref.current.failed();
      };
      void verify(0);
    };
    const visibility=()=>document.visibilityState==="hidden"?hide("hidden"):wake();
    const offline=()=>hide("offline");
    const pagehide=()=>hide("hidden");
    const pageshow=(event:PageTransitionEvent)=>{if(event.persisted)hidden.current=true;wake();};
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("offline",offline);
    window.addEventListener("online",wake);
    window.addEventListener("pagehide",pagehide);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("focus",wake);
    return ()=>{
      alive=false;
      epoch.current++;
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("offline",offline);
      window.removeEventListener("online",wake);
      window.removeEventListener("pagehide",pagehide);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("focus",wake);
    };
  },[runtime]);
  return {markHidden};
}
