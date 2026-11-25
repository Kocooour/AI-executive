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
import {lastConfirmedPrivateTaskChange,subscribePrivateTaskCreate,type TaskCreateSource} from
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

/** One Undo/confirmation request may not hang the notice. Before dispatch an
 * expired request is simply not sent; after dispatch it stays uncertain. */
const UNDO_REQUEST_TIMEOUT_MS=15_000;
type Notice={generation:string;taskId:string;undoable:boolean;deadline:number};

export default function TargetPrivateTaskCreatedNotice({
  language="cs",onCreated,undoEnabled=false,
}:{language?:"cs"|"en";onCreated:()=>void;undoEnabled?:boolean}){
  const runtime=useTargetRuntime(),generation=useTargetGeneration();
  const [notice,setNotice]=useState<Notice|null>(null);
  const [undo,setUndo]=useState<UndoState>({phase:"none"});
  // Every request is tied to the notice that started it; a result arriving
  // for an older notice never changes the one currently on screen.
  const run=useRef<{seq:number;controller:AbortController|null}>({seq:0,controller:null});
  const statusRef=useRef<HTMLDivElement|null>(null);
  const onCreatedRef=useRef(onCreated);
  onCreatedRef.current=onCreated;
  useEffect(()=>{setNotice(null);},[generation]);
  // Undo is bound to the exact revision read when this page's own CREATE was
  // confirmed, and offered only until the notice's fixed deadline.
  useEffect(()=>{
    run.current.seq++;run.current.controller?.abort();run.current.controller=null;
    setUndo({phase:"none"});
    if(!undoEnabled||!notice||!notice.undoable||notice.generation!==generation)return;
    const controller=new AbortController();
    void readPrivateTaskUndoBaseline(notice.taskId,targetAppFetch,controller.signal)
      .then(result=>{
        if(!controller.signal.aborted&&result.ok&&Date.now()<notice.deadline)
          setUndo({phase:"offered",baseline:result.baseline});
      });
    const expire=window.setTimeout(()=>{
      setUndo(current=>current.phase==="offered"||current.phase==="failed"?{phase:"none"}:current);
    },Math.max(0,notice.deadline-Date.now()));
    return ()=>{
      controller.abort();window.clearTimeout(expire);
      run.current.seq++;run.current.controller?.abort();run.current.controller=null;
    };
  },[undoEnabled,notice,generation]);
  const start=():{seq:number;signal:AbortSignal}=>{
    const controller=new AbortController();
    const seq=++run.current.seq;
    run.current.controller=controller;
    window.setTimeout(()=>controller.abort(),UNDO_REQUEST_TIMEOUT_MS);
    return {seq,signal:controller.signal};
  };
  const finish=(seq:number,baseline:UndoBaseline,outcome:UndoOutcome)=>{
    if(outcome.kind==="deleted"||outcome.kind==="gone")
      emitTargetChange({kind:"task",id:baseline.taskId,change:"deleted"});
    if(seq!==run.current.seq||!notice||notice.taskId!==baseline.taskId)return;
    run.current.controller=null;
    setUndo(outcome.kind==="failed"
      ?(Date.now()<notice.deadline?{phase:"failed",baseline}:{phase:"none"})
      :{phase:"done",outcome,baseline});
    window.setTimeout(()=>{
      const active=document.activeElement;
      if(!active||active===document.body||statusRef.current?.contains(active))
        statusRef.current?.focus();
    },0);
  };
  const runUndo=(baseline:UndoBaseline)=>{
    if(undo.phase==="working"||!notice||Date.now()>=notice.deadline||
      !runtime?.known()||runtime.generation()!==generation)return;
    const {seq,signal}=start();
    setUndo({phase:"working",baseline});
    void undoPrivateTaskCreate(baseline,targetAppFetch,signal)
      .then(outcome=>finish(seq,baseline,outcome),()=>finish(seq,baseline,{kind:"failed"}));
  };
  const confirmUndo=(baseline:UndoBaseline,command:Extract<UndoOutcome,{kind:"uncertain"}>["command"])=>{
    if(undo.phase==="working")return;
    const {seq,signal}=start();
    setUndo({phase:"working",baseline});
    void confirmPrivateTaskUndo(command,targetAppFetch,signal)
      .then(outcome=>finish(seq,baseline,outcome),
        ()=>finish(seq,baseline,{kind:"uncertain",command}));
  };
  useEffect(()=>{
    if(!runtime?.known()||runtime.generation()!==generation)return;
    // Neither the modal nor its own .then owns completion. Only a confirmed
    // POST/exact receipt/actor-authorized reload recovery can notify this.
    const show=(taskId:string,source:TaskCreateSource|undefined)=>{
      if(!detailIdOk(taskId))return;
      // Undo only for this page's own confirmed command, never after a reload.
      setNotice({generation,taskId,undoable:source==="post"||source==="receipt",
        deadline:Date.now()+PRIVATE_TASK_UNDO_WINDOW_MS});
      // Only a confirmed target CREATE may invalidate an already-open Inbox.
      // Each subscriber must re-read through its own current actor/ACL gate.
      emitTargetChange({kind:"task",id:taskId,change:"updated"});
      onCreatedRef.current();
    };
    const unsubscribe=subscribePrivateTaskCreate(runtime,generation,change=>{
      if(change.confirmedTaskId)show(change.confirmedTaskId,change.source);
    });
    // Dynamic chunk loading can finish after a fast HTTP 201; catch up
    // without replaying the write or trusting any browser storage.
    const last=lastConfirmedPrivateTaskChange(runtime,generation);
    if(last)show(last.taskId,last.source);
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
    {(undo.phase==="offered"||undo.phase==="failed"||undo.phase==="working")&&<button type="button"
      data-testid="target-private-task-undo" aria-disabled={undo.phase==="working"}
      aria-busy={undo.phase==="working"}
      onClick={()=>{if(undo.phase!=="working")runUndo(undo.baseline);}}>
      {undo.phase==="working"?(cs?"Odstraňuji…":"Removing…"):(cs?"Zpět (odstranit úkol)":"Undo (remove task)")}</button>}
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
