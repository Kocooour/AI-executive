"use client";
/** R3-FE-6: independently gated runtime observer for task CREATE completion.
 * Kept outside LumiAppRoot so the default-off shell has no target runtime
 * imports. It stays mounted when Quick Capture is closed/unmounted.
 * Never stores a title, Area, command or task ID in browser storage. */
import {useEffect,useRef,useState} from "react";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {openTargetDetail} from "./target-detail-state";
import {writeTargetReadingScope} from "../../lib/target-reading-scope-nav";
import {scopeFromSearch} from "../../lib/view-url";
import {detailIdOk} from "../../lib/target-detail-route";
import {lastConfirmedPrivateTask,subscribePrivateTaskCreate} from
  "../../lib/target-private-task-create-coordinator";

export default function TargetPrivateTaskCreatedNotice({
  language="cs",onCreated,
}:{language?:"cs"|"en";onCreated:()=>void}){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [notice,setNotice]=useState<{generation:string;taskId:string}|null>(null);
  const onCreatedRef=useRef(onCreated);
  onCreatedRef.current=onCreated;
  useEffect(()=>{setNotice(null);},[generation]);
  useEffect(()=>{
    if(!runtime?.known()||runtime.generation()!==generation)return;
    // Neither the modal nor its own .then owns completion. Only a confirmed
    // POST/exact receipt/actor-authorized reload recovery can notify this.
    const show=(taskId:string)=>{
      if(!detailIdOk(taskId))return;
      setNotice({generation,taskId});
      onCreatedRef.current();
    };
    const unsubscribe=subscribePrivateTaskCreate(runtime,generation,change=>{
      if(change.confirmedTaskId)show(change.confirmedTaskId);
    });
    // Dynamic chunk loading can finish after a fast HTTP 201; catch up
    // without replaying the write or trusting any browser storage.
    const last=lastConfirmedPrivateTask(runtime,generation);
    if(last)show(last);
    return unsubscribe;
  },[runtime,generation]);
  if(!notice||notice.generation!==generation||
    !runtime?.known()||runtime.generation()!==generation)return null;
  return <div className="navigationUnavailableNotice" role="status"
    data-testid="target-private-task-created">
    <p>{language==="cs"
      ?"Soukromý úkol byl potvrzen serverem. Zatím nemá naplánovaný den."
      :"Private task creation was confirmed. It has no scheduled day yet."}</p>
    <button type="button" data-testid="target-private-task-open" onClick={()=>{
      if(!runtime.known()||runtime.generation()!==generation||!notice||
        notice.generation!==generation||!detailIdOk(notice.taskId))return;
      // A private task cannot be shown in the Shared-only read scope.
      // The destination still checks its current actor and Area ACL.
      if(scopeFromSearch(window.location.search)==="shared"&&
        !writeTargetReadingScope("personal"))return;
      const before=window.location.search;
      openTargetDetail({kind:"task",id:notice.taskId,view:"MyPlanPreview"});
      if(window.location.search!==before)setNotice(null);
    }}>{language==="cs"?"Zobrazit úkol":"View task"}</button>
    <button type="button" onClick={()=>setNotice(null)}>
      {language==="cs"?"Skrýt":"Dismiss"}
    </button>
  </div>;
}
