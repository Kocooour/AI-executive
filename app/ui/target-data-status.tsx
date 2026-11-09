"use client";
/** R3-FE-1: renders one entry of the target client error taxonomy.
 * Info (uncertain) is a polite status; every other kind is an alert. */
import {
  mapTargetClientFailure,targetClientActionLabelsFor,type TargetClientLanguage,
  type TargetClientError,type TargetClientErrorAction,type TargetClientFailureInput,
} from "../../lib/target-client-errors";

export function TargetDataStatus({failure,error,onAction,language="cs"}:{
  language?:TargetClientLanguage;
  failure?:TargetClientFailureInput;
  error?:TargetClientError;
  onAction?:(action:Exclude<TargetClientErrorAction,"none">)=>void;
}){
  const mapped=error??(failure===undefined?null:mapTargetClientFailure(failure,language));
  if(!mapped)return null;
  const label=mapped.action==="none"?null:targetClientActionLabelsFor(language)[mapped.action];
  return (
    <div className="targetDataStatus" data-kind={mapped.kind}
      role={mapped.kind==="uncertain"?"status":"alert"}>
      <p>{mapped.message}</p>
      {label&&onAction&&mapped.action!=="none"&&(
        <button type="button" onClick={()=>onAction(mapped.action as Exclude<TargetClientErrorAction,"none">)}>
          {label}
        </button>
      )}
    </div>
  );
}
