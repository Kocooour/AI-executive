/** R3-slice UI-03a: isolated staging-only status CAS transport.
 * Client-side proof is NEVER authority: server checks identity, ACL, store
 * generation, revision and current assignment for every command and receipt.
 * No writes are invoked until a later explicitly server-gated UI integration. */
import {targetAppFetch} from "./target-app-fetch";
export type MyPlanStatus="open"|"completed";
export type MyPlanStatusCommand={
  commandId:string;taskId:string;status:MyPlanStatus;
  expectedRevision:string;writeAreaId:string;restoreGeneration:string;
};
export type MyPlanStatusFailure="signed-out"|"stale"|"unavailable"|
  "invalid-response"|"invalid-request"|"offline"|"aborted";
export type MyPlanStatusPreparation=
  |{ok:true;command:MyPlanStatusCommand}
  |{ok:false;reason:MyPlanStatusFailure};
export type MyPlanStatusReceipt=
  |{kind:"committed"|"not-recorded"}
  |{kind:"unknown";reason:MyPlanStatusFailure};
export type MyPlanStatusDispatch=
  |{kind:"committed";command:MyPlanStatusCommand}
  |{kind:"uncertain";command:MyPlanStatusCommand}
  |{kind:"rejected";reason:MyPlanStatusFailure};

const statusUrl="/api/target-staging/task-temporal/status";
const receiptUrl=statusUrl+"/receipt";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revision=/^[a-f0-9]{64}$/;
const area=/^[A-Za-z0-9_.:@-]{1,120}$/;
const known=["commandId","taskId","status","expectedRevision","writeAreaId","restoreGeneration"];
function object(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function keys(value:Record<string,unknown>,expected:string[]):boolean{
  return Object.keys(value).sort().join("|")===expected.slice().sort().join("|");
}
export function validStatusTaskId(value:unknown):value is string{
  if(typeof value!=="string"||!value||value.includes("\0"))return false;
  try{return new TextEncoder().encode(value).length<=4096&&
    decodeURIComponent(encodeURIComponent(value))===value;}
  catch{return false;}
}
export function validStatusCommand(value:unknown):value is MyPlanStatusCommand{
  if(!object(value)||!keys(value,known))return false;
  return typeof value.commandId==="string"&&uuid.test(value.commandId)&&
    validStatusTaskId(value.taskId)&&
    (value.status==="open"||value.status==="completed")&&
    typeof value.expectedRevision==="string"&&revision.test(value.expectedRevision)&&
    typeof value.writeAreaId==="string"&&area.test(value.writeAreaId)&&
    typeof value.restoreGeneration==="string"&&uuid.test(value.restoreGeneration);
}
function safeResponse(response:Response):boolean{
  return !response.redirected&&
    response.headers.get("cache-control")?.toLowerCase().includes("no-store")===true&&
    response.headers.get("content-type")?.toLowerCase().includes("application/json")===true;
}
function errorStatus(status:number):MyPlanStatusFailure{
  if(status===401||status===403)return "signed-out";
  if(status===409)return "stale";
  if(status===400)return "invalid-request";
  return "unavailable"; // includes disabled endpoint (404) and rate limit
}
const readOptions=(signal?:AbortSignal):RequestInit=>({
  method:"GET",credentials:"same-origin",cache:"no-store",
  redirect:"error",headers:{accept:"application/json"},signal,
});
const writeOptions=(command:MyPlanStatusCommand,method:"PATCH"|"POST",signal?:AbortSignal):RequestInit=>({
  method,credentials:"same-origin",cache:"no-store",redirect:"error",
  headers:{
    accept:"application/json","content-type":"application/json",
    "x-lumi-target-protocol":"1",
  },body:JSON.stringify(command),signal,
});

/** A fresh server preflight is required for EVERY completion or reversal.
 * Area equality is an additional stale-page guard, not ACL authorization. */
export async function prepareMyPlanStatus(
  params:{taskId:string;areaId:string;status:MyPlanStatus;
    commandId?:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=targetAppFetch,
):Promise<MyPlanStatusPreparation>{
  if(!validStatusTaskId(params.taskId)||!area.test(params.areaId)||
    !["open","completed"].includes(params.status)||
    (params.commandId!==undefined&&!uuid.test(params.commandId)))
    return {ok:false,reason:"invalid-request"};
  let response:Response;
  try{
    const url=statusUrl+"?"+new URLSearchParams({taskId:params.taskId});
    response=await fetchImpl(url,readOptions(params.signal));
  }catch{
    return {ok:false,reason:params.signal?.aborted?"aborted":"offline"};
  }
  if(params.signal?.aborted)return {ok:false,reason:"aborted"};
  if(response.status!==200)return {ok:false,reason:errorStatus(response.status)};
  if(!safeResponse(response))return {ok:false,reason:"invalid-response"};
  try{
    const json:unknown=await response.json();
    if(!object(json)||!keys(json,["expectedRevision","writeAreaId","restoreGeneration"])||
      typeof json.expectedRevision!=="string"||!revision.test(json.expectedRevision)||
      typeof json.writeAreaId!=="string"||!area.test(json.writeAreaId)||
      json.writeAreaId!==params.areaId||
      typeof json.restoreGeneration!=="string"||!uuid.test(json.restoreGeneration))
      return {ok:false,reason:"invalid-response"};
    if(params.signal?.aborted)return {ok:false,reason:"aborted"};
    const command:MyPlanStatusCommand={
      commandId:params.commandId??crypto.randomUUID(),
      taskId:params.taskId,status:params.status,
      expectedRevision:json.expectedRevision,
      writeAreaId:json.writeAreaId,restoreGeneration:json.restoreGeneration,
    };
    return validStatusCommand(command)
      ?{ok:true,command}:{ok:false,reason:"invalid-response"};
  }catch{return {ok:false,reason:params.signal?.aborted?"aborted":"invalid-response"};}
}

/** Receipt is read-only even though it uses POST. 'not_recorded' is not proof
 * that a concurrent PATCH did not or will not commit. Never auto-resend. */
export async function checkMyPlanStatusReceipt(
  command:MyPlanStatusCommand,
  fetchImpl:typeof fetch=targetAppFetch,
  signal?:AbortSignal,
):Promise<MyPlanStatusReceipt>{
  if(!validStatusCommand(command))return {kind:"unknown",reason:"invalid-request"};
  if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
  let response:Response;
  try{response=await fetchImpl(receiptUrl,writeOptions(command,"POST",signal));}
  catch{return {kind:"unknown",reason:signal?.aborted?"aborted":"offline"};}
  if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
  if(response.status!==200)return {kind:"unknown",reason:errorStatus(response.status)};
  if(!safeResponse(response))return {kind:"unknown",reason:"invalid-response"};
  try{
    const body:unknown=await response.json();
    if(signal?.aborted)return {kind:"unknown",reason:"aborted"};
    if(!object(body)||!keys(body,["status"]))return {kind:"unknown",reason:"invalid-response"};
    if(body.status==="committed")return {kind:"committed"};
    if(body.status==="not_recorded")return {kind:"not-recorded"};
    return {kind:"unknown",reason:"invalid-response"};
  }catch{return {kind:"unknown",reason:signal?.aborted?"aborted":"invalid-response"};}
}

/** A PATCH can commit before the response is lost. Treat all ambiguous
 * outcomes as pending and inspect the exact original receipt. No retries. */
export async function dispatchMyPlanStatus(
  command:MyPlanStatusCommand,fetchImpl:typeof fetch=targetAppFetch,
  signal?:AbortSignal,
):Promise<MyPlanStatusDispatch>{
  if(!validStatusCommand(command))return {kind:"rejected",reason:"invalid-request"};
  if(signal?.aborted)return {kind:"rejected",reason:"aborted"};
  let response:Response|undefined;
  try{response=await fetchImpl(statusUrl,writeOptions(command,"PATCH",signal));}
  catch{/* A network interruption cannot establish whether the writer committed. */}
  if(signal?.aborted)return {kind:"uncertain",command};
  if(response){
    // 400/409 are pre-commit refusals. A post-commit owner-session check
    // can return 401, so 401/403/404 do NOT prove absence of a commit.
    if(response.status===400||response.status===409)
      return {kind:"rejected",reason:errorStatus(response.status)};
    if(response.status===200&&safeResponse(response)){
      try{
        const body:unknown=await response.json();
        if(signal?.aborted)return {kind:"uncertain",command};
        if(object(body)&&(keys(body,["ok"])||keys(body,["ok","replayed"]))&&
          body.ok===true&&(!("replayed" in body)||body.replayed===true))
          return {kind:"committed",command};
      }catch{/* Malformed success might still have committed. */}
    }
  }
  // 503, timeout, unknown HTTP success/body: confirm, but NEVER send PATCH again.
  const receipt=await checkMyPlanStatusReceipt(command,fetchImpl,signal);
  return receipt.kind==="committed"
    ?{kind:"committed",command}
    :{kind:"uncertain",command}; // Including denied receipt: never infer no commit.
}

/** Caller chooses status explicitly. Undo must call this anew with 'open',
 * obtaining a fresh CAS/restore/Area preview and a NEW command UUID. */
export async function changeMyPlanStatus(
  params:{taskId:string;areaId:string;status:MyPlanStatus;
    commandId?:string;signal?:AbortSignal},
  fetchImpl:typeof fetch=targetAppFetch,
):Promise<MyPlanStatusDispatch>{
  const prepared=await prepareMyPlanStatus(params,fetchImpl);
  if(prepared.ok===false)return {kind:"rejected",reason:prepared.reason};
  return dispatchMyPlanStatus(prepared.command,fetchImpl,params.signal);
}
