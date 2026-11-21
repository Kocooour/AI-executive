/** C-3a browser protocol: exact DTOs, no persistence, no legacy fallback. */
import type {TargetInboxItem,TargetInboxTriageMode} from "./target-inbox-client-types";
import {targetAppFetch} from "./target-app-fetch";

export type InboxClientFailure="signed-out"|"stale"|"unavailable"|"feature-off";
export type InboxClientPage={
  items:TargetInboxItem[];count:number;nextCursor:string|null;restoreGeneration:string;
  snapshotRevision:string;
};
export type InboxClientRead={ok:true;value:InboxClientPage}|{ok:false;reason:InboxClientFailure};
export type InboxClientWrite={ok:true}|{ok:false;reason:"conflict"|"signed-out"|"uncertain"|"feature-off"};
export type InboxClientReceipt={ok:true;status:"committed"|"not_recorded"|"cancelled";
  next:{expectedRevision:string;triageRevision:number;writeAreaId:string}|null}
  |{ok:false;reason:InboxClientFailure};
export type InboxClientCancel={ok:true;status:"cancelled"|"committed"}|
  {ok:false;reason:InboxClientFailure};
export type InboxClientCommand={
  commandId:string;taskId:string;mode:TargetInboxTriageMode;
  undoOfCommandId:string|null;expectedRevision:string;expectedTriageRevision:number;
  writeAreaId:string;restoreGeneration:string;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Client never invents a reusable UUID: each ID is a deterministic digest
 * of the complete original payload, including the server-issued actor CAS.
 * The Node writer independently enforces exactly the same UUID binding. */
export async function issueInboxClientCommandId(
  fields:Omit<InboxClientCommand,"commandId">,
):Promise<string|null>{
  try{
    const data=JSON.stringify([
      "lumi:c3a:self-bound-command:v1",fields.taskId,fields.mode,
      fields.undoOfCommandId?.toLowerCase()??null,fields.expectedRevision,
      fields.expectedTriageRevision,fields.writeAreaId,
      fields.restoreGeneration.toLowerCase(),
    ]);
    const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(data));
    const h=[...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,"0")).join("");
    return h.slice(0,8)+"-"+h.slice(8,12)+"-5"+h.slice(13,16)+"-8"+
      h.slice(17,20)+"-"+h.slice(20,32);
  }catch{return null;}
}

const cas=/^[a-f0-9]{64}$/;
const safe=(n:unknown)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const id=(x:unknown)=>typeof x==="string"&&x.length>0&&x.trim()===x&&
  x!=="."&&x!==".."&&new TextEncoder().encode(x).length<=512&&
  !/[\u0000-\u001f\u007f]/u.test(x);
const failure=(status:number):InboxClientFailure=>
  status===401||status===403?"signed-out":status===404?"feature-off":
  status===409?"stale":"unavailable";
export function parseInboxClientPage(raw:unknown,limit:number):InboxClientPage|null{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const v=raw as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="count,items,nextCursor,restoreGeneration,snapshotRevision"||
      !safe(v.count)||!Array.isArray(v.items)||v.items.length>limit||
      typeof v.restoreGeneration!=="string"||!uuid.test(v.restoreGeneration)||
      typeof v.snapshotRevision!=="string"||!cas.test(v.snapshotRevision)||
      (v.nextCursor!==null&&!id(v.nextCursor)))return null;
  const items:TargetInboxItem[]=[];
  for(const x of v.items){
    if(!x||typeof x!=="object"||Array.isArray(x))return null;
    const t=x as Record<string,unknown>;
    if(Object.keys(t).sort().join(",")!=="canProcess,effectiveAreaId,expectedRevision,id,status,taskRevision,title,triageRevision"||
        !id(t.id)||!id(t.effectiveAreaId)||typeof t.title!=="string"||
        !t.title.trim()||new TextEncoder().encode(t.title).length>4096||
        !safe(t.taskRevision)||!safe(t.triageRevision)||
        (t.status!=="open"&&t.status!=="completed")||
        typeof t.canProcess!=="boolean"||
        (t.canProcess?typeof t.expectedRevision!=="string"||!cas.test(t.expectedRevision):
          t.expectedRevision!==null))return null;
    items.push(t as unknown as TargetInboxItem);
  }
  if(v.nextCursor!==null&&
      (!items.length||items[items.length-1].id!==v.nextCursor||items.length!==limit))return null;
  return {items,count:v.count as number,nextCursor:v.nextCursor as string|null,
    restoreGeneration:v.restoreGeneration,snapshotRevision:v.snapshotRevision as string};
}
export async function fetchTargetInbox(
  limit=50,cursor:string|null=null,signal?:AbortSignal,
):Promise<InboxClientRead>{
  if(!Number.isInteger(limit)||limit<1||limit>100||(cursor!==null&&!id(cursor)))
    return {ok:false,reason:"unavailable"};
  try{
    const query=new URLSearchParams({limit:String(limit)});
    if(cursor!==null)query.set("cursor",cursor);
    const response=await targetAppFetch("/api/target-staging/inbox?"+query,{
      credentials:"same-origin",cache:"no-store",signal,
    });
    if(!response.ok)return {ok:false,reason:failure(response.status)};
    const page=parseInboxClientPage(await response.json(),limit);
    return page?{ok:true,value:page}:{ok:false,reason:"unavailable"};
  }catch{return {ok:false,reason:"unavailable"};}
}
function validCommand(c:InboxClientCommand):boolean{
  return uuid.test(c.commandId)&&id(c.taskId)&&cas.test(c.expectedRevision)&&
    safe(c.expectedTriageRevision)&&id(c.writeAreaId)&&uuid.test(c.restoreGeneration)&&
    (c.mode==="process"&&c.undoOfCommandId===null||
      c.mode==="undo"&&typeof c.undoOfCommandId==="string"&&uuid.test(c.undoOfCommandId));
}
async function postCommand(
  route:string,command:InboxClientCommand,signal?:AbortSignal,directReceipt=false,
){
  const init:RequestInit={method:"POST",credentials:"same-origin",cache:"no-store",
    headers:{"content-type":"application/json","x-lumi-target-protocol":"1"},
    body:JSON.stringify(command),signal};
  // A read-only receipt must be able to reconcile an ambiguous POST even
  // while a pagination GET occupies the single shared read-queue slot.
  // The backend permits two read children: the ordinary queue uses one and
  // this single coordinated command can use the second. If that slot is
  // unavailable, reconciliation stays uncertain rather than reissuing a UUID.
  return directReceipt?fetch(route,init):targetAppFetch(route,init);
}
/** Bound the entire write/receipt response, including a stalled JSON body.
 * Abort is advisory; Promise.race also settles when a fetch ignores abort. */
export const INBOX_COMMAND_DEADLINE_MS=12_000;
async function commandDeadline<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{
      controller.abort();reject(new Error()); // internal deadline; never exposed as UI text
    },INBOX_COMMAND_DEADLINE_MS);
  });
  try{return await Promise.race([work(controller.signal),timeout]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
}
export async function sendInboxCommand(
  command:InboxClientCommand,
):Promise<InboxClientWrite>{
  if(!validCommand(command))return {ok:false,reason:"conflict"};
  try{
    return await commandDeadline<InboxClientWrite>(async signal=>{
    const response=await postCommand("/api/target-staging/inbox/triage",command,signal);
    if(!response.ok){
      if(response.status===401||response.status===403)return {ok:false,reason:"signed-out"};
      if(response.status===409||response.status===400||response.status===404)
        return {ok:false,reason:"conflict"};
      return {ok:false,reason:"uncertain"};
    }
    const body:unknown=await response.json();
    if(!body||typeof body!=="object"||Array.isArray(body))return {ok:false,reason:"uncertain"};
    const x=body as Record<string,unknown>;
    if(x.ok!==true||!["ok","ok,replayed"].includes(Object.keys(x).sort().join(","))||
        (x.replayed!==undefined&&x.replayed!==true))return {ok:false,reason:"uncertain"};
    return {ok:true};
    });
  }catch{return {ok:false,reason:"uncertain"};}
}
/** Explicit actor-authorized cancellation, serialized with Process/Undo under
 * the same pinned SQLite write lock. Never treat a timeout as success. */
export async function cancelInboxCommand(command:InboxClientCommand):Promise<InboxClientCancel>{
  if(!validCommand(command))return {ok:false,reason:"unavailable"};
  try{
    return await commandDeadline<InboxClientCancel>(async signal=>{
      const response=await postCommand("/api/target-staging/inbox/cancel",command,signal);
      if(!response.ok)return {ok:false,reason:failure(response.status)};
      const body:unknown=await response.json();
      if(!body||typeof body!=="object"||Array.isArray(body))
        return {ok:false,reason:"unavailable"};
      const v=body as Record<string,unknown>;
      if(Object.keys(v).sort().join(",")!=="ok,status"||v.ok!==true||
          (v.status!=="cancelled"&&v.status!=="committed"))
        return {ok:false,reason:"unavailable"};
      return {ok:true,status:v.status};
    });
  }catch{return {ok:false,reason:"unavailable"};}
}
export async function verifyInboxCommand(
  command:InboxClientCommand,
):Promise<InboxClientReceipt>{
  if(!validCommand(command))return {ok:false,reason:"unavailable"};
  try{
    return await commandDeadline<InboxClientReceipt>(async signal=>{
    const response=await postCommand("/api/target-staging/inbox/receipt",command,signal,true);
    if(!response.ok)return {ok:false,reason:failure(response.status)};
    const body:unknown=await response.json();
    if(!body||typeof body!=="object"||Array.isArray(body))return {ok:false,reason:"unavailable"};
    const x=body as Record<string,unknown>;
    if(Object.keys(x).sort().join(",")!=="next,ok,status"||x.ok!==true||
        (x.status!=="committed"&&x.status!=="not_recorded"&&x.status!=="cancelled"))
      return {ok:false,reason:"unavailable"};
    let next:Extract<InboxClientReceipt,{ok:true}>["next"]=null;
    if(x.next!==null){
      if((x.status!=="committed"&&!(x.status==="cancelled"&&command.mode==="undo"))||
          !x.next||typeof x.next!=="object"||Array.isArray(x.next))
        return {ok:false,reason:"unavailable"};
      const n=x.next as Record<string,unknown>;
      if(Object.keys(n).sort().join(",")!=="expectedRevision,triageRevision,writeAreaId"||
          typeof n.expectedRevision!=="string"||!cas.test(n.expectedRevision)||
          !safe(n.triageRevision)||!id(n.writeAreaId))return {ok:false,reason:"unavailable"};
      next={expectedRevision:n.expectedRevision,triageRevision:n.triageRevision as number,
        writeAreaId:n.writeAreaId as string};
    }
    return {ok:true,status:x.status,next};
    });
  }catch{return {ok:false,reason:"unavailable"};}
}
