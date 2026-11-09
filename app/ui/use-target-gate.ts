"use client";
/** R3-FE-3: the same runtime gate + refusal budget the R3-FE-2 My Plan wrapper
 * uses, for screens that read target data through feature sessions. A read is
 * allowed only in the "ready" state, i.e. for a server-confirmed generation. */
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {targetMyPlanGate,type TargetMyPlanGate} from "../../lib/target-my-plan-embed";
import {refusalBudgetFor} from "../../lib/target-refusal-budget";

export function useTargetGate():{gate:TargetMyPlanGate;onRefusal:()=>void;retry:()=>void}{
  const runtime=useTargetRuntime();
  const generation=useTargetGeneration();
  const subscribeOutcome=useMemo(
    ()=>(notify:()=>void)=>runtime?runtime.subscribeOutcome(notify):()=>{},[runtime]);
  const outcome=useSyncExternalStore(
    subscribeOutcome,()=>runtime?runtime.lastOutcome():null,()=>null);
  const [blocked,setBlocked]=useState(false);
  const ownBump=useRef(false);
  // A generation change we did not cause (sign-in, account switch) lifts the block.
  useEffect(()=>{
    if(ownBump.current){ownBump.current=false;return;}
    setBlocked(false);
  },[generation]);
  const onRefusal=useCallback(()=>{
    if(!runtime)return;
    if(!refusalBudgetFor(runtime).admit()){setBlocked(true);return;}
    ownBump.current=true;
    void runtime.reportRefusal("session_revoked");
  },[runtime]);
  const retry=useCallback(()=>{
    refusalBudgetFor(runtime).reset();
    setBlocked(false);
    void runtime?.refresh();
  },[runtime]);
  return {gate:targetMyPlanGate(runtime,generation,outcome,blocked),onRefusal,retry};
}
