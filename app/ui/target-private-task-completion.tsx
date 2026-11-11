"use client";
/** R3-FE: one always-mounted, default-off completion delivery point.
 * A POST acknowledgement can outlive its capture modal. This bridge carries
 * no title, task ID, Area or credential and never trusts sessionStorage alone.
 * Delivery happens exactly once after a fresh authenticated visible read. */
import {useEffect,useRef} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {useTargetTick,useTargetWake} from "./use-target-revalidation";
import {
  hasPrivateTaskCreateCompletion,consumePrivateTaskCreateCompletion,
  subscribePrivateTaskCreateCompletion,
} from "../../lib/target-private-task-create-coordinator";

export default function TargetPrivateTaskCompletion({
  onCreated,onReset,
}:{onCreated:()=>void;onReset:()=>void}){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const callbacks=useRef({onCreated,onReset});
  callbacks.current={onCreated,onReset};
  const alive=useRef(false),busy=useRef(false),epoch=useRef(0);
  const checkRef=useRef<()=>void>(()=>{});
  const previous=useRef(generation);
  checkRef.current=()=>{
    if(!runtime||busy.current||!alive.current||
      !hasPrivateTaskCreateCompletion(runtime,generation)||
      document.visibilityState!=="visible"||!navigator.onLine)return;
    busy.current=true;
    const currentEpoch=epoch.current;
    // A stale identity snapshot is never enough to navigate or reveal
    // another actor's task after a frozen/hidden tab resumes.
    void runtime.refresh().then(result=>{
      if(!alive.current||currentEpoch!==epoch.current||result!=="ok"||
        !runtime.known()||runtime.generation()!==generation||
        document.visibilityState!=="visible"||!navigator.onLine)return;
      if(consumePrivateTaskCreateCompletion(runtime,generation))
        callbacks.current.onCreated();
    }).catch(()=>{/* retain receipt for a later authenticated wake */})
      .finally(()=>{busy.current=false;});
  };
  useEffect(()=>{
    epoch.current++;
    alive.current=true;
    if(previous.current!==generation){
      previous.current=generation;
      callbacks.current.onReset();
    }
    if(!runtime)return ()=>{
      alive.current=false;epoch.current++;
    };
    const unsub=subscribePrivateTaskCreateCompletion(runtime,()=>checkRef.current());
    checkRef.current(); // completion may predate the bridge's first mount
    return ()=>{alive.current=false;epoch.current++;unsub();};
  },[runtime,generation]);
  useTargetTick(()=>checkRef.current());
  useTargetWake({
    hide:()=>{},
    ready:()=>checkRef.current(),
    signedOut:()=>callbacks.current.onReset(),
  });
  return null;
}
