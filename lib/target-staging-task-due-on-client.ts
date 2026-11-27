/** F-1: actor-authorized shared deadline CAS transport. Never retries a PATCH. */
import {targetAppFetch} from "./target-app-fetch";
import {validStatusTaskId} from "./target-staging-my-plan-status-client";

export type TaskDueOnFailure="signed-out"|"stale"|"unavailable"|
  "invalid-response"|"invalid-request"|"offline"|"aborted"|"unchanged";
export type TaskDueOnCommand={
  commandId:string;taskId:string;dueOn:string|null;
  expectedRevision:string;writeAreaId:string;
  restoreGeneration:string;
};
export type TaskDueOnPreparation=
  |{ok:true;command:TaskDueOnCommand;previousDueOn:string|null}
  |{ok:false;reason:TaskDueOnFailure};
export type TaskDueOnReceipt=
  |{kind:"committed"|"not-recorded"}
  |{kind:"unknown";reason:TaskDueOnFailure};
export type TaskDueOnDispatch=
  |{kind:"committed";command:TaskDueOnCommand}
  |{kind:"uncertain";command:TaskDueOnCommand}
  |{kind:"rejected";reason:TaskDueOnFailure};

const url="/api/target-staging/task-temporal/due-on";
const receiptUrl=url+"/receipt";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revision=/^[a-f0-9]{64}$/;
const area=/^[A-Za-z0-9_.:@-]{1,120}$/;
const fields=["commandId","taskId","dueOn","expectedRevision",
  "writeAreaId","restoreGeneration"];
const previewFields=fields.filter(key=>key!=="commandId"&&key!=="taskId");
const object=(x:unknown):x is Record<string,unknown>=>
  x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x:Record<string,unknown>,keys:readonly string[]):boolean=>
  Object.keys(x).sort().join("|")===keys.slice().sort().join("|");

/** Same Gregorian date-only domain as the staging due-on writer. */
export function validTaskDueOnDate(x:unknown):x is string|null{
  if(x===null)return true;
  if(typeof x!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;
  const y=Number(x.slice(0,4)),m=Number(x.slice(5,7)),d=Number(x.slice(8));
  if(y<1||m<1||m>12||d<1)return false;
  const leap=y%4===0&&(y%100!==0||y%400===0);
  return d<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1];
}


export function validTaskDueOnCommand(x:unknown):x is TaskDueOnCommand{
  if(!object(x)||!exact(x,fields))return false;
  return typeof x.commandId==="string"&&uuid.test(x.commandId)&&
    validStatusTaskId(x.taskId)&&validTaskDueOnDate(x.dueOn)&&
    typeof x.expectedRevision==="string"&&revision.test(x.expectedRevision)&&
    typeof x.writeAreaId==="string"&&area.test(x.writeAreaId)&&
    typeof x.restoreGeneration==="string"&&uuid.test(x.restoreGeneration);
}

const safeResponse=(r:Response):boolean=>
  !r.redirected&&
  r.headers.get("cache-control")?.toLowerCase().includes("no-store")===true&&
  r.headers.get("content-type")?.toLowerCase().includes("application/json")===true;
const failure=(status:number):TaskDueOnFailure=>
  status===401||status===403?"signed-out":
  status===409?"stale":status===400?"invalid-request":"unavailable";
const readOptions=(signal?:AbortSignal):RequestInit=>({
  method:"GET",credentials:"same-origin",cache:"no-store",
  redirect:"error",headers:{accept:"application/json"},signal,
});
const writeOptions=(command:TaskDueOnCommand,method:"PATCH"|"POST",
  signal?:AbortSignal):RequestInit=>({
  method,credentials:"same-origin",cache:"no-store",redirect:"error",
  headers:{accept:"application/json","content-type":"application/json",
    "x-lumi-target-protocol":"1"},
  body:JSON.stringify(command),signal,
});

/** Read-only deadline context; its task CAS binds the date to one authorized snapshot. */
export async function readTaskDueOnContext(params:{taskId:string;areaId:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=targetAppFetch):Promise<
  {ok:true;dueOn:string|null;expectedRevision:string;writeAreaId:string;restoreGeneration:string}|
  {ok:false;reason:TaskDueOnFailure}>{
  if(!validStatusTaskId(params.taskId)||typeof params.areaId!=="string"||!area.test(params.areaId))
    return {ok:false,reason:"invalid-request"};
  if(params.signal?.aborted)return {ok:false,reason:"aborted"};
  let response:Response;
  try{
    response=await fetchImpl(url+"?"+new URLSearchParams({
      taskId:params.taskId,
    }),readOptions(params.signal));
  }catch{return {ok:false,reason:params.signal?.aborted?"aborted":"offline"};}
  if(params.signal?.aborted)return {ok:false,reason:"aborted"};
  if(response.status!==200)return {ok:false,reason:failure(response.status)};
  if(!safeResponse(response))return {ok:false,reason:"invalid-response"};
  try{
    const data:unknown=await response.json();
    if(params.signal?.aborted)return {ok:false,reason:"aborted"};
    if(!object(data)||!exact(data,previewFields)||
      typeof data.expectedRevision!=="string"||
      !revision.test(data.expectedRevision)||
      !validTaskDueOnDate(data.dueOn)||
      typeof data.writeAreaId!=="string"||
      !area.test(data.writeAreaId)||
      data.writeAreaId!==params.areaId||
      typeof data.restoreGeneration!=="string"||
      !uuid.test(data.restoreGeneration))
      return {ok:false,reason:"invalid-response"};
    return {ok:true,dueOn:data.dueOn,expectedRevision:data.expectedRevision,
      writeAreaId:data.writeAreaId,restoreGeneration:data.restoreGeneration};
  }catch{return {ok:false,reason:params.signal?.aborted?"aborted":"invalid-response"};}
}

/** A NEW actor-authorized, same-snapshot preview for each intentional change. */
export async function prepareTaskDueOn(params:{taskId:string;areaId:string;dueOn:string|null;
  commandId?:string;signal?:AbortSignal},fetchImpl:typeof fetch=targetAppFetch):Promise<TaskDueOnPreparation>{
  if(!validTaskDueOnDate(params.dueOn)||(params.commandId!==undefined&&!uuid.test(params.commandId)))
    return {ok:false,reason:"invalid-request"};
  const data=await readTaskDueOnContext(params,fetchImpl);
  if(data.ok===false)return data;
  if(params.signal?.aborted)return {ok:false,reason:"aborted"};
  if(data.dueOn===params.dueOn)return {ok:false,reason:"unchanged"};
  try{
    const command:TaskDueOnCommand={
      commandId:params.commandId??crypto.randomUUID(),
      taskId:params.taskId,dueOn:params.dueOn,
      expectedRevision:data.expectedRevision,
      writeAreaId:data.writeAreaId,
      restoreGeneration:data.restoreGeneration,
    };
    return validTaskDueOnCommand(command)
      ?{ok:true,command,previousDueOn:data.dueOn}
      :{ok:false,reason:"invalid-response"};
  }catch{return {ok:false,reason:params.signal?.aborted?"aborted":"invalid-response"};}
}

/** The POST is read-only. The *same original six-field command* is necessary
 * to check a possibly committed PATCH. 'not_recorded' is NEVER a rollback proof. */
export async function checkTaskDueOnReceipt(
  command:TaskDueOnCommand,fetchImpl:typeof fetch=targetAppFetch,
  signal?:AbortSignal,
):Promise<TaskDueOnReceipt>{
  if(!validTaskDueOnCommand(command))
    return {kind:"unknown",reason:"invalid-request"};
  if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
  let response:Response;
  try{response=await fetchImpl(receiptUrl,writeOptions(command,"POST",signal));}
  catch{return {kind:"unknown",reason:signal?.aborted?"aborted":"offline"};}
  if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
  if(response.status!==200)return {kind:"unknown",reason:failure(response.status)};
  if(!safeResponse(response))return {kind:"unknown",reason:"invalid-response"};
  try{
    const body:unknown=await response.json();
    if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
    if(!object(body)||!exact(body,["status"]))
      return {kind:"unknown",reason:"invalid-response"};
    if(body.status==="committed")return {kind:"committed"};
    if(body.status==="not_recorded")return {kind:"not-recorded"};
    return {kind:"unknown",reason:"invalid-response"};
  }catch{return {kind:"unknown",reason:signal?.aborted?"aborted":"invalid-response"};}
}

/** Exactly ONE PATCH attempt. Ambiguous post-write results (including late
 * auth denial) may have committed, so only an original receipt can confirm. */
export async function dispatchTaskDueOn(
  command:TaskDueOnCommand,fetchImpl:typeof fetch=targetAppFetch,
  signal?:AbortSignal,
):Promise<TaskDueOnDispatch>{
  if(!validTaskDueOnCommand(command))
    return {kind:"rejected",reason:"invalid-request"};
  if(signal?.aborted)return {kind:"rejected",reason:"aborted"};
  let response:Response|undefined;
  try{response=await fetchImpl(url,writeOptions(command,"PATCH",signal));}
  catch{/* Outcome unknown even if the network dropped after COMMIT. */}
  if(signal?.aborted)return {kind:"uncertain",command};
  if(response){
    // Server's 400/409 are definitive pre-commit refusals; unlike a late 401.
    if(response.status===400||response.status===409)
      return {kind:"rejected",reason:failure(response.status)};
    if(response.status===200&&safeResponse(response)){
      try{
        const body:unknown=await response.json();
        if(signal?.aborted)return {kind:"uncertain",command};
        if(object(body)&&(exact(body,["ok"])||
          exact(body,["ok","replayed"]))&&body.ok===true&&
          (!("replayed" in body)||body.replayed===true))
          return {kind:"committed",command};
      }catch{/* A malformed success can still follow an actual commit. */}
    }
  }
  const receipt=await checkTaskDueOnReceipt(command,fetchImpl,signal);
  return receipt.kind==="committed"
    ?{kind:"committed",command}:{kind:"uncertain",command};
}

/** No retry loop. UI must hold ambiguous command volatile and show an
 * explicit receipt-only recovery action before any further mutation/Undo. */
export async function changeTaskDueOn(
  params:{taskId:string;areaId:string;dueOn:string|null;
    commandId?:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=targetAppFetch,
):Promise<TaskDueOnDispatch>{
  const prepared=await prepareTaskDueOn(params,fetchImpl);
  if(prepared.ok===false)return {kind:"rejected",reason:prepared.reason};
  return dispatchTaskDueOn(prepared.command,fetchImpl,params.signal);
}
