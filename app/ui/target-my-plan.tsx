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
import {useCallback} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {TargetDataStatus} from "./target-data-status";
import {TargetStagingMyPlanPreview} from "./target-staging-my-plan-preview";
import {targetMyPlanGate} from "../../lib/target-my-plan-embed";
import "../target-staging/my-plan/preview/preview.css";
import "./target-my-plan.css";

export default function TargetMyPlan({gates}:{
  gates:{statusWrite:boolean;whenWrite:boolean};
}){
  const runtime=useTargetRuntime();
  const generation=useTargetGeneration();
  const gate=targetMyPlanGate(runtime,generation);
  const onRefusal=useCallback(()=>{void runtime?.reportRefusal("session_revoked");},[runtime]);
  if(gate.kind==="checking")
    return <div className="targetMyPlanGate" data-testid="target-my-plan-checking">
      <p role="status">Ověřuji přihlášení k serverovému plánu…</p>
      {runtime&&<button type="button" onClick={()=>{void runtime.refresh();}}>Zkusit znovu</button>}
    </div>;
  if(gate.kind==="signed_out")
    return <div className="targetMyPlanGate" data-testid="target-my-plan-signed-out">
      <TargetDataStatus failure="signed-out" onAction={action=>{
        if(action==="sign_in")window.location.reload();
        else void runtime?.refresh();
      }}/>
    </div>;
  return <TargetStagingMyPlanPreview key={gate.generation} embedded
    statusWriteEnabled={gates.statusWrite} whenWriteEnabled={gates.whenWrite}
    onRefusal={onRefusal}/>;
}
