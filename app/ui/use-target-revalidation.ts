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
import {createWakeMachine} from "../../lib/target-wake";

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
  /** The runtime re-verified (or could not): the screen may read again. */
  ready:()=>void;
  /** The session ended: show the signed-out state instead of staying hidden. */
  signedOut:()=>void;
}):{markHidden:()=>void}{
  const runtime=useTargetRuntime();
  const ref=useRef(handlers);
  ref.current=handlers;
  const machine=useRef<ReturnType<typeof createWakeMachine>|null>(null);
  const markHidden=useMemo(()=>()=>{machine.current?.markHidden();},[]);
  useEffect(()=>{
    const wake=createWakeMachine({
      refresh:()=>runtime?runtime.refresh():Promise.resolve("unavailable" as const),
      visible:()=>document.visibilityState!=="hidden",
      online:()=>navigator.onLine,
      handlers:()=>ref.current,
    });
    machine.current=wake;
    const onWake=()=>{void wake.wake();};
    const visibility=()=>document.visibilityState==="hidden"?wake.hide("hidden"):onWake();
    const offline=()=>wake.hide("offline");
    const pagehide=()=>wake.hide("hidden");
    const pageshow=(event:PageTransitionEvent)=>{if(event.persisted)wake.markHidden();onWake();};
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("offline",offline);
    window.addEventListener("online",onWake);
    window.addEventListener("pagehide",pagehide);
    window.addEventListener("pageshow",pageshow);
    window.addEventListener("focus",onWake);
    return ()=>{
      wake.dispose();
      machine.current=null;
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("offline",offline);
      window.removeEventListener("online",onWake);
      window.removeEventListener("pagehide",pagehide);
      window.removeEventListener("pageshow",pageshow);
      window.removeEventListener("focus",onWake);
    };
  },[runtime]);
  return {markHidden};
}
