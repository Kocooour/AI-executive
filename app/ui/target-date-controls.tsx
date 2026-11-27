"use client";
import {useState} from "react";
import {validMyPlanWhenDate} from "../../lib/target-staging-my-plan-when-client";

/** No mutation while the native picker is being edited: an explicit Save or
 * Remove dispatches a date-only value through the caller's existing controller. */
export function TargetDateControls({value,label,save,remove,disabled=false,onChange,testId}:{
  value:string|null;label:string;save:string;remove:string;disabled?:boolean;
  onChange:(value:string|null)=>void;testId?:string;
}){
  const [draft,setDraft]=useState(value??"");
  const valid=draft!==""&&validMyPlanWhenDate(draft)&&draft!==value;
  return <div className="targetDateControls">
    <input type="date" aria-label={label} data-testid={testId}
      value={draft} min="0001-01-01" max="9999-12-31" disabled={disabled}
      onChange={event=>setDraft(event.currentTarget.value)}/>
    <button type="button" disabled={disabled||!valid}
      onClick={()=>{if(valid)onChange(draft);}}>{save}</button>
    {value!==null&&<button type="button" disabled={disabled}
      onClick={()=>onChange(null)}>{remove}</button>}
  </div>;
}
