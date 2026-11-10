"use client";
/** R3-FE-4b: edits inside the authorized detail panel (default-off, own UI flag).
 *
 * One write controller (lib/target-detail-write.ts) drives every edit; this file is the thin
 * React layer: capability probe (the server's read-only preflight decides whether controls
 * exist, never the scope), drafts held in memory only, a persistent live region for
 * pending / committed / conflict / uncertain, Esc cancels the edit before the panel closes,
 * and a confirm step before every delete. */
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from "react";
import {
  createWriteController,type WriteController,type WriteInput,type WriteState,
} from "../../lib/target-detail-write";
import {routeTargetFetch} from "../../lib/target-edit-fetch";
import {emitTargetChange} from "../../lib/target-data-invalidation";
import {
  MAX_NOTE_BODY_BYTES,MAX_TASK_TITLE,readNoteWriteContext,readTaskWriteContext,
} from "../../lib/target-staging-edit-clients";
import {localMyPlanDate} from "../../lib/target-staging-my-plan-client";
import {myPlanWhenTarget,prepareMyPlanWhen} from "../../lib/target-staging-my-plan-when-client";
import {editCopy,type EditCopy} from "../../lib/target-edit-copy";
import {useTargetScope} from "./target-scope-state";
import type {DetailLanguage} from "../../lib/target-detail-copy";
import type {TargetDetailContent} from "../../lib/target-detail-session";
import type {TargetUiEdits} from "../../lib/target-ui-config";
import type {TaskPreview} from "../../lib/target-staging-task-preview-client";
import type {NotePreview} from "../../lib/target-staging-note-preview-client";

export type Capability="off"|"checking"|"writable"|"readonly";
/** Which write families the SERVER currently accepts for the shown item (read-only preflights). */
export type Abilities={context:boolean;when:boolean;/** The actor's current personal date, when the server reported it. */whenOn:string|null};
const NO_ABILITIES:Abilities={context:false,when:false,whenOn:null};
export type EditDraft={
  mode:null|"title"|"note";title:string;body:string;
  /** What the edit started from; a save is refused as a conflict if the item no longer matches it. */
  base:null|{title:string;body:string};
  /** The text of the last save attempt, kept visible if that save hit a conflict. */
  kept:null|{title:string;body:string};
};
export const EMPTY_DRAFT:EditDraft={mode:null,title:"",body:"",base:null,kept:null};

export type DetailEditApi={
  flags:TargetUiEdits;
  copy:EditCopy;
  capability:Capability;
  abilities:Abilities;
  state:WriteState;
  online:boolean;
  draft:EditDraft;
  setDraft:(update:(old:EditDraft)=>EditDraft)=>void;
  run:(input:WriteInput)=>void;
  undo:()=>void;
  reconcile:()=>void;
  dismiss:()=>void;
  deleted:boolean;
  closeAfterDelete:()=>void;
};

const subscribeOnline=(notify:()=>void)=>{
  window.addEventListener("online",notify);
  window.addEventListener("offline",notify);
  return ()=>{window.removeEventListener("online",notify);window.removeEventListener("offline",notify);};
};

/** The edit kinds that exist for this content kind at all (flags only; the server still decides). */
export function kindHasEdits(kind:TargetDetailContent["kind"]|"task"|"note"|"project",flags:TargetUiEdits|undefined):boolean{
  if(!flags)return false;
  if(kind==="task")return flags.taskTitle||flags.taskStatus||flags.taskWhen||flags.taskDelete;
  if(kind==="note")return flags.noteEdit||flags.noteDelete;
  return false;
}

export function useDetailEdits(params:{
  route:{kind:"task"|"project"|"note";id:string};
  language:DetailLanguage;
  edits:TargetUiEdits|undefined;
  content:TargetDetailContent|null;
  /** The identity of the current read session: a new one means a new detail generation. */
  sessionKey:unknown;
  /** Content is removed (hidden, offline, signed out, stale ...). */
  removed:null|string;
  readFetch:typeof fetch;
  onRefusal:()=>void;
  revalidate:()=>void;
  onDeleted:()=>void;
  onClose:()=>void;
}):DetailEditApi|null{
  const {route,language,edits,content,sessionKey,removed,readFetch}=params;
  const enabled=kindHasEdits(route.kind,edits);
  const flags=edits??NO_EDITS;
  const copy=editCopy[language];
  const live=useRef(params);
  live.current=params;
  const routed=useMemo(()=>routeTargetFetch(readFetch,(input,init)=>fetch(input,init)),[readFetch]);
  const [controller]=useState<WriteController>(()=>createWriteController({
    fetch:(input,init)=>routed(input,init),
    online:()=>typeof navigator==="undefined"||navigator.onLine,
    onRefusal:()=>live.current.onRefusal(),
    onCommitted:info=>{
      const current=live.current;
      // The open detail is queued FIRST (the user is looking at it); the lists follow.
      if(info.deleted)current.onDeleted();
      else current.revalidate();
      emitTargetChange({
        kind:current.route.kind==="note"?"note":"task",id:current.route.id,
        change:info.deleted?"deleted":"updated",
      });
    },
    timeoutMs:30_000,
  }));
  const state=useSyncExternalStore(controller.subscribe,controller.getState,controller.getState);
  const online=useSyncExternalStore(subscribeOnline,()=>navigator.onLine,()=>true);
  const [draft,setDraftState]=useState<EditDraft>(EMPTY_DRAFT);
  const [capability,setCapability]=useState<Capability>("off");
  const [abilities,setAbilities]=useState<Abilities>(NO_ABILITIES);
  // Positive writer proof applies only to the exact detail response that was probed.
  // This also hides stale controls synchronously on a new read, before effects run.
  const [verifiedContent,setVerifiedContent]=useState<TargetDetailContent|null>(null);
  const currentContent=enabled&&content&&(content.kind==="task"||content.kind==="note");
  const checked=verifiedContent===content&&currentContent;
  const shownCapability:Capability=checked?capability:currentContent?"checking":"off";
  const shownAbilities=checked?abilities:NO_ABILITIES;

  // New detail generation / scope / session: feedback and Undo are cleared; a possibly committed
  // write stays reconcilable. The unmount does the same and ignores any late response.
  // The reading scope is part of the generation here (as for the R3-FE-3 feedback rules): changing
  // it clears Undo and settled feedback, but never a write that may already have committed.
  const scope=useTargetScope();
  useEffect(()=>{controller.reset();},[controller,sessionKey,scope]);
  useEffect(()=>()=>{controller.reset();},[controller]);
  useEffect(()=>{controller.setOnline(online);},[controller,online]);
  // Content removed (hidden/offline/stale/signed out): nothing stays on screen, Undo is gone.
  // Drafts survive a mere hide/offline (own text, memory only) but not a loss of access.
  useEffect(()=>{
    if(removed===null)return;
    controller.reset();
    if(removed!=="hidden"&&removed!=="offline")setDraftState(EMPTY_DRAFT);
  },[controller,removed]);

  // The server decides editability: a read-only preflight per write family and loaded content.
  // A refusal means read-only (viewer, revoked, moved); a failure means no controls. Never
  // derived from scope, Area kind or any guess about the role.
  useEffect(()=>{
    if(!enabled||!content||(content.kind!=="task"&&content.kind!=="note")){
      setVerifiedContent(null);setCapability("off");setAbilities(NO_ABILITIES);return;
    }
    const abort=new AbortController();
    setVerifiedContent(null);setAbilities(NO_ABILITIES);setCapability("checking");
    const probes:Promise<{context:boolean;when:boolean;signedOut:boolean;whenOn:string|null}>[]=[];
    const signal=abort.signal;
    const outcome=(kind:"context"|"when",whenOn:string|null=null)=>(r:{ok:boolean;reason?:string})=>({
      context:kind==="context"&&r.ok,when:kind==="when"&&r.ok,signedOut:r.reason==="signed-out",whenOn,
    });
    if(content.kind==="task"){
      const task=content.task;
      if(flags.taskTitle||flags.taskStatus||flags.taskDelete)
        probes.push(readTaskWriteContext(task.id,task.areaId,routed,signal).then(outcome("context")));
      if(flags.taskWhen&&(task.areaKind==="private"||task.assignedToMe===true))
        probes.push(prepareMyPlanWhen({taskId:task.id,areaId:task.areaId,whenOn:"2000-01-01",signal},routed)
          .then(r=>outcome("when",r.ok===true?r.previousWhenOn:null)(
            r.ok===false?{ok:r.reason==="unchanged",reason:r.reason}:{ok:true})));
    }else probes.push(readNoteWriteContext(content.note.id,content.note.areaId,routed,signal).then(outcome("context")));
    void Promise.all(probes).then(results=>{
      if(signal.aborted)return;
      if(results.some(r=>r.signedOut))live.current.onRefusal();
      const next={context:results.some(r=>r.context),when:results.some(r=>r.when),
        whenOn:results.find(r=>r.when)?.whenOn??null};
      setAbilities(next);
      setCapability(next.context||next.when?"writable":"readonly");
      setVerifiedContent(content);
    }).catch(()=>{if(!signal.aborted){setAbilities(NO_ABILITIES);setCapability("readonly");setVerifiedContent(content);}});
    return ()=>abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[enabled,content,routed,flags.taskTitle,flags.taskStatus,flags.taskDelete,flags.taskWhen]);

  // Conflict: reload the authorized detail (the user's text stays visible in the draft);
  // commit of a title/note edit closes the editor.
  useEffect(()=>{
    if(state.kind==="conflict")live.current.revalidate();
    if(state.kind==="committed"&&(state.write==="taskTitle"||state.write==="noteEdit"))
      setDraftState(EMPTY_DRAFT);
    if(state.kind==="conflict"&&(state.write==="taskTitle"||state.write==="noteEdit"))
      setDraftState(old=>({...old,mode:null}));
  },[state]);

  const setDraft=useCallback((update:(old:EditDraft)=>EditDraft)=>setDraftState(update),[]);
  const run=useCallback((input:WriteInput)=>{void controller.run(input);},[controller]);
  const api=useMemo<DetailEditApi>(()=>({
    flags,copy,capability:shownCapability,abilities:shownAbilities,state,online,draft,setDraft,run,
    undo:()=>{void controller.undo();},
    reconcile:()=>{void controller.reconcile();},
    dismiss:()=>controller.dismiss(),
    deleted:state.kind==="committed"&&state.deleted,
    closeAfterDelete:()=>live.current.onClose(),
  }),[flags,copy,shownCapability,shownAbilities,state,online,draft,setDraft,run,controller]);
  return enabled?api:null;
}
const NO_EDITS:TargetUiEdits={
  taskTitle:false,taskStatus:false,taskWhen:false,taskDelete:false,noteEdit:false,noteDelete:false,
};

const busy=(state:WriteState)=>state.kind==="pending"||state.kind==="uncertain";

function Feedback({api}:{api:DetailEditApi}){
  const {copy,state,online}=api;
  let polite="";
  let alert="";
  if(state.kind==="pending")polite=copy.pending[state.write];
  else if(state.kind==="committed")polite=state.deleted?"":(state.undone?copy.undone[state.write]:copy.committed[state.write]);
  else if(state.kind==="offline")alert=copy.offlineBlocked;
  else if(state.kind==="conflict")alert=copy.conflict;
  else if(state.kind==="uncertain")
    alert=state.checking?copy.uncertainChecking:state.notRecorded?copy.uncertainNotRecorded:copy.uncertain;
  else if(state.kind==="error")alert=copy.errors[state.reason];
  else if(!online)polite=copy.offline;
  return <div className="targetDetailEditFeedback" data-testid="target-detail-edit-feedback"
    data-write-state={state.kind}>
    <p role="status" aria-live="polite" data-testid="target-detail-edit-status">{polite}</p>
    {alert&&<p role="alert" data-testid="target-detail-edit-alert">{alert}</p>}
    {state.kind==="uncertain"&&<p className="targetDetailMuted">{copy.uncertainBlocked}</p>}
    <div className="targetDetailEditActions">
      {state.kind==="committed"&&state.undoable&&
        <button type="button" data-testid="target-detail-edit-undo" disabled={!online}
          onClick={api.undo}>{copy.undo}</button>}
      {state.kind==="uncertain"&&
        <button type="button" data-testid="target-detail-edit-check"
          disabled={state.checking||!online} onClick={api.reconcile}>
          {state.checking?copy.uncertainChecking:copy.uncertainCheck}</button>}
      {(state.kind==="committed"||state.kind==="error"||state.kind==="offline"||(state.kind==="conflict"&&!api.draft.kept))&&
        <button type="button" data-testid="target-detail-edit-dismiss"
          onClick={api.dismiss}>{copy.dismiss}</button>}
    </div>
  </div>;
}

/** Esc leaves the edit / confirm before the panel (the shell ignores a prevented Escape). */
function escapeTo(handler:()=>void){
  return (event:React.KeyboardEvent)=>{
    if(event.key!=="Escape")return;
    event.preventDefault();
    event.stopPropagation();
    handler();
  };
}

const utf8=(text:string)=>new TextEncoder().encode(text).length;

function ConflictKept({api,kind,current}:{
  api:DetailEditApi;kind:"title"|"note";
  /** The freshly reloaded item: a re-edit starts from it. */
  current:{title:string;body:string};
}){
  const {copy,draft}=api;
  if(api.state.kind!=="conflict"||!draft.kept)return null;
  const kept=draft.kept;
  return <section className="targetDetailEditConflict" aria-label={copy.conflictDraft}
    data-testid="target-detail-edit-conflict">
    <p>{copy.conflictDraft}</p>
    <textarea readOnly rows={kind==="note"?6:2} aria-label={copy.conflictDraft}
      data-testid="target-detail-edit-kept" value={kind==="note"?kept.title+"\n\n"+kept.body:kept.title}/>
    <div className="targetDetailEditActions">
      <button type="button" data-testid="target-detail-edit-reuse" onClick={()=>{
        api.setDraft(old=>({mode:kind,title:kept.title,body:kept.body,base:current,kept:old.kept}));
        api.dismiss();
      }}>{copy.conflictReuse}</button>
      <button type="button" data-testid="target-detail-edit-discard" onClick={()=>{
        api.setDraft(()=>EMPTY_DRAFT);
        api.dismiss();
      }}>{copy.conflictDiscard}</button>
    </div>
  </section>;
}

/** Inline delete with an explicit confirm step; the safe choice (cancel) has the focus. */
function DeleteControl({api,label,confirmText,onDelete}:{
  api:DetailEditApi;label:string;confirmText:string;onDelete:()=>void;
}){
  const {copy}=api;
  const [asking,setAsking]=useState(false);
  const trigger=useRef<HTMLButtonElement|null>(null);
  const cancel=useRef<HTMLButtonElement|null>(null);
  const [restore,setRestore]=useState(false);
  useEffect(()=>{
    if(asking)cancel.current?.focus();
    else if(restore){trigger.current?.focus();setRestore(false);}
  },[asking,restore]);
  const close=()=>{setAsking(false);setRestore(true);};
  const off=busy(api.state)||!api.online;
  if(!asking)
    return <button type="button" ref={trigger} className="targetDetailEditDanger"
      data-testid="target-detail-edit-delete" disabled={off} onClick={()=>setAsking(true)}>{label}</button>;
  return <div role="group" aria-label={confirmText} className="targetDetailEditConfirm"
    data-testid="target-detail-edit-confirm" onKeyDown={escapeTo(close)}>
    <p>{confirmText}</p>
    <div className="targetDetailEditActions">
      <button type="button" ref={cancel} data-testid="target-detail-edit-confirm-cancel"
        onClick={close}>{copy.confirmCancel}</button>
      <button type="button" className="targetDetailEditDanger" data-testid="target-detail-edit-confirm-yes"
        disabled={off} onClick={()=>{setAsking(false);onDelete();}}>{copy.confirmDelete}</button>
    </div>
  </div>;
}

function TitleEditor({api,task}:{api:DetailEditApi;task:TaskPreview}){
  const {copy,draft,state}=api;
  const [problem,setProblem]=useState<string|null>(null);
  const input=useRef<HTMLInputElement|null>(null);
  const trigger=useRef<HTMLButtonElement|null>(null);
  const wasEditing=useRef(false);
  const editing=draft.mode==="title";
  useEffect(()=>{
    if(editing)input.current?.focus();
    else if(wasEditing.current&&state.kind!=="conflict")trigger.current?.focus();
    wasEditing.current=editing;
  },[editing,state.kind]);
  const off=busy(state)||!api.online;
  if(!editing)
    return <button type="button" ref={trigger} data-testid="target-detail-edit-title"
      disabled={off} onClick={()=>{
        setProblem(null);
        api.setDraft(old=>({...old,mode:"title",title:old.kept?.title??task.title,
          base:{title:task.title,body:""}}));
      }}>{copy.editTitle}</button>;
  const save=()=>{
    const next=draft.title.trim();
    if(next.length===0){setProblem(copy.titleEmpty);return;}
    if(next.length>MAX_TASK_TITLE){setProblem(copy.titleTooLong);return;}
    if(next===(draft.base?.title??task.title)){setProblem(null);api.setDraft(()=>EMPTY_DRAFT);return;}
    setProblem(null);
    api.setDraft(old=>({...old,title:next,kept:{title:next,body:""}}));
    api.run({kind:"taskTitle",taskId:task.id,areaId:task.areaId,title:next,
      baseTitle:draft.base?.title??task.title});
  };
  const cancel=()=>{setProblem(null);api.setDraft(()=>EMPTY_DRAFT);};
  return <form className="targetDetailEditForm" data-testid="target-detail-edit-title-form"
    onSubmit={event=>{event.preventDefault();save();}} onKeyDown={escapeTo(cancel)}>
    <label>{copy.titleLabel}
      <input ref={input} type="text" value={draft.title} data-testid="target-detail-edit-title-input"
        maxLength={MAX_TASK_TITLE+1} aria-invalid={problem!==null} aria-describedby={problem?"edit-title-problem":undefined}
        disabled={off} onChange={event=>{setProblem(null);const value=event.target.value;
          api.setDraft(old=>({...old,title:value}));}}/>
    </label>
    {problem&&<p id="edit-title-problem" role="alert" data-testid="target-detail-edit-problem">{problem}</p>}
    <div className="targetDetailEditActions">
      <button type="submit" disabled={off} data-testid="target-detail-edit-save">{copy.save}</button>
      <button type="button" data-testid="target-detail-edit-cancel" disabled={state.kind==="pending"}
        onClick={cancel}>{copy.cancel}</button>
    </div>
  </form>;
}

export function TaskEdits({api,task}:{api:DetailEditApi;task:TaskPreview}){
  const {copy,capability,abilities,state,online}=api;
  const flags={
    ...api.flags,
    taskTitle:api.flags.taskTitle&&abilities.context,taskStatus:api.flags.taskStatus&&abilities.context,
    taskDelete:api.flags.taskDelete&&abilities.context,taskWhen:api.flags.taskWhen&&abilities.when,
  };
  if(api.deleted)
    return <DeletedNotice api={api} text={copy.deletedTask}/>;
  if(capability==="checking"||capability==="off")
    return <p className="targetDetailMuted" role="status" data-testid="target-detail-edit-checking">{copy.checking}</p>;
  if(capability==="readonly")
    return <p className="targetDetailMuted" data-testid="target-detail-edit-readonly">{copy.readOnly}</p>;
  const off=busy(state)||!online;
  const when=flags.taskWhen&&(task.areaKind==="private"||task.assignedToMe===true);
  const today=localMyPlanDate();
  const whenButton=(choice:"today"|"tomorrow",label:string)=>
    myPlanWhenTarget(today,choice)===abilities.whenOn?null:<button type="button" data-testid={`target-detail-edit-when-${choice}`} disabled={off}
      onClick={()=>{
        const target=myPlanWhenTarget(today,choice);
        if(target!==null)api.run({kind:"taskWhen",taskId:task.id,areaId:task.areaId,whenOn:target});
      }}>{label}</button>;
  return <div className="targetDetailEdit" data-testid="target-detail-edit">
    {!(state.kind==="conflict"&&api.draft.kept)&&<div className="targetDetailEditRow">
      {flags.taskTitle&&<TitleEditor api={api} task={task}/>}
      {flags.taskStatus&&<button type="button" data-testid="target-detail-edit-status-toggle" disabled={off}
        onClick={()=>api.run({kind:"taskStatus",taskId:task.id,areaId:task.areaId,
          status:task.status==="completed"?"open":"completed"})}>
        {task.status==="completed"?copy.restore:copy.complete}</button>}
    </div>}
    {when&&<div className="targetDetailEditRow" role="group" aria-label={copy.whenGroup}>
      <span className="targetDetailEditLabel" aria-hidden="true">{copy.whenGroup}:</span>
      {whenButton("today",copy.whenToday)}{whenButton("tomorrow",copy.whenTomorrow)}
    </div>}
    <ConflictKept api={api} kind="title" current={{title:task.title,body:""}}/>
    {flags.taskDelete&&<DeleteControl api={api} label={copy.deleteTask}
      confirmText={copy.confirmDeleteTask(task.title)}
      onDelete={()=>api.run({kind:"taskDelete",taskId:task.id,areaId:task.areaId,base:task})}/>}
    <Feedback api={api}/>
  </div>;
}

function DeletedNotice({api,text}:{api:DetailEditApi;text:string}){
  const ref=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{ref.current?.focus();},[]);
  return <div className="targetDetailEdit" data-testid="target-detail-edit-deleted">
    <p role="status">{text}</p>
    <button type="button" ref={ref} onClick={api.closeAfterDelete}>{api.copy.closeAfterDelete}</button>
  </div>;
}

function NoteEditor({api,note}:{api:DetailEditApi;note:NotePreview}){
  const {copy,draft,state}=api;
  const [problem,setProblem]=useState<string|null>(null);
  const first=useRef<HTMLInputElement|null>(null);
  const trigger=useRef<HTMLButtonElement|null>(null);
  const wasEditing=useRef(false);
  const editing=draft.mode==="note";
  useEffect(()=>{
    if(editing)first.current?.focus();
    else if(wasEditing.current&&state.kind!=="conflict")trigger.current?.focus();
    wasEditing.current=editing;
  },[editing,state.kind]);
  const off=busy(state)||!api.online;
  if(!editing)
    return <button type="button" ref={trigger} data-testid="target-detail-edit-note" disabled={off}
      onClick={()=>{
        setProblem(null);
        api.setDraft(old=>({...old,mode:"note",title:old.kept?.title??note.title,body:old.kept?.body??note.body,
          base:{title:note.title,body:note.body}}));
      }}>{copy.editNote}</button>;
  const save=()=>{
    const title=draft.title.trim();
    if(title.length===0){setProblem(copy.titleEmpty);return;}
    if(utf8(title)>4096){setProblem(copy.titleTooLong);return;}
    if(utf8(draft.body)>MAX_NOTE_BODY_BYTES){setProblem(copy.bodyTooLong);return;}
    const base=draft.base??{title:note.title,body:note.body};
    if(title===base.title&&draft.body===base.body){setProblem(null);api.setDraft(()=>EMPTY_DRAFT);return;}
    setProblem(null);
    api.setDraft(old=>({...old,title,kept:{title,body:old.body}}));
    api.run({kind:"noteEdit",noteId:note.id,areaId:note.areaId,title,body:draft.body,
      baseTitle:base.title,baseBody:base.body});
  };
  const cancel=()=>{setProblem(null);api.setDraft(()=>EMPTY_DRAFT);};
  return <form className="targetDetailEditForm" data-testid="target-detail-edit-note-form"
    onSubmit={event=>{event.preventDefault();save();}} onKeyDown={escapeTo(cancel)}>
    <label>{copy.titleLabel}
      <input ref={first} type="text" value={draft.title} data-testid="target-detail-edit-note-title"
        aria-invalid={problem!==null} disabled={off}
        onChange={event=>{setProblem(null);const value=event.target.value;api.setDraft(old=>({...old,title:value}));}}/>
    </label>
    <label>{copy.bodyLabel}
      <textarea rows={8} value={draft.body} data-testid="target-detail-edit-note-body" disabled={off}
        onChange={event=>{setProblem(null);const value=event.target.value;api.setDraft(old=>({...old,body:value}));}}/>
    </label>
    {problem&&<p role="alert" data-testid="target-detail-edit-problem">{problem}</p>}
    <div className="targetDetailEditActions">
      <button type="submit" disabled={off} data-testid="target-detail-edit-save">{copy.save}</button>
      <button type="button" data-testid="target-detail-edit-cancel" disabled={state.kind==="pending"}
        onClick={cancel}>{copy.cancel}</button>
    </div>
  </form>;
}

export function NoteEdits({api,note}:{api:DetailEditApi;note:NotePreview}){
  const {copy,capability,state}=api;
  const flags={...api.flags,noteEdit:api.flags.noteEdit&&api.abilities.context,noteDelete:api.flags.noteDelete&&api.abilities.context};
  if(api.deleted)return <DeletedNotice api={api} text={copy.deletedNote}/>;
  if(capability==="checking"||capability==="off")
    return <p className="targetDetailMuted" role="status" data-testid="target-detail-edit-checking">{copy.checking}</p>;
  if(capability==="readonly")
    return <p className="targetDetailMuted" data-testid="target-detail-edit-readonly">{copy.readOnly}</p>;
  return <div className="targetDetailEdit" data-testid="target-detail-edit">
    {flags.noteEdit&&!(state.kind==="conflict"&&api.draft.kept)&&<div className="targetDetailEditRow"><NoteEditor api={api} note={note}/></div>}
    <ConflictKept api={api} kind="note" current={{title:note.title,body:note.body}}/>
    {flags.noteDelete&&<DeleteControl api={api} label={copy.deleteNote}
      confirmText={copy.confirmDeleteNote(note.title)}
      onDelete={()=>api.run({kind:"noteDelete",noteId:note.id,areaId:note.areaId,base:note})}/>}
    <Feedback api={api}/>
  </div>;
}
