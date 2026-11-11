/** R3-FE-4b: strict transports for the edits inside the authorized detail:
 * task title, task delete, note title/body edit, note delete, and the read-only
 * write-context preflights that supply CAS revision, Area and restore generation.
 *
 * The server stays the only authority (identity, Area ACL, CAS, restore barrier).
 * Nothing here is permission: a parsed preflight only means "the server just answered".
 * Each write is dispatched EXACTLY ONCE; every ambiguous outcome is confirmed through
 * the read-only receipt of the very same command and never resent automatically. */

export type EditFailure=
  |"signed-out"|"conflict"|"not-available"|"rate-limited"|"unavailable"
  |"invalid-response"|"invalid-request"|"offline"|"aborted";

export type WriteContext={expectedRevision:string;writeAreaId:string;restoreGeneration:string};
export type ContextResult={ok:true;context:WriteContext}|{ok:false;reason:EditFailure};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revision=/^[a-f0-9]{64}$/;
const areaRule=/^[A-Za-z0-9_.:@-]{1,120}$/;
const control=/[\u0000-\u001f\u007f]/u;
export const MAX_TASK_TITLE=4096;
export const MAX_NOTE_TITLE_BYTES=4096;
export const MAX_NOTE_BODY_BYTES=131072;
const encoder=new TextEncoder();
const object=(value:unknown):value is Record<string,unknown>=>
  value!==null&&typeof value==="object"&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:readonly string[]):boolean=>
  Object.keys(value).sort().join("|")===keys.slice().sort().join("|");
const shape=(value:unknown,keys:readonly string[]):boolean=>object(value)&&exact(value,keys);
function wellFormed(text:string):boolean{
  try{return decodeURIComponent(encodeURIComponent(text))===text;}catch{return false;}
}
/** The same item-ID rule the strict detail readers and the write routes share. */
export function validEditId(value:unknown):value is string{
  return typeof value==="string"&&value.length>0&&value.trim()===value&&
    value!=="."&&value!==".."&&!value.includes("/")&&!value.includes("\\")&&
    !control.test(value)&&wellFormed(value)&&encoder.encode(value).length<=512;
}
export const validEditCommandId=(value:unknown):value is string=>
  typeof value==="string"&&uuid.test(value);
/** Temporal task writers use a restricted Area ID; note writers instead accept canonical
 * note/Area IDs up to 512 UTF-8 bytes, including whitespace inside and Unicode. */
export const validEditAreaId=(value:unknown):value is string=>
  typeof value==="string"&&areaRule.test(value);
export const validNoteEditAreaId=(value:unknown):value is string=>
  typeof value==="string"&&value.length>0&&value.trim()===value&&
    value!=="."&&value!==".."&&!control.test(value)&&wellFormed(value)&&
    encoder.encode(value).length<=512;

export function validWriteContext(value:unknown,kind:"task"|"note"="task"):value is WriteContext{
  return object(value)&&exact(value,["expectedRevision","writeAreaId","restoreGeneration"])&&
    typeof value.expectedRevision==="string"&&revision.test(value.expectedRevision)&&
    (kind==="note"?validNoteEditAreaId(value.writeAreaId):validEditAreaId(value.writeAreaId))&&
    typeof value.restoreGeneration==="string"&&uuid.test(value.restoreGeneration);
}

/** Task title as the route accepts it: trimmed, non-empty, at most 4096 UTF-16 units. */
export function validTaskTitle(value:unknown):value is string{
  return typeof value==="string"&&value.length>0&&value.length<=MAX_TASK_TITLE&&
    value.trim()===value&&!value.includes("\0")&&wellFormed(value);
}
export function validNoteTitle(value:unknown):value is string{
  return typeof value==="string"&&value.trim().length>0&&!value.includes("\0")&&
    wellFormed(value)&&encoder.encode(value).length<=MAX_NOTE_TITLE_BYTES;
}
export function validNoteBody(value:unknown):value is string{
  return typeof value==="string"&&!value.includes("\0")&&wellFormed(value)&&
    encoder.encode(value).length<=MAX_NOTE_BODY_BYTES;
}

function safeResponse(response:Response):boolean{
  return !response.redirected&&
    response.headers.get("cache-control")?.toLowerCase().includes("no-store")===true&&
    response.headers.get("content-type")?.toLowerCase().includes("application/json")===true;
}
function failureFor(status:number):EditFailure{
  if(status===401||status===403)return "signed-out";
  if(status===409)return "conflict";
  if(status===404)return "not-available"; // missing, foreign, viewer and disabled are one answer
  if(status===429)return "rate-limited";
  if(status===400)return "invalid-request";
  return "unavailable";
}

const readOptions=(signal?:AbortSignal):RequestInit=>({
  method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",
  headers:{accept:"application/json"},signal,
});
const writeOptions=(method:"PATCH"|"POST"|"DELETE",body:unknown,signal?:AbortSignal):RequestInit=>({
  method,credentials:"same-origin",cache:"no-store",redirect:"error",
  headers:{
    accept:"application/json","content-type":"application/json",
    "x-lumi-target-protocol":"1",
  },body:JSON.stringify(body),signal,
});

/** Read-only preflight. The Area equality check is a stale-page guard, not authorization. */
export async function readWriteContext(
  url:string,areaId:string,fetchImpl:typeof fetch=fetch,signal?:AbortSignal,
  kind:"task"|"note"="task",
):Promise<ContextResult>{
  if(!(kind==="note"?validNoteEditAreaId(areaId):validEditAreaId(areaId)))return {ok:false,reason:"invalid-request"};
  if(signal?.aborted)return {ok:false,reason:"aborted"};
  let response:Response;
  try{response=await fetchImpl(url,readOptions(signal));}
  catch{return {ok:false,reason:signal?.aborted?"aborted":"offline"};}
  if(signal?.aborted)return {ok:false,reason:"aborted"};
  if(response.status!==200)return {ok:false,reason:failureFor(response.status)};
  if(!safeResponse(response))return {ok:false,reason:"invalid-response"};
  try{
    const body:unknown=await response.json();
    if(signal?.aborted)return {ok:false,reason:"aborted"};
    if(!validWriteContext(body,kind))return {ok:false,reason:"invalid-response"};
    // A different Area than the one on screen means the page is stale: refuse as a conflict.
    if(body.writeAreaId!==areaId)return {ok:false,reason:"conflict"};
    return {ok:true,context:body};
  }catch{return {ok:false,reason:signal?.aborted?"aborted":"invalid-response"};}
}

/** Task title / status / delete share one preflight (the title CAS token, see
 * lib/target-task-write-preflight.ts). */
export const readTaskWriteContext=(
  taskId:string,areaId:string,fetchImpl:typeof fetch=fetch,signal?:AbortSignal,
):Promise<ContextResult>=>validEditId(taskId)
  ?readWriteContext(
    "/api/target-staging/task-temporal/status?"+new URLSearchParams({taskId}),areaId,fetchImpl,signal)
  :Promise.resolve({ok:false,reason:"invalid-request"});
export const readNoteWriteContext=(
  noteId:string,areaId:string,fetchImpl:typeof fetch=fetch,signal?:AbortSignal,
):Promise<ContextResult>=>validEditId(noteId)
  ?readWriteContext(
    "/api/target-staging/notes/"+encodeURIComponent(noteId)+"/edit",areaId,fetchImpl,signal,"note")
  :Promise.resolve({ok:false,reason:"invalid-request"});

export type EditReceipt=
  |{kind:"committed"|"not-recorded"}
  |{kind:"unknown";reason:EditFailure};
export type EditDispatch<Command>=
  |{kind:"committed";command:Command;replayed:boolean}
  |{kind:"uncertain";command:Command}
  |{kind:"rejected";reason:EditFailure};

type Transport<Command>={
  valid:(command:Command)=>boolean;
  method:"PATCH"|"POST"|"DELETE";
  url:(command:Command)=>string;
  receiptUrl:(command:Command)=>string;
  /** The exact JSON body (the path carries the item ID, never the body). */
  body:(command:Command)=>Record<string,unknown>;
};

/** Receipt is read-only even though it uses POST. 'not_recorded' is never proof that a
 * concurrent write did not or will not commit. */
async function checkReceipt<Command>(
  transport:Transport<Command>,command:Command,fetchImpl:typeof fetch,signal?:AbortSignal,
):Promise<EditReceipt>{
  if(!transport.valid(command))return {kind:"unknown",reason:"invalid-request"};
  if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
  let response:Response;
  try{
    response=await fetchImpl(transport.receiptUrl(command),
      writeOptions("POST",transport.body(command),signal));
  }catch{return {kind:"unknown",reason:signal?.aborted?"aborted":"offline"};}
  if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
  if(response.status!==200)return {kind:"unknown",reason:failureFor(response.status)};
  if(!safeResponse(response))return {kind:"unknown",reason:"invalid-response"};
  try{
    const body:unknown=await response.json();
    if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
    if(!object(body)||!exact(body,["status"]))return {kind:"unknown",reason:"invalid-response"};
    if(body.status==="committed")return {kind:"committed"};
    if(body.status==="not_recorded")return {kind:"not-recorded"};
    return {kind:"unknown",reason:"invalid-response"};
  }catch{return {kind:"unknown",reason:signal?.aborted?"aborted":"invalid-response"};}
}

/** Exactly ONE dispatch. Only 400/409/429 are definitive pre-commit refusals; a late 401, 404,
 * 5xx, a lost connection or an unparsable success may follow a real commit, so they are
 * confirmed through the original receipt and, if that cannot prove a commit, stay uncertain. */
async function dispatch<Command>(
  transport:Transport<Command>,command:Command,fetchImpl:typeof fetch,signal?:AbortSignal,
  onDispatch?:()=>void,
):Promise<EditDispatch<Command>>{
  if(!transport.valid(command))return {kind:"rejected",reason:"invalid-request"};
  if(signal?.aborted)return {kind:"rejected",reason:"aborted"};
  let response:Response|undefined;
  onDispatch?.();
  try{
    response=await fetchImpl(transport.url(command),
      writeOptions(transport.method,transport.body(command),signal));
  }catch{/* A network interruption cannot establish whether the writer committed. */}
  if(signal?.aborted)return {kind:"uncertain",command};
  if(response){
    if(response.status===400||response.status===409||response.status===429)
      return {kind:"rejected",reason:failureFor(response.status)};
    if(response.status===200&&safeResponse(response)){
      try{
        const body:unknown=await response.json();
        if(signal?.aborted)return {kind:"uncertain",command};
        if(object(body)&&(exact(body,["ok"])||exact(body,["ok","replayed"]))&&body.ok===true&&
          (!("replayed" in body)||body.replayed===true))
          return {kind:"committed",command,replayed:"replayed" in body};
      }catch{/* A malformed success may still follow a real commit. */}
    }
  }
  const receipt=await checkReceipt(transport,command,fetchImpl,signal);
  return receipt.kind==="committed"
    ?{kind:"committed",command,replayed:false}:{kind:"uncertain",command};
}

export type TaskTitleCommand=WriteContext&{commandId:string;taskId:string;title:string};
const titleTransport:Transport<TaskTitleCommand>={
  valid:c=>shape(c,["commandId","taskId","title","expectedRevision","writeAreaId","restoreGeneration"])&&
    validEditCommandId(c.commandId)&&validEditId(c.taskId)&&validTaskTitle(c.title)&&validWriteContext(
      {expectedRevision:c.expectedRevision,writeAreaId:c.writeAreaId,restoreGeneration:c.restoreGeneration}),
  method:"PATCH",
  url:c=>"/api/target-staging/tasks/"+encodeURIComponent(c.taskId)+"/title",
  receiptUrl:c=>"/api/target-staging/tasks/"+encodeURIComponent(c.taskId)+"/title/status",
  body:c=>({commandId:c.commandId,title:c.title,expectedRevision:c.expectedRevision,
    writeAreaId:c.writeAreaId,restoreGeneration:c.restoreGeneration}),
};
export const buildTaskTitleCommand=(
  taskId:string,title:string,context:WriteContext,commandId:string=crypto.randomUUID(),
):TaskTitleCommand|null=>{
  const command={commandId,taskId,title,...context};
  return titleTransport.valid(command)?command:null;
};
export const dispatchTaskTitle=(command:TaskTitleCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal,onDispatch?:()=>void)=>dispatch(titleTransport,command,fetchImpl,signal,onDispatch);
export const checkTaskTitleReceipt=(command:TaskTitleCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal)=>checkReceipt(titleTransport,command,fetchImpl,signal);

export type TaskDeleteCommand=WriteContext&{commandId:string;taskId:string};
const taskDeleteTransport:Transport<TaskDeleteCommand>={
  valid:c=>shape(c,["commandId","taskId","expectedRevision","writeAreaId","restoreGeneration"])&&
    validEditCommandId(c.commandId)&&validEditId(c.taskId)&&validWriteContext(
      {expectedRevision:c.expectedRevision,writeAreaId:c.writeAreaId,restoreGeneration:c.restoreGeneration}),
  method:"POST",
  url:c=>"/api/target-staging/tasks/"+encodeURIComponent(c.taskId)+"/delete",
  receiptUrl:c=>"/api/target-staging/tasks/"+encodeURIComponent(c.taskId)+"/delete/status",
  body:c=>({commandId:c.commandId,expectedRevision:c.expectedRevision,
    writeAreaId:c.writeAreaId,restoreGeneration:c.restoreGeneration}),
};
export const buildTaskDeleteCommand=(
  taskId:string,context:WriteContext,commandId:string=crypto.randomUUID(),
):TaskDeleteCommand|null=>{
  const command={commandId,taskId,...context};
  return taskDeleteTransport.valid(command)?command:null;
};
export const dispatchTaskDelete=(command:TaskDeleteCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal,onDispatch?:()=>void)=>dispatch(taskDeleteTransport,command,fetchImpl,signal,onDispatch);
export const checkTaskDeleteReceipt=(command:TaskDeleteCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal)=>checkReceipt(taskDeleteTransport,command,fetchImpl,signal);

export type NoteEditCommand=WriteContext&{commandId:string;noteId:string;title:string;body:string};
const noteEditTransport:Transport<NoteEditCommand>={
  valid:c=>shape(c,["commandId","noteId","title","body","expectedRevision","writeAreaId","restoreGeneration"])&&
    validEditCommandId(c.commandId)&&validEditId(c.noteId)&&validNoteTitle(c.title)&&validNoteBody(c.body)&&
    validWriteContext(
      {expectedRevision:c.expectedRevision,writeAreaId:c.writeAreaId,restoreGeneration:c.restoreGeneration},"note"),
  method:"PATCH",
  url:c=>"/api/target-staging/notes/"+encodeURIComponent(c.noteId)+"/edit",
  receiptUrl:c=>"/api/target-staging/notes/"+encodeURIComponent(c.noteId)+"/edit/status",
  body:c=>({commandId:c.commandId,title:c.title,body:c.body,expectedRevision:c.expectedRevision,
    writeAreaId:c.writeAreaId,restoreGeneration:c.restoreGeneration}),
};
export const buildNoteEditCommand=(
  noteId:string,title:string,body:string,context:WriteContext,commandId:string=crypto.randomUUID(),
):NoteEditCommand|null=>{
  const command={commandId,noteId,title,body,...context};
  return noteEditTransport.valid(command)?command:null;
};
export const dispatchNoteEdit=(command:NoteEditCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal,onDispatch?:()=>void)=>dispatch(noteEditTransport,command,fetchImpl,signal,onDispatch);
export const checkNoteEditReceipt=(command:NoteEditCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal)=>checkReceipt(noteEditTransport,command,fetchImpl,signal);

export type NoteDeleteCommand=WriteContext&{commandId:string;noteId:string};
const noteDeleteTransport:Transport<NoteDeleteCommand>={
  valid:c=>shape(c,["commandId","noteId","expectedRevision","writeAreaId","restoreGeneration"])&&
    validEditCommandId(c.commandId)&&validEditId(c.noteId)&&validWriteContext(
      {expectedRevision:c.expectedRevision,writeAreaId:c.writeAreaId,restoreGeneration:c.restoreGeneration},"note"),
  method:"DELETE",
  url:c=>"/api/target-staging/notes/"+encodeURIComponent(c.noteId),
  receiptUrl:c=>"/api/target-staging/notes/"+encodeURIComponent(c.noteId)+"/delete/status",
  body:c=>({commandId:c.commandId,expectedRevision:c.expectedRevision,
    writeAreaId:c.writeAreaId,restoreGeneration:c.restoreGeneration}),
};
export const buildNoteDeleteCommand=(
  noteId:string,context:WriteContext,commandId:string=crypto.randomUUID(),
):NoteDeleteCommand|null=>{
  const command={commandId,noteId,...context};
  return noteDeleteTransport.valid(command)?command:null;
};
export const dispatchNoteDelete=(command:NoteDeleteCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal,onDispatch?:()=>void)=>dispatch(noteDeleteTransport,command,fetchImpl,signal,onDispatch);
export const checkNoteDeleteReceipt=(command:NoteDeleteCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal)=>checkReceipt(noteDeleteTransport,command,fetchImpl,signal);
