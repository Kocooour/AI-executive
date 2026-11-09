"use client";
/** R3-FE-2: the server-authorized personal My Plan inside the main app.
 * Loaded lazily by the app root ONLY when the server page enabled it, so with
 * the flags off this module (and its CSS) is never fetched or executed.
 *
 * The plan is keyed by the runtime generation: any generation change
 * (sign-out broadcast, account switch, revocation, same-tab sign-in) unmounts
 * it, which drops every rendered task, pending command reference and Undo.
 * Nothing is read until the runtime holds a server-confirmed generation, and
 * nothing is persisted. */
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {TargetDataStatus} from "./target-data-status";
import {useTargetScope} from "./target-scope-state";
import {TargetStagingMyPlanPreview} from "./target-staging-my-plan-preview";
import {openTargetDetail} from "./target-detail-state";
import {detailCopy} from "../../lib/target-detail-copy";
import {myPlanCopy,type MyPlanLanguage} from "../../lib/target-my-plan-copy";
import {createRefusalBudget,targetMyPlanGate} from "../../lib/target-my-plan-embed";
import "../target-staging/my-plan/preview/preview.css";
import "./target-my-plan.css";
import "./target-details.css";

export default function TargetMyPlan({gates,language="cs",scopeDriven=false,taskDetail=false}:{
  gates:{statusWrite:boolean;whenWrite:boolean};
  /** R3-FE-4a: task titles open the authorized task detail in the main app. */
  taskDetail?:boolean;
  /** R3-FE-3: the global All / Personal / Shared scope drives the plan's area filter. */
  scopeDriven?:boolean;
  /** R3-FE-2b: follows the app language; Czech by default. */
  language?:MyPlanLanguage;
}){
  const copy=myPlanCopy[language];
  const scope=useTargetScope();
  const runtime=useTargetRuntime();
  const generation=useTargetGeneration();
  const subscribeOutcome=useMemo(
    ()=>(notify:()=>void)=>runtime?runtime.subscribeOutcome(notify):()=>{},[runtime]);
  const outcome=useSyncExternalStore(
    subscribeOutcome,()=>runtime?runtime.lastOutcome():null,()=>null);
  const budget=useRef(createRefusalBudget());
  const [blocked,setBlocked]=useState(false);
  const ownBump=useRef(false);
  // A generation change we did not cause (sign-in, account switch) lifts the block.
  useEffect(()=>{
    if(ownBump.current){ownBump.current=false;return;}
    setBlocked(false);
  },[generation]);
  const onRefusal=useCallback(()=>{
    if(!runtime)return;
    if(!budget.current.admit()){setBlocked(true);return;}
    ownBump.current=true;
    void runtime.reportRefusal("session_revoked");
  },[runtime]);
  const retry=useCallback(()=>{
    budget.current.reset();
    setBlocked(false);
    void runtime?.refresh();
  },[runtime]);
  const gate=targetMyPlanGate(runtime,generation,outcome,blocked);
  if(gate.kind==="checking")
    return <div className="targetMyPlanGate" data-testid="target-my-plan-checking">
      <p role="status">{copy.gateChecking}</p>
    </div>;
  if(gate.kind==="feature_off")
    return <div className="targetMyPlanGate" data-testid="target-my-plan-feature-off">
      <TargetDataStatus error={{kind:"unavailable",action:"retry_later",
        message:copy.gateFeatureOff}}
        language={language} onAction={retry}/>
    </div>;
  if(gate.kind==="unavailable")
    return <div className="targetMyPlanGate" data-testid="target-my-plan-unavailable">
      <TargetDataStatus failure="unavailable" language={language} onAction={retry}/>
    </div>;
  if(gate.kind==="signed_out"||gate.kind==="refused")
    return <div className="targetMyPlanGate" data-testid={`target-my-plan-${gate.kind==="refused"?"refused":"signed-out"}`}>
      <TargetDataStatus error={gate.kind==="refused"?{kind:"signed_out",action:"verify",
        message:copy.gateRefused}:undefined}
        language={language}
        failure={gate.kind==="signed_out"?"signed-out":undefined}
        // Re-verify instead of reloading: if the session really ended, the app's
        // own sign-in screen takes over; a valid session shows the plan again.
        onAction={retry}/>
    </div>;
  return <TargetStagingMyPlanPreview key={gate.generation} embedded language={language}
    statusWriteEnabled={gates.statusWrite} whenWriteEnabled={gates.whenWrite}
    onRefusal={onRefusal} areaFilter={scopeDriven?scope:undefined}
    onOpenTask={taskDetail?(id,opener)=>openTargetDetail({kind:"task",id,view:"MyPlanPreview"},opener):undefined}
    openTaskLabel={detailCopy[language].planOpenTask}/>;
}
