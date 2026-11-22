/** C-3b browser-only ephemeral proposal and receipt protocol. */
import {targetAppFetch} from "./target-app-fetch";
export type C3bChanges={
  whenOn:string;projectId:string;taskAreaId:string|null;effectiveAreaId:string;
};
export type C3bProposal={
  taskId:string;token:string;why:string;changes:C3bChanges;
  source:"rule"|"ai";restoreGeneration:string;
};
export type C3bAccept={
  commandId:string;taskId:string;restoreGeneration:string;
  token:string;displayedWhy:string;displayedChanges:C3bChanges;
};
export type C3bReceiptQuery={
  commandId:string;taskId:string;restoreGeneration:string;
};
export type C3bUndo={
  commandId:string;undoOfCommandId:string;taskId:string;
  restoreGeneration:string;expectedTaskRevision:number;
  expectedTriageRevision:number;expectedPrivateEpoch:number;
  expectedPlanRevision:number|null;
};
export type C3bReceipt={status:"committed"|"undone"|"not_recorded";
  next:{expectedTaskRevision:number;expectedTriageRevision:number;
    expectedPrivateEpoch:number;expectedPlanRevision:number|null}|null};
export type C3bFailure="signed-out"|"stale"|"disabled"|"unavailable";
export type C3bResponse<T>={ok:true;value:T}|{ok:false;reason:C3bFailure};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const object=(x:unknown):x is Record<string,unknown>=>
  Boolean(x)&&typeof x==="object"&&!Array.isArray(x);
const validChanges=(x:unknown):x is C3bChanges=>{
  if(!object(x)||Object.keys(x).sort().join(",")!==
    "effectiveAreaId,projectId,taskAreaId,whenOn")return false;
  const id=(v:unknown)=>typeof v==="string"&&v.length<121&&
    /^[A-Za-z0-9_.:@-]+$/.test(v);
  return typeof x.whenOn==="string"&&
    (x.whenOn==="unchanged"||/^\d{4}-\d{2}-\d{2}$/.test(x.whenOn))&&
    id(x.projectId)&&(x.taskAreaId===null||id(x.taskAreaId))&&
    id(x.effectiveAreaId);
};
const status=(n:number):C3bFailure=>n===401||n===403?"signed-out":
  n===404?"disabled":n===409?"stale":"unavailable";
export function parseC3bProposal(raw:unknown):C3bProposal|null{
  if(!object(raw)||Object.keys(raw).sort().join(",")!==
      "changes,restoreGeneration,source,taskId,token,why"||
     typeof raw.taskId!=="string"||!TASK.test(raw.taskId)||
     typeof raw.token!=="string"||!/^c3b1\.[A-Za-z0-9_-]{48,8192}$/.test(raw.token)||
     typeof raw.why!=="string"||!raw.why.trim()||raw.why.length>512||
     (raw.source!=="rule"&&raw.source!=="ai")||
     typeof raw.restoreGeneration!=="string"||!uuid.test(raw.restoreGeneration)||
     !validChanges(raw.changes))return null;
  return raw as unknown as C3bProposal;
}
export async function fetchC3bProposal(taskId:string,signal?:AbortSignal):
  Promise<C3bResponse<C3bProposal>>{
  if(!TASK.test(taskId))return {ok:false,reason:"unavailable"};
  try{
    const response=await targetAppFetch(
      "/api/target-staging/inbox/c3b?taskId="+encodeURIComponent(taskId),{
        credentials:"same-origin",cache:"no-store",signal,
      });
    if(!response.ok)return {ok:false,reason:status(response.status)};
    const parsed=parseC3bProposal(await response.json());
    return parsed&&parsed.taskId===taskId
      ?{ok:true,value:parsed}:{ok:false,reason:"unavailable"};
  }catch{return {ok:false,reason:"unavailable"};}
}
async function post<T>(route:string,body:object,parse:(x:unknown)=>T|null,
  signal?:AbortSignal):Promise<C3bResponse<T>>{
  try{
    const response=await targetAppFetch("/api/target-staging/inbox/c3b/"+route,{
      method:"POST",credentials:"same-origin",cache:"no-store",signal,
      headers:{"content-type":"application/json","x-lumi-target-protocol":"1"},
      body:JSON.stringify(body),
    });
    if(!response.ok)return {ok:false,reason:status(response.status)};
    const value=parse(await response.json());
    return value===null?{ok:false,reason:"unavailable"}:{ok:true,value};
  }catch{return {ok:false,reason:"unavailable"};}
}
const parseOK=(x:unknown):boolean|null=>object(x)&&x.ok===true&&
  (Object.keys(x).sort().join(",")==="ok"||
   Object.keys(x).sort().join(",")==="ok,replayed"&&x.replayed===true)
  ?true:null;
export const acceptC3b=(command:C3bAccept)=>
  post("accept",{command},parseOK);
export const undoC3b=(command:C3bUndo)=>
  post("undo",{command},parseOK);
const parseReceipt=(x:unknown):C3bReceipt|null=>{
  if(!object(x)||x.ok!==true||
     Object.keys(x).sort().join(",")!=="next,ok,status"||
     !["committed","undone","not_recorded"].includes(x.status as string))return null;
  if(x.next!==null){
    if(!object(x.next)||Object.keys(x.next).sort().join(",")!==
        "expectedPlanRevision,expectedPrivateEpoch,expectedTaskRevision,expectedTriageRevision"||
       !Number.isSafeInteger(x.next.expectedTaskRevision)||
       !Number.isSafeInteger(x.next.expectedTriageRevision)||
       !Number.isSafeInteger(x.next.expectedPrivateEpoch)||
       (x.next.expectedPlanRevision!==null&&
        !Number.isSafeInteger(x.next.expectedPlanRevision)))return null;
  }
  return {status:x.status as C3bReceipt["status"],
    next:x.next as C3bReceipt["next"]};
};
export const receiptC3b=(command:C3bAccept|C3bReceiptQuery)=>
  post("receipt",{command},parseReceipt);
/** Consent never loads a cached response, and never calls another AI provider. */
export async function getC3bConsent(signal?:AbortSignal):
  Promise<C3bResponse<{enabled:boolean;pending:boolean}>>{
  try{
    const r=await targetAppFetch("/api/target-staging/inbox/c3b/consent",{
      credentials:"same-origin",cache:"no-store",signal});
    if(!r.ok)return {ok:false,reason:status(r.status)};
    const x:unknown=await r.json();
    return object(x)&&Object.keys(x).sort().join(",")==="enabled,pending"&&
      typeof x.enabled==="boolean"&&typeof x.pending==="boolean"
      ?{ok:true,value:{enabled:x.enabled,pending:x.pending}}
      :{ok:false,reason:"unavailable"};
  }catch{return {ok:false,reason:"unavailable"};}
}
export const setC3bConsent=(enabled:boolean)=>
  post("consent",{enabled},(raw)=>{
    if(!object(raw)||raw.ok!==true||typeof raw.enabled!=="boolean"||
       typeof raw.pending!=="boolean"||Object.keys(raw).sort().join(",")!==
       "enabled,ok,pending")return null;
    return {enabled:raw.enabled,pending:raw.pending};
  });

/** Tab-only recovery stores original UUID and CAS, NEVER private task title,
 * displayed Why, signed token, target names or provider response. A missing
 * Accept body after reload is intentionally unretryable; receipt may still be
 * reconciled, and a new UUID must not be issued while unresolved. */
const RECOVERY_KEY="lumi:target-c3b-recovery:v1";
export type C3bRecovery={
  version:1;generation:string;command:C3bReceiptQuery;undo:C3bUndo|null;
};
const validQuery=(x:unknown):x is C3bReceiptQuery=>object(x)&&
  Object.keys(x).sort().join(",")==="commandId,restoreGeneration,taskId"&&
  typeof x.commandId==="string"&&uuid.test(x.commandId)&&
  typeof x.restoreGeneration==="string"&&uuid.test(x.restoreGeneration)&&
  typeof x.taskId==="string"&&TASK.test(x.taskId);
const validUndo=(x:unknown):x is C3bUndo=>object(x)&&
  Object.keys(x).sort().join(",")===
    "commandId,expectedPlanRevision,expectedPrivateEpoch,expectedTaskRevision,expectedTriageRevision,restoreGeneration,taskId,undoOfCommandId"&&
  typeof x.commandId==="string"&&uuid.test(x.commandId)&&
  typeof x.undoOfCommandId==="string"&&uuid.test(x.undoOfCommandId)&&
  typeof x.restoreGeneration==="string"&&uuid.test(x.restoreGeneration)&&
  typeof x.taskId==="string"&&TASK.test(x.taskId)&&
  Number.isSafeInteger(x.expectedTaskRevision)&&
  Number.isSafeInteger(x.expectedTriageRevision)&&
  Number.isSafeInteger(x.expectedPrivateEpoch)&&
  (x.expectedPlanRevision===null||Number.isSafeInteger(x.expectedPlanRevision));
export function persistC3bRecovery(value:C3bRecovery|null):boolean{
  try{
    if(value===null){sessionStorage.removeItem(RECOVERY_KEY);return true;}
    if(value.version!==1||!value.generation||!validQuery(value.command)||
       value.undo!==null&&!validUndo(value.undo))return false;
    const encoded=JSON.stringify(value);
    if(encoded.length>2048)return false;
    sessionStorage.setItem(RECOVERY_KEY,encoded);
    return true;
  }catch{return false;}
}
export function readC3bRecovery(generation:string):C3bRecovery|null{
  try{
    const raw=sessionStorage.getItem(RECOVERY_KEY);
    if(!raw||raw.length>2048)return null;
    const x:unknown=JSON.parse(raw);
    if(!object(x)||Object.keys(x).sort().join(",")!==
      "command,generation,undo,version"||x.version!==1||
      x.generation!==generation||!validQuery(x.command)||
      x.undo!==null&&!validUndo(x.undo))return null;
    return x as C3bRecovery;
  }catch{return null;}
}
