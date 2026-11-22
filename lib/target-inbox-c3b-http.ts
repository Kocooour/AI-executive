/** C-3b default-off authenticated HTTP shell. Never release an ACL witness. */
import {HttpInputError,enforceRateLimit,readJsonBody,requireTargetSameOrigin}
  from "./http-security";
import {logStagingFailure} from "./target-staging-failure-log";
import {resolveStagingHttpIdentity,stagingAnchorRefusal,
  stagingUnauthenticatedRefusal,stagingUnauthorizedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingReadBeforeRelease,verifyStagingIdentityBeforeRelease}
  from "./target-staging-http-identity";
import {targetProtocolRefusal,legacySnapshotRefusal}
  from "./target-staging-write-contract";
import {c3bEnabled,c3bWriteEnabled,c3bConfig,c3bUnchanged}
  from "./target-inbox-c3b-runtime";
import {previewC3bInChild,acceptC3bInChild,undoC3bInChild,
  receiptC3bInChild,readC3bConsentInChild,writeC3bConsentInChild}
  from "./target-inbox-c3b-process";
import type {InboxAcceptCommand,InboxAcceptUndoCommand}
  from "./target-inbox-accept-writer";

const headers={"cache-control":"no-store"};
const answer=(status:number,error:string)=>
  Response.json({error},{status,headers});
const id=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const issue=(request:Request,operation:string)=>{
  const limited=enforceRateLimit(request,"target-staging-c3b-"+operation,
    operation==="preview"?24:operation==="consent"?10:30,600000);
  return limited?Response.json({error:"Too many requests"},{status:429,
    headers:{...headers,"retry-after":String(limited.retryAfter)}}):null;
};
const writeResult=(result:Awaited<ReturnType<typeof acceptC3bInChild>>)=>{
  if(!result)return answer(503,"Staging unavailable");
  if(result.ok===true)
    return Response.json(result.replayed?{ok:true,replayed:true}:{ok:true},{headers});
  if(result.reason==="invalid_request")return answer(400,"Invalid request");
  if(result.reason==="unavailable")return answer(404,"Not found");
  if(["stale_revision","idempotency_conflict","resync_required"]
    .includes(result.reason))return answer(409,"Revision conflict");
  if(result.reason==="session_revoked")return answer(401,"Authentication required");
  return answer(503,"Staging unavailable");
};
export async function getC3bPreview(request:Request):Promise<Response>{
  if(!c3bEnabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=c3bConfig();
  if(!base)return answer(503,"Staging unavailable");
  const admitted=admitStagingIdentity(request,identity,base);
  if(admitted)return admitted;
  try{
    const params=new URL(request.url).searchParams;
    if([...params.keys()].some(k=>k!=="taskId")||
       params.getAll("taskId").length!==1)return answer(400,"Invalid request");
    const taskId=params.get("taskId");
    if(!taskId||!id.test(taskId))return answer(400,"Invalid request");
    const limited=issue(request,"preview");
    if(limited)return limited;
    const result=await previewC3bInChild({
      ...base,...stagingChildSessionConfig(identity)},taskId);
    const released=result
      ?verifyStagingReadBeforeRelease(request,identity,base,base.ownerUserId,
        result.linearization,undefined,undefined,undefined,undefined,
        undefined,{scope:"global-all",areas:result.areaEpochs},
        undefined,{privateEpoch:result.privateEpoch},undefined,
        {notificationEpoch:result.notificationEpoch})
      :verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok"&&released!=="stale")return stagingIdentityRefusal(released);
    if(!c3bUnchanged(base)||released==="stale")
      return answer(released==="stale"?409:503,
        released==="stale"?"read_stale_reload":"Staging unavailable");
    if(!result||result.taskId!==taskId||
       result.restoreGeneration!==base.expectedRestoreGeneration)
      return answer(503,"Staging unavailable");
    // All ACL, session, candidate, epoch and linearization proofs stay internal.
    return Response.json({taskId:result.taskId,why:result.why,
      token:result.token,changes:result.changes,source:result.source,
      restoreGeneration:result.restoreGeneration},{headers});
  }catch(error){
    logStagingFailure("target-staging/inbox/c3b-preview","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
export async function postC3b(
  request:Request,operation:"accept"|"undo"|"receipt"|"consent",
):Promise<Response>{
  if(!(operation==="receipt"||operation==="consent"?c3bEnabled():c3bWriteEnabled()))
    return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=c3bConfig();
  if(!base)return answer(503,"Staging unavailable");
  try{
    requireTargetSameOrigin(request);
    const admitted=admitStagingIdentity(request,identity,base);
    if(admitted)return admitted;
    if(new URL(request.url).search!=="")return answer(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);
    if(protocol)return protocol;
    const limited=issue(request,operation);
    if(limited)return limited;
    const body=await readJsonBody<unknown>(request,16*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(body);
    if(legacy)return legacy;
    if(!body||typeof body!=="object"||Array.isArray(body))return answer(400,"Invalid request");
    const obj=body as Record<string,unknown>;
    if(operation==="consent"){
      if(!c3bWriteEnabled())return answer(404,"Not found");
      if(Object.keys(obj).join(",")!=="enabled"||typeof obj.enabled!=="boolean")
        return answer(400,"Invalid request");
    }else if(Object.keys(obj).join(",")!=="command"||
      !obj.command||typeof obj.command!=="object"||Array.isArray(obj.command))
      return answer(400,"Invalid request");
    const before=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(before!=="ok")return stagingIdentityRefusal(before);
    if(!c3bUnchanged(base,operation!=="receipt"))return answer(503,"Staging unavailable");
    const childConfig={...base,...stagingChildSessionConfig(identity)};
    if(operation==="consent"){
      const reply=await writeC3bConsentInChild(childConfig,
        obj.enabled?"grant":"revoke");
      const after=verifyStagingIdentityBeforeRelease(request,identity,base);
      if(after!=="ok")return stagingIdentityRefusal(after);
      if(!reply||!c3bUnchanged(base,true))return answer(503,"Staging unavailable");
      return Response.json({ok:true,enabled:reply.enabled,
        pending:reply.pending},{status:reply.pending?202:200,headers});
    }
    if(operation==="receipt"){
      const reply=await receiptC3bInChild(childConfig,obj.command as InboxAcceptCommand);
      const release=reply
        ?verifyStagingReadBeforeRelease(request,identity,base,base.ownerUserId,
          reply.linearization,undefined,undefined,undefined,undefined,
          undefined,{scope:"global-all",areas:reply.areaEpochs})
        :verifyStagingIdentityBeforeRelease(request,identity,base);
      if(release!=="ok"&&release!=="stale")return stagingIdentityRefusal(release);
      if(release==="stale")return answer(409,"read_stale_reload");
      if(!reply||!c3bUnchanged(base))return answer(503,"Staging unavailable");
      if(reply.status==="conflict")return answer(409,"Idempotency conflict");
      return Response.json({ok:true,status:reply.status,next:reply.next},{headers});
    }
    const reply=operation==="accept"
      ?await acceptC3bInChild(childConfig,obj.command as InboxAcceptCommand)
      :await undoC3bInChild(childConfig,obj.command as InboxAcceptUndoCommand);
    // A committed write cannot safely be reclassified as uncommitted
    // after a lost response; receipt reconciliation preserves UUID.
    const after=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(after!=="ok")return stagingIdentityRefusal(after);
    if(!c3bUnchanged(base,true))return answer(503,"Staging unavailable");
    if(reply?.ok===false&&reply.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,base);
    return writeResult(reply);
  }catch(error){
    if(error instanceof HttpInputError)return answer(error.status,error.message);
    logStagingFailure("target-staging/inbox/c3b-"+operation,"route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
export async function getC3bConsent(request:Request):Promise<Response>{
  if(!c3bEnabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=c3bConfig();
  if(!base)return answer(503,"Staging unavailable");
  const admitted=admitStagingIdentity(request,identity,base);
  if(admitted)return admitted;
  try{
    if(new URL(request.url).search!=="")return answer(400,"Invalid request");
    const limited=issue(request,"consent");
    if(limited)return limited;
    const result=await readC3bConsentInChild({
      ...base,...stagingChildSessionConfig(identity)});
    const release=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(release!=="ok")return stagingIdentityRefusal(release);
    if(!result||!c3bUnchanged(base))return answer(503,"Staging unavailable");
    if(result.restoreGeneration!==base.expectedRestoreGeneration)
      return answer(409,"read_stale_reload");
    return Response.json({enabled:result.enabled,pending:result.pending},{headers});
  }catch(error){
    logStagingFailure("target-staging/inbox/c3b-consent","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
