/** R3-FE-4b: ONE write state model for every edit inside the authorized detail
 * (task title / complete-restore / personal When / delete, note edit / delete).
 *
 *   idle -> pending(preparing -> dispatched) -> committed (Undo where the server supports it)
 *                                             | conflict   (CAS / revision mismatch)
 *                                             | uncertain  (outcome unknown after dispatch)
 *                                             | error      (validation, read-only, rate limit)
 *   offline: no dispatch at all.
 *
 * The reducer is pure. The controller composes the existing My Plan status / When transports
 * (reused, not re-invented) with the strict R3-FE-4b transports. Principles, all tested:
 *  - a write is dispatched EXACTLY ONCE; an ambiguous outcome is confirmed only through the
 *    read-only receipt of the same command and is never resent automatically;
 *  - everything lives in memory only (drafts, commands, Undo): nothing is persisted or logged;
 *  - Undo is bound to the detail generation and cleared by reset();
 *  - a command that may have committed survives revocation/generation change as `uncertain`. */
import {
  dispatchMyPlanStatus,checkMyPlanStatusReceipt,validStatusCommand,
  type MyPlanStatusCommand,
} from "./target-staging-my-plan-status-client";
import {prepareConfirmedMyPlanUndo} from "./target-staging-my-plan-undo";
import {
  dispatchMyPlanWhen,checkMyPlanWhenReceipt,prepareMyPlanWhen,
  type MyPlanWhenCommand,
} from "./target-staging-my-plan-when-client";
import {prepareConfirmedWhenUndo} from "./target-staging-my-plan-when-undo";
import {readStagingTaskPreview,type TaskPreview} from "./target-staging-task-preview-client";
import {readStagingNotePreview,type NotePreview} from "./target-staging-note-preview-client";
import {
  buildNoteDeleteCommand,buildNoteEditCommand,buildTaskDeleteCommand,buildTaskTitleCommand,
  checkNoteDeleteReceipt,checkNoteEditReceipt,checkTaskDeleteReceipt,checkTaskTitleReceipt,
  dispatchNoteDelete,dispatchNoteEdit,dispatchTaskDelete,dispatchTaskTitle,
  readNoteWriteContext,readTaskWriteContext,validTaskTitle,
  type EditFailure,type EditReceipt,
} from "./target-staging-edit-clients";

export type WriteKind="taskTitle"|"taskStatus"|"taskWhen"|"taskDelete"|"noteEdit"|"noteDelete";
export type WriteFailure="invalid"|"forbidden"|"unavailable"|"rate-limited"|"invalid-response";

export type WriteState=
  |{kind:"idle"}
  |{kind:"pending";write:WriteKind;phase:"preparing"|"dispatched";undoing:boolean}
  |{kind:"committed";write:WriteKind;undoable:boolean;undone:boolean;deleted:boolean}
  |{kind:"conflict";write:WriteKind}
  |{kind:"uncertain";write:WriteKind;checking:boolean;notRecorded:boolean}
  |{kind:"error";write:WriteKind;reason:WriteFailure}
  |{kind:"offline";write:WriteKind};

export type SettleOutcome=
  |{t:"committed";undoable:boolean;deleted:boolean}
  |{t:"conflict"}|{t:"uncertain"}|{t:"error";reason:WriteFailure}
  |{t:"signed-out"}|{t:"offline"}|{t:"aborted"};
export type WriteEvent=
  |{t:"start";write:WriteKind;undoing?:boolean}
  |{t:"dispatched"}
  |{t:"settle";outcome:SettleOutcome}
  |{t:"check"}
  |{t:"checked";result:"committed"|"not-recorded"|"unknown"|"signed-out";undoable?:boolean;deleted?:boolean}
  |{t:"offline-attempt";write:WriteKind}
  |{t:"online"}
  |{t:"reset"}
  |{t:"dismiss"};

export const IDLE:WriteState={kind:"idle"};

/** Only a settled or never-started state may start another write; pending and uncertain block. */
export const canStartWrite=(state:WriteState):boolean=>
  state.kind!=="pending"&&state.kind!=="uncertain";

export function writeReducer(state:WriteState,event:WriteEvent):WriteState{
  switch(event.t){
    case "start":
      return canStartWrite(state)
        ?{kind:"pending",write:event.write,phase:"preparing",undoing:event.undoing===true}:state;
    case "dispatched":
      return state.kind==="pending"?{...state,phase:"dispatched"}:state;
    case "settle":{
      if(state.kind!=="pending")return state;
      const {outcome}=event;
      const dispatched=state.phase==="dispatched";
      switch(outcome.t){
        case "committed":
          return {kind:"committed",write:state.write,undoable:outcome.undoable&&!state.undoing,
            undone:state.undoing,deleted:outcome.deleted};
        case "conflict":return {kind:"conflict",write:state.write};
        case "uncertain":return {kind:"uncertain",write:state.write,checking:false,notRecorded:false};
        case "error":return {kind:"error",write:state.write,reason:outcome.reason};
        // Revocation / lost connection / abort: only a write that was already dispatched may have
        // committed; before that nothing happened at all.
        case "signed-out":case "offline":case "aborted":
          return dispatched
            ?{kind:"uncertain",write:state.write,checking:false,notRecorded:false}
            :outcome.t==="offline"?{kind:"offline",write:state.write}:IDLE;
      }
      return state;
    }
    case "check":
      return state.kind==="uncertain"&&!state.checking?{...state,checking:true}:state;
    case "checked":
      if(state.kind!=="uncertain"||!state.checking)return state;
      if(event.result==="committed")
        return {kind:"committed",write:state.write,undoable:event.undoable===true,
          undone:false,deleted:event.deleted===true};
      // Neither "not recorded" nor an unreadable/denied receipt proves that nothing committed.
      return {...state,checking:false,notRecorded:event.result==="not-recorded"};
    case "offline-attempt":
      return canStartWrite(state)?{kind:"offline",write:event.write}:state;
    case "online":
      return state.kind==="offline"?IDLE:state;
    case "reset":
      // A detail generation / scope change clears feedback and Undo. A write that was already
      // dispatched (or is awaiting its receipt) stays reconcilable.
      if(state.kind==="uncertain")return {...state,checking:false};
      if(state.kind==="pending"&&state.phase==="dispatched")
        return {kind:"uncertain",write:state.write,checking:false,notRecorded:false};
      return IDLE;
    case "dismiss":
      return state.kind==="committed"||state.kind==="conflict"||state.kind==="error"||
        state.kind==="offline"?IDLE:state;
  }
}

/** ---- operations ---- */
export type Reconciled={
  result:"committed"|"not-recorded"|"unknown"|"signed-out";
  undo?:UndoHandle|null;deleted?:boolean;
};
export type Reconciler=(signal:AbortSignal)=>Promise<Reconciled>;
export type ExecHooks={onDispatch:(reconcile:Reconciler)=>void};
export type Outcome=
  |{t:"committed";undo:UndoHandle|null;deleted?:boolean}
  |{t:"conflict"}|{t:"uncertain"}|{t:"error";reason:WriteFailure}
  |{t:"signed-out"}|{t:"offline"}|{t:"aborted"};
export type UndoHandle=(signal:AbortSignal,hooks:ExecHooks)=>Promise<Outcome>;

export type WriteInput=
  /** `baseTitle` is the title the user started from (and the one an Undo restores). */
  |{kind:"taskTitle";taskId:string;areaId:string;title:string;baseTitle:string}
  |{kind:"taskStatus";taskId:string;areaId:string;status:"open"|"completed"}
  |{kind:"taskWhen";taskId:string;areaId:string;whenOn:string|null}
  |{kind:"taskDelete";taskId:string;areaId:string;base:TaskPreview}
  |{kind:"noteEdit";noteId:string;areaId:string;title:string;body:string;baseTitle:string;baseBody:string}
  |{kind:"noteDelete";noteId:string;areaId:string;base:NotePreview};

type Deps={fetch:typeof fetch;signal:AbortSignal;hooks:ExecHooks};

/** Maps any transport failure to the one outcome vocabulary. */
export function outcomeForFailure(reason:EditFailure|"stale"|"unchanged"):Outcome{
  switch(reason){
    case "signed-out":return {t:"signed-out"};
    case "conflict":case "stale":return {t:"conflict"};
    case "not-available":return {t:"error",reason:"forbidden"};
    case "rate-limited":return {t:"error",reason:"rate-limited"};
    case "invalid-request":return {t:"error",reason:"invalid"};
    case "invalid-response":return {t:"error",reason:"invalid-response"};
    case "offline":return {t:"offline"};
    case "aborted":case "unchanged":return {t:"aborted"};
    default:return {t:"error",reason:"unavailable"};
  }
}

/** A strict detail read that fails after a passed preflight: the item vanished (conflict) or the
 * read itself failed. */
function outcomeForRead(reason:string):Outcome{
  switch(reason){
    case "not-found":case "stale":case "disabled":return {t:"conflict"};
    case "signed-out":return {t:"signed-out"};
    case "aborted":return {t:"aborted"};
    case "offline":return {t:"offline"};
    case "rate-limited":return {t:"error",reason:"rate-limited"};
    case "invalid-response":return {t:"error",reason:"invalid-response"};
    case "invalid-request":return {t:"error",reason:"invalid"};
    default:return {t:"error",reason:"unavailable"};
  }
}

const reconciledFrom=(receipt:EditReceipt,undo?:UndoHandle|null,deleted=false):Reconciled=>
  receipt.kind==="unknown"
    ?{result:receipt.reason==="signed-out"?"signed-out":"unknown"}
    :receipt.kind==="committed"?{result:"committed",undo:undo??null,deleted}
    :{result:"not-recorded"};

async function runTaskTitle(input:Extract<WriteInput,{kind:"taskTitle"}>,d:Deps):Promise<Outcome>{
  const ctx=await readTaskWriteContext(input.taskId,input.areaId,d.fetch,d.signal);
  if(ctx.ok===false)return outcomeForFailure(ctx.reason);
  // Optimistic concurrency on what the user SAW: the CAS token above is fresh, so the content it
  // covers is read right after it and must still be the title the edit started from; otherwise
  // someone changed it meanwhile and the draft would silently overwrite their change.
  const seen=await readStagingTaskPreview(input.taskId,d.signal,d.fetch);
  if(seen.ok===false)return outcomeForRead(seen.reason);
  if(seen.task.title!==input.baseTitle||seen.task.areaId!==input.areaId)return {t:"conflict"};
  const command=buildTaskTitleCommand(input.taskId,input.title,ctx.context);
  if(!command)return {t:"error",reason:"invalid"};
  const undoOf=():UndoHandle|null=>validTaskTitle(input.baseTitle)&&input.baseTitle!==input.title
    ?async(signal,hooks)=>{
      // Never undo blindly: the original must be confirmed, a FRESH preflight is taken first, and
      // only then is the title read; a later edit by anyone invalidates the preflight (CAS).
      const receipt=await checkTaskTitleReceipt(command,d.fetch,signal);
      if(receipt.kind==="unknown")return outcomeForFailure(receipt.reason);
      if(receipt.kind!=="committed")return {t:"conflict"};
      const fresh=await readTaskWriteContext(input.taskId,input.areaId,d.fetch,signal);
      if(fresh.ok===false)return outcomeForFailure(fresh.reason);
      const current=await readStagingTaskPreview(input.taskId,signal,d.fetch);
      if(current.ok===false)return outcomeForRead(current.reason);
      if(current.task.title!==input.title)return {t:"conflict"};
      const back=buildTaskTitleCommand(input.taskId,input.baseTitle,fresh.context);
      if(!back)return {t:"error",reason:"invalid"};
      const result=await dispatchTaskTitle(back,d.fetch,signal,()=>hooks.onDispatch(
        async s=>reconciledFrom(await checkTaskTitleReceipt(back,d.fetch,s))));
      return fromDispatch(result);
    }:null;
  const result=await dispatchTaskTitle(command,d.fetch,d.signal,()=>d.hooks.onDispatch(
    async s=>reconciledFrom(await checkTaskTitleReceipt(command,d.fetch,s),undoOf())));
  return fromDispatch(result,undoOf);
}

function fromDispatch(
  result:{kind:"committed"|"uncertain"|"rejected";reason?:EditFailure},
  undo?:()=>UndoHandle|null,deleted=false,
):Outcome{
  if(result.kind==="committed")return {t:"committed",undo:undo?undo():null,deleted};
  if(result.kind==="uncertain")return {t:"uncertain"};
  return outcomeForFailure(result.reason as EditFailure);
}

async function runTaskStatus(input:Extract<WriteInput,{kind:"taskStatus"}>,d:Deps):Promise<Outcome>{
  const ctx=await readTaskWriteContext(input.taskId,input.areaId,d.fetch,d.signal);
  if(ctx.ok===false)return outcomeForFailure(ctx.reason);
  const command:MyPlanStatusCommand={
    commandId:crypto.randomUUID(),taskId:input.taskId,status:input.status,...ctx.context,
  };
  if(!validStatusCommand(command))return {t:"error",reason:"invalid"};
  // Server Undo semantics as in My Plan: only a completion is undoable (reopening it).
  const undoOf=():UndoHandle|null=>input.status!=="completed"?null:async(signal,hooks)=>{
    const prepared=await prepareConfirmedMyPlanUndo(command,d.fetch,signal);
    if(prepared.kind==="signed-out")return {t:"signed-out"};
    if(prepared.kind==="retry")return outcomeForFailure(
      prepared.reason==="stale"?"conflict":prepared.reason==="unavailable"?"unavailable":prepared.reason);
    const back=prepared.command;
    hooks.onDispatch(async s=>reconciledFrom(await statusReceipt(back,d.fetch,s)));
    return fromStatusDispatch(await dispatchMyPlanStatus(back,d.fetch,signal));
  };
  d.hooks.onDispatch(async s=>reconciledFrom(await statusReceipt(command,d.fetch,s),undoOf()));
  const result=await dispatchMyPlanStatus(command,d.fetch,d.signal);
  return fromStatusDispatch(result,undoOf);
}
async function statusReceipt(command:MyPlanStatusCommand,f:typeof fetch,signal:AbortSignal):Promise<EditReceipt>{
  const r=await checkMyPlanStatusReceipt(command,f,signal);
  return r.kind==="unknown"
    ?{kind:"unknown",reason:r.reason==="stale"?"conflict":r.reason as EditFailure}:r;
}
function fromStatusDispatch(
  result:{kind:"committed"|"uncertain"|"rejected";reason?:string},undo?:()=>UndoHandle|null,
):Outcome{
  if(result.kind==="committed")return {t:"committed",undo:undo?undo():null};
  if(result.kind==="uncertain")return {t:"uncertain"};
  return outcomeForFailure((result.reason==="stale"?"conflict":result.reason) as EditFailure);
}

async function runTaskWhen(input:Extract<WriteInput,{kind:"taskWhen"}>,d:Deps):Promise<Outcome>{
  const prepared=await prepareMyPlanWhen(
    {taskId:input.taskId,areaId:input.areaId,whenOn:input.whenOn,signal:d.signal},d.fetch);
  if(prepared.ok===false)return outcomeForFailure(
    prepared.reason==="stale"?"conflict":prepared.reason as EditFailure|"unchanged");
  const {command,previousWhenOn}=prepared;
  const undoOf=():UndoHandle|null=>async(signal,hooks)=>{
    const ready=await prepareConfirmedWhenUndo({command,previousWhenOn},d.fetch,signal);
    if(ready.kind==="signed-out")return {t:"signed-out"};
    if(ready.kind==="retry")return outcomeForFailure(
      ready.reason==="stale"?"conflict":ready.reason as EditFailure|"unchanged");
    const back=ready.command;
    hooks.onDispatch(async s=>reconciledFrom(await whenReceipt(back,d.fetch,s)));
    return fromStatusDispatch(await dispatchMyPlanWhen(back,d.fetch,signal));
  };
  d.hooks.onDispatch(async s=>reconciledFrom(await whenReceipt(command,d.fetch,s),undoOf()));
  const result=await dispatchMyPlanWhen(command,d.fetch,d.signal);
  return fromStatusDispatch(result,undoOf);
}
async function whenReceipt(command:MyPlanWhenCommand,f:typeof fetch,signal:AbortSignal):Promise<EditReceipt>{
  const r=await checkMyPlanWhenReceipt(command,f,signal);
  return r.kind==="unknown"
    ?{kind:"unknown",reason:r.reason==="stale"?"conflict":r.reason==="unchanged"?"invalid-request":r.reason as EditFailure}:r;
}

/** Delete has no server Undo: it must refer to the exact authorized snapshot the user confirmed.
 * The fresh server CAS guards changes between this read and the final mutation. */
export const sameDeleteSnapshot=(current:TaskPreview|NotePreview,base:TaskPreview|NotePreview):boolean=>
  JSON.stringify(current)===JSON.stringify(base);

async function runTaskDelete(input:Extract<WriteInput,{kind:"taskDelete"}>,d:Deps):Promise<Outcome>{
  const ctx=await readTaskWriteContext(input.taskId,input.areaId,d.fetch,d.signal);
  if(ctx.ok===false)return outcomeForFailure(ctx.reason);
  const seen=await readStagingTaskPreview(input.taskId,d.signal,d.fetch);
  if(seen.ok===false)return outcomeForRead(seen.reason);
  if(!sameDeleteSnapshot(seen.task,input.base)||seen.task.areaId!==input.areaId)
    return {t:"conflict"};
  const command=buildTaskDeleteCommand(input.taskId,ctx.context);
  if(!command)return {t:"error",reason:"invalid"};
  const result=await dispatchTaskDelete(command,d.fetch,d.signal,()=>d.hooks.onDispatch(
    async s=>reconciledFrom(await checkTaskDeleteReceipt(command,d.fetch,s),null,true)));
  return fromDispatch(result,undefined,true);
}
async function runNoteEdit(input:Extract<WriteInput,{kind:"noteEdit"}>,d:Deps):Promise<Outcome>{
  const ctx=await readNoteWriteContext(input.noteId,input.areaId,d.fetch,d.signal);
  if(ctx.ok===false)return outcomeForFailure(ctx.reason);
  const seen=await readStagingNotePreview(input.noteId,d.signal,d.fetch);
  if(seen.ok===false)return outcomeForRead(seen.reason);
  if(seen.note.title!==input.baseTitle||seen.note.body!==input.baseBody||seen.note.areaId!==input.areaId)
    return {t:"conflict"};
  const command=buildNoteEditCommand(input.noteId,input.title,input.body,ctx.context);
  if(!command)return {t:"error",reason:"invalid"};
  const result=await dispatchNoteEdit(command,d.fetch,d.signal,()=>d.hooks.onDispatch(
    async s=>reconciledFrom(await checkNoteEditReceipt(command,d.fetch,s))));
  return fromDispatch(result);
}
async function runNoteDelete(input:Extract<WriteInput,{kind:"noteDelete"}>,d:Deps):Promise<Outcome>{
  const ctx=await readNoteWriteContext(input.noteId,input.areaId,d.fetch,d.signal);
  if(ctx.ok===false)return outcomeForFailure(ctx.reason);
  const seen=await readStagingNotePreview(input.noteId,d.signal,d.fetch);
  if(seen.ok===false)return outcomeForRead(seen.reason);
  if(!sameDeleteSnapshot(seen.note,input.base)||seen.note.areaId!==input.areaId)
    return {t:"conflict"};
  const command=buildNoteDeleteCommand(input.noteId,ctx.context);
  if(!command)return {t:"error",reason:"invalid"};
  const result=await dispatchNoteDelete(command,d.fetch,d.signal,()=>d.hooks.onDispatch(
    async s=>reconciledFrom(await checkNoteDeleteReceipt(command,d.fetch,s),null,true)));
  return fromDispatch(result,undefined,true);
}

export function executeWrite(input:WriteInput,d:Deps):Promise<Outcome>{
  switch(input.kind){
    case "taskTitle":return runTaskTitle(input,d);
    case "taskStatus":return runTaskStatus(input,d);
    case "taskWhen":return runTaskWhen(input,d);
    case "taskDelete":return runTaskDelete(input,d);
    case "noteEdit":return runNoteEdit(input,d);
    case "noteDelete":return runNoteDelete(input,d);
  }
}

/** ---- controller ---- */
export type ControllerDeps={
  /** Routed fetch: reads/receipts go through the shared read queue, writes do not. */
  fetch:typeof fetch;
  online:()=>boolean;
  /** A write committed (or a receipt proved it): the owner re-reads the detail and the lists. */
  onCommitted:(info:{write:WriteKind;deleted:boolean})=>void;
  /** 401/403 on an operation: goes through the shared refusal budget. */
  onRefusal:()=>void;
  /** Hard stop for one operation; after dispatch it becomes `uncertain`. */
  timeoutMs?:number;
};

export function createWriteController(deps:ControllerDeps){
  let state:WriteState=IDLE;
  let seq=0;
  let disposed=false;
  let op:{id:number;controller:AbortController;dispatched:boolean;reconcile:Reconciler|null;timer:ReturnType<typeof setTimeout>|null}|null=null;
  let held:Reconciler|null=null;
  let undoHandle:UndoHandle|null=null;
  const listeners=new Set<()=>void>();
  const set=(next:WriteState)=>{
    if(next===state)return;
    state=next;
    for(const listener of [...listeners])listener();
  };
  const apply=(event:WriteEvent)=>set(writeReducer(state,event));
  const stopTimer=()=>{if(op?.timer){clearTimeout(op.timer);op.timer=null;}};

  async function begin(write:WriteKind,undoing:boolean,exec:(signal:AbortSignal,hooks:ExecHooks)=>Promise<Outcome>){
    if(disposed||!canStartWrite(state))return;
    undoHandle=null; // a new change supersedes the previous Undo
    held=null;
    const id=++seq;
    const controller=new AbortController();
    const current={id,controller,dispatched:false,reconcile:null as Reconciler|null,
      timer:null as ReturnType<typeof setTimeout>|null};
    op=current;
    if(deps.timeoutMs)current.timer=setTimeout(()=>controller.abort(),deps.timeoutMs);
    apply({t:"start",write,undoing});
    const hooks:ExecHooks={onDispatch:reconcile=>{
      if(op!==current)return;
      current.dispatched=true;current.reconcile=reconcile;
      apply({t:"dispatched"});
    }};
    let outcome:Outcome;
    try{outcome=await exec(controller.signal,hooks);}
    catch{outcome=current.dispatched?{t:"uncertain"}:{t:"error",reason:"unavailable"};}
    if(op!==current)return; // reset() or dispose() already took over
    stopTimer();
    op=null;
    // A dispatched write whose result is lost or denied is conservatively uncertain.
    if(current.dispatched&&(outcome.t==="signed-out"||outcome.t==="offline"||outcome.t==="aborted"))
      outcome={t:"uncertain"};
    if(outcome.t==="uncertain"){
      held=current.reconcile;
      apply({t:"settle",outcome:{t:"uncertain"}});
      return;
    }
    if(outcome.t==="signed-out")deps.onRefusal();
    if(outcome.t==="committed"){
      undoHandle=outcome.undo;
      apply({t:"settle",outcome:{t:"committed",undoable:outcome.undo!==null,deleted:outcome.deleted===true}});
      deps.onCommitted({write,deleted:outcome.deleted===true});
      return;
    }
    apply({t:"settle",outcome:outcome as SettleOutcome});
  }

  return {
    getState:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    hasUndo:()=>undoHandle!==null,
    /** Starts one write. Ignored while another is pending or uncertain. */
    async run(input:WriteInput):Promise<void>{
      if(disposed||!canStartWrite(state))return;
      if(!deps.online()){apply({t:"offline-attempt",write:input.kind});return;}
      await begin(input.kind,false,(signal,hooks)=>
        executeWrite(input,{fetch:deps.fetch,signal,hooks}));
    },
    /** Undo of the last committed write; fresh receipt and CAS, never a replay of the old command. */
    async undo():Promise<void>{
      const handle=undoHandle;
      if(disposed||state.kind!=="committed"||!state.undoable||!handle||!deps.online())return;
      await begin(state.write,true,handle);
    },
    /** Receipt-only check of the ORIGINAL command of an uncertain write; never resends. */
    async reconcile():Promise<void>{
      const reconcile=held;
      if(disposed||state.kind!=="uncertain"||state.checking||!reconcile||!deps.online())return;
      const write=state.write;
      const id=++seq;
      const controller=new AbortController();
      const current={id,controller,dispatched:true,reconcile,timer:null as ReturnType<typeof setTimeout>|null};
      op=current;
      if(deps.timeoutMs)current.timer=setTimeout(()=>controller.abort(),deps.timeoutMs);
      apply({t:"check"});
      let result:Reconciled;
      try{result=await reconcile(controller.signal);}catch{result={result:"unknown"};}
      if(op!==current)return;
      stopTimer();
      op=null;
      if(result.result==="committed"){
        held=null;
        undoHandle=result.undo??null;
        apply({t:"checked",result:"committed",undoable:undoHandle!==null,deleted:result.deleted===true});
        deps.onCommitted({write,deleted:result.deleted===true});
        return;
      }
      if(result.result==="signed-out")deps.onRefusal();
      apply({t:"checked",result:result.result});
    },
    /** Generation / scope / session change: feedback and Undo are cleared, a possibly committed
     * write stays reconcilable and its late response is ignored. */
    reset():void{
      if(disposed)return;
      const current=op;
      if(current){
        current.controller.abort();stopTimer();
        if(current.dispatched&&current.reconcile)held=current.reconcile;
        op=null;
      }
      undoHandle=null;
      apply({t:"reset"});
      if(state.kind!=="uncertain")held=null;
    },
    dismiss():void{apply({t:"dismiss"});},
    setOnline(online:boolean):void{if(online)apply({t:"online"});},
    dispose():void{
      disposed=true;
      op?.controller.abort();stopTimer();op=null;held=null;undoHandle=null;listeners.clear();
    },
  };
}
export type WriteController=ReturnType<typeof createWriteController>;
