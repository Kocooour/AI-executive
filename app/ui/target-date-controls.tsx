"use client";
import {useState} from "react";
import {validMyPlanWhenDate} from "../../lib/target-staging-my-plan-when-client";

type DeadlineWarning={dueOn:string|null;message:string;confirm:string;cancel:string};
/** An explicit Save or Remove dispatches a date-only value. For a personal
 * date after the displayed deadline, a separate confirmation is required.
 * The parent keys the control by its authoritative snapshot (not the draft). */
export function TargetDateControls({value,label,save,remove,disabled=false,onChange,testId,actionContext,deadlineWarning}:{
  value:string|null;label:string;save:string;remove:string;disabled?:boolean;
  onChange:(value:string|null)=>void;testId?:string;actionContext?:string;
  deadlineWarning?:DeadlineWarning;
}){
  const [draft,setDraft]=useState(value??"");
  const [confirming,setConfirming]=useState(false);
  const valid=draft!==""&&validMyPlanWhenDate(draft)&&draft!==value;
  const afterDeadline=valid&&deadlineWarning?.dueOn!=null&&draft>deadlineWarning.dueOn;
  const actionName=(name:string)=>actionContext?name+": "+actionContext:name;
  return <div className="targetDateControls" role="group" aria-label={label}>
    <input type="date" aria-label={label} data-testid={testId}
      data-confirmed-date={value??""}
      value={draft} min="0001-01-01" max="9999-12-31" disabled={disabled}
      onChange={event=>{setDraft(event.currentTarget.value);setConfirming(false);}}/>
    <button type="button" aria-label={actionName(save)} disabled={disabled||!valid||confirming}
      onClick={()=>{if(valid){if(afterDeadline)setConfirming(true);else onChange(draft);}}}>{save}</button>
    {value!==null&&<button type="button" aria-label={actionName(remove)} disabled={disabled||confirming}
      onClick={()=>onChange(null)}>{remove}</button>}
    {confirming&&afterDeadline&&deadlineWarning&&<>
      <p role="alert">{deadlineWarning.message}</p>
      <button type="button" aria-label={actionName(deadlineWarning.confirm)} disabled={disabled}
        onClick={()=>{setConfirming(false);onChange(draft);}}>{deadlineWarning.confirm}</button>
      <button type="button" aria-label={actionName(deadlineWarning.cancel)} disabled={disabled}
        onClick={()=>setConfirming(false)}>{deadlineWarning.cancel}</button>
    </>}
  </div>;
}
