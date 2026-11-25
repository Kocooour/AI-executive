"use client";
/** R3-FE-6: independently gated runtime observer for task CREATE completion.
 * Kept outside LumiAppRoot so the default-off shell has no target runtime
 * imports. It stays mounted when Quick Capture is closed/unmounted.
 * Never stores a title, Area, command or task ID in browser storage. */
import {useEffect,useRef,useState} from "react";
import {targetAppFetch} from "../../lib/target-app-fetch";
import {PRIVATE_TASK_UNDO_WINDOW_MS,confirmPrivateTaskUndo,readPrivateTaskUndoBaseline,
  undoPrivateTaskCreate,type UndoBaseline,type UndoOutcome} from "../../lib/target-private-task-create-undo";
import {useTargetGeneration,useTargetRuntime} from "./target-data-provider";
import {openTargetDetail} from "./target-detail-state";
import {writeTargetReadingScope} from "../../lib/target-reading-scope-nav";
import {scopeFromSearch} from "../../lib/view-url";
import {detailIdOk} from "../../lib/target-detail-route";
import {emitTargetChange} from "../../lib/target-data-invalidation";
import {lastConfirmedPrivateTask,subscribePrivateTaskCreate} from
  "../../lib/target-private-task-create-coordinator";

type UndoState=
  |{phase:"none"}|{phase:"offered";baseline:UndoBaseline}|{phase:"working";baseline:UndoBaseline}
  |{phase:"done";outcome:Exclude<UndoOutcome,{kind:"failed"}>;baseline:UndoBaseline}
  |{phase:"failed";baseline:UndoBaseline};

const undoMessage=(outcome:UndoOutcome,cs:boolean):string=>{
  switch(outcome.kind){
    case "deleted":return cs?"Úkol byl odstraněn.":"The task was removed.";
    case "changed":return cs
      ?"Úkol se mezitím změnil, proto nebyl odstraněn. Případně ho smaž v detailu."
      :"The task has changed since it was created, so it was not removed. You can delete it from its details.";
    case "gone":return cs?"Úkol už není k dispozici.":"The task is no longer available.";
    case "signed-out":return cs?"Přihlášení vypršelo, úkol nebyl odstraněn.":"Your session ended; the task was not removed.";
    case "uncertain":return cs
      ?"Nepodařilo se ověřit, zda byl úkol odstraněn. Požadavek se znovu neodešle."
      :"Could not confirm whether the task was removed. The request will not be sent again.";
    case "failed":return cs?"Úkol se nepodařilo odstranit. Zkus to znovu.":"The task could not be removed. Try again.";
  }
};

export default function TargetPrivateTaskCreatedNotice({
  language="cs",onCreated,undoEnabled=false,
}:{language?:"cs"|"en";onCreated:()=>void;undoEnabled?:boolean}){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [notice,setNotice]=useState<{generation:string;taskId:string}|null>(null);
  const [undo,setUndo]=useState<UndoState>({phase:"none"});
  const busy=useRef(false);
  const statusRef=useRef<HTMLDivElement|null>(null);
  const onCreatedRef=useRef(onCreated);
  onCreatedRef.current=onCreated;
  useEffect(()=>{setNotice(null);},[generation]);
  // Undo is bound to the exact revision observed right after the confirmed
  // CREATE, and offered only for a bounded window. No browser storage.
  useEffect(()=>{
    setUndo({phase:"none"});busy.current=false;
    if(!undoEnabled||!notice||notice.generation!==generation)return;
    const controller=new AbortController();
    void readPrivateTaskUndoBaseline(notice.taskId,targetAppFetch,controller.signal)
      .then(result=>{
        if(!controller.signal.aborted&&result.ok)setUndo({phase:"offered",baseline:result.baseline});
      });
    const expire=window.setTimeout(()=>{
      setUndo(current=>current.phase==="offered"||current.phase==="failed"?{phase:"none"}:current);
    },PRIVATE_TASK_UNDO_WINDOW_MS);
    return ()=>{controller.abort();window.clearTimeout(expire);};
  },[undoEnabled,notice,generation]);
  const finish=(baseline:UndoBaseline,outcome:UndoOutcome)=>{
    busy.current=false;
    setUndo(outcome.kind==="failed"?{phase:"failed",baseline}:{phase:"done",outcome,baseline});
    if(outcome.kind==="deleted"||outcome.kind==="gone")
      emitTargetChange({kind:"task",id:baseline.taskId,change:"deleted"});
    window.setTimeout(()=>statusRef.current?.focus(),0);
  };
  const runUndo=(baseline:UndoBaseline)=>{
    if(busy.current||!runtime?.known()||runtime.generation()!==generation)return;
    busy.current=true;
    setUndo({phase:"working",baseline});
    void undoPrivateTaskCreate(baseline,targetAppFetch,new AbortController().signal)
      .then(outcome=>finish(baseline,outcome),()=>finish(baseline,{kind:"failed"}));
  };
  const confirmUndo=(baseline:UndoBaseline,command:Extract<UndoOutcome,{kind:"uncertain"}>["command"])=>{
    if(busy.current)return;
    busy.current=true;
    setUndo({phase:"working",baseline});
    void confirmPrivateTaskUndo(command,targetAppFetch,new AbortController().signal)
      .then(outcome=>finish(baseline,outcome.kind==="failed"?{kind:"failed"}:outcome),
        ()=>finish(baseline,{kind:"uncertain",command}));
  };
  useEffect(()=>{
    if(!runtime?.known()||runtime.generation()!==generation)return;
    // Neither the modal nor its own .then owns completion. Only a confirmed
    // POST/exact receipt/actor-authorized reload recovery can notify this.
    const show=(taskId:string)=>{
      if(!detailIdOk(taskId))return;
      setNotice({generation,taskId});
      // Only a confirmed target CREATE may invalidate an already-open Inbox.
      // Each subscriber must re-read through its own current actor/ACL gate.
      emitTargetChange({kind:"task",id:taskId,change:"updated"});
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
  const cs=language==="cs";
  const removed=undo.phase==="done"&&(undo.outcome.kind==="deleted"||undo.outcome.kind==="gone");
  return <div className="navigationUnavailableNotice" role="status"
    data-testid="target-private-task-created" ref={statusRef} tabIndex={-1}>
    {undo.phase==="done"||undo.phase==="failed"
      ?<p data-testid="target-private-task-undo-result">
        {undoMessage(undo.phase==="failed"?{kind:"failed"}:undo.outcome,cs)}</p>
      :<p>{cs
        ?"Soukromý úkol byl potvrzen serverem. Zatím nemá naplánovaný den."
        :"Private task creation was confirmed. It has no scheduled day yet."}</p>}
    {(undo.phase==="offered"||undo.phase==="failed")&&<button type="button"
      data-testid="target-private-task-undo" onClick={()=>runUndo(undo.baseline)}>
      {cs?"Zpět (odstranit úkol)":"Undo (remove task)"}</button>}
    {undo.phase==="working"&&<button type="button" disabled aria-busy="true"
      data-testid="target-private-task-undo">{cs?"Odstraňuji…":"Removing…"}</button>}
    {undo.phase==="done"&&undo.outcome.kind==="uncertain"&&<button type="button"
      data-testid="target-private-task-undo-confirm"
      onClick={()=>confirmUndo(undo.baseline,(undo.outcome as Extract<UndoOutcome,{kind:"uncertain"}>).command)}>
      {cs?"Ověřit znovu":"Check again"}</button>}
    {!removed&&<button type="button" data-testid="target-private-task-open" onClick={()=>{
      if(!runtime.known()||runtime.generation()!==generation||!notice||
        notice.generation!==generation||!detailIdOk(notice.taskId))return;
      // A private task cannot be shown in the Shared-only read scope.
      // The destination still checks its current actor and Area ACL.
      if(scopeFromSearch(window.location.search)==="shared"&&
        !writeTargetReadingScope("personal"))return;
      const before=window.location.search;
      openTargetDetail({kind:"task",id:notice.taskId,view:"MyPlanPreview"});
      if(window.location.search!==before)setNotice(null);
    }}>{language==="cs"?"Zobrazit úkol":"View task"}</button>}
    <button type="button" onClick={()=>setNotice(null)}>
      {language==="cs"?"Skrýt":"Dismiss"}
    </button>
  </div>;
}
