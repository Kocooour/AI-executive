"use client";
import {useEffect,useState} from "react";
import {displayedDateDraft,initialDateDraft,reconcileDateDraft,type DateDraft,type DateDraftContext,type DateDraftRecord} from "../../lib/target-date-draft";
import {validMyPlanWhenDate} from "../../lib/target-staging-my-plan-when-client";

/** Called by the detail edit owner, not the temporarily unmounted controls. */
export function useRetainedDateDraft(context:DateDraftContext){
  const [record,setRecord]=useState<DateDraftRecord|null>(null);
  const {identity,snapshot,value,allowed}=context;
  useEffect(()=>{
    setRecord(old=>reconcileDateDraft(old,{identity,snapshot,value,allowed}));
  },[identity,snapshot,value,allowed]);
  const current=reconcileDateDraft(record,context);
  return {
    draft:displayedDateDraft(record,context),
    setDraft:(draft:DateDraft)=>setRecord(allowed===true?{identity,snapshot,draft,resetNotice:false}:null),
    clear:()=>setRecord(null),
    resetNotice:allowed===true&&current?.resetNotice===true,
  };
}
type RetainedDateDraft=ReturnType<typeof useRetainedDateDraft>;
type DeadlineWarning={dueOn:string|null;message:string;confirm:string;cancel:string};
/** An explicit Save or Remove dispatches a date-only value. For a personal
 * date after the displayed deadline, a separate confirmation is required.
 * The parent keys the control by its authoritative snapshot (not the draft). */
export function TargetDateControls({value,label,save,remove,disabled=false,onChange,testId,actionContext,deadlineWarning,retained,changedNotice}:{
  value:string|null;label:string;save:string;remove:string;disabled?:boolean;
  onChange:(value:string|null)=>void;testId?:string;actionContext?:string;
  deadlineWarning?:DeadlineWarning;retained?:RetainedDateDraft;changedNotice?:string;
}){
  const [local,setLocal]=useState(()=>initialDateDraft(value));
  const {value:draft,confirming}=retained?.draft??local;
  const setDraft=(next:string,confirm=false)=>(retained?.setDraft??setLocal)({value:next,confirming:confirm});
  const submit=(next:string|null)=>{retained?.clear();onChange(next);};
  const valid=draft!==""&&validMyPlanWhenDate(draft)&&draft!==value;
  const afterDeadline=valid&&deadlineWarning?.dueOn!=null&&draft>deadlineWarning.dueOn;
  const actionName=(name:string)=>actionContext?name+": "+actionContext:name;
  return <div className="targetDateControls">
    <input type="date" aria-label={label} data-testid={testId}
      data-confirmed-date={value??""}
      value={draft} min="0001-01-01" max="9999-12-31" disabled={disabled}
      onChange={event=>setDraft(event.currentTarget.value)}/>
    {retained?.resetNotice&&changedNotice&&<p role="status">{changedNotice}</p>}
    <button type="button" aria-label={actionName(save)} disabled={disabled||!valid||confirming}
      onClick={()=>{if(valid){if(afterDeadline)setDraft(draft,true);else submit(draft);}}}>{save}</button>
    {value!==null&&<button type="button" aria-label={actionName(remove)} disabled={disabled||confirming}
      onClick={()=>submit(null)}>{remove}</button>}
    {confirming&&afterDeadline&&deadlineWarning&&<>
      <p role="alert">{deadlineWarning.message}</p>
      <button type="button" aria-label={actionName(deadlineWarning.confirm)} disabled={disabled}
        onClick={()=>{setDraft(draft);submit(draft);}}>{deadlineWarning.confirm}</button>
      <button type="button" aria-label={actionName(deadlineWarning.cancel)} disabled={disabled}
        onClick={()=>setDraft(draft)}>{deadlineWarning.cancel}</button>
    </>}
  </div>;
}
