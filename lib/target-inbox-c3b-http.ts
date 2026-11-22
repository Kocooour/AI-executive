/** C-3b default-off authenticated HTTP shell. Never release an ACL witness. */
import {createHmac} from "node:crypto";
import {requestCookie,sessionCookieName} from "./auth";
import type {StagingHttpIdentity} from "./target-staging-http-identity";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
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
import {c3bEnabled,c3bWriteEnabled,c3bConfig,c3bUnchanged,
  inboxC3bActionKey,inboxC3bOwnerCookieBinding,openVerifiedInboxC3bFence}
  from "./target-inbox-c3b-runtime";
import {materializeInboxAIUnderFence} from "./target-inbox-ai-consent-fence";
import {INBOX_AI_DATA_SCOPE_VERSION} from "./target-inbox-ai-consent";
import {previewC3bInChild,acceptC3bInChild,undoC3bInChild,
  receiptC3bInChild,cancelC3bInChild,readC3bConsentInChild,writeC3bConsentInChild,
  type C3bPreview}
  from "./target-inbox-c3b-process";
import type {InboxAcceptCommand,InboxAcceptReceiptQuery,InboxAcceptUndoCommand}
  from "./target-inbox-accept-writer";

const headers={"cache-control":"no-store"};
const childConfig=(request:Request,identity:StagingHttpIdentity,
  config:StagingPersonalReadConfig):StagingPersonalReadConfig=>({
  ...config,...stagingChildSessionConfig(identity),
  ...(identity.kind==="owner"?{c3bOwnerCookieBinding:
    inboxC3bOwnerCookieBinding(requestCookie(request,sessionCookieName)??"",
      config.ownerUserId,config.expectedRestoreGeneration)??undefined}:{}),
});
// Memory-only, never persisted or logged. Every hit is STILL checked against
// live ACL, plan/timezone, actor session and (for AI) BOTH consent stores.
// A 15-second TTL prevents bursty repeated provider calls without retaining
// private titles, prompts or AI responses on disk.
const previews=new Map<string,{expiry:number;result:C3bPreview}>();
const CACHE_TTL_MS=15_000,MAX_CACHE=48;
// The shared staging pool has two subprocess slots. Never let two slow
// optional provider requests occupy both while a rules preview needs one.
let aiPreviewInFlight=false;
function previewCacheKey(request:Request,
  identity:{kind:"owner"}|{kind:"session";tokenHash:string},
  actor:string,taskId:string,generation:string,mode:"rules"|"best"):string|null{
  const key=inboxC3bActionKey();
  if(!key)return null;
  const session=identity.kind==="owner"?
    request.headers.get("cookie")??"":identity.tokenHash;
  return createHmac("sha256",key).update(JSON.stringify([
    "lumi:c3b:preview-cache:v1",identity.kind,session,
    actor,taskId,generation,mode,
  ])).digest("hex");
}
function rememberPreview(key:string|null,result:C3bPreview):void{
  if(!key)return;
  for(const [k,v] of previews)if(v.expiry<=Date.now())previews.delete(k);
  if(previews.size>=MAX_CACHE)previews.delete(previews.keys().next().value!);
  previews.set(key,{expiry:Date.now()+CACHE_TTL_MS,result});
}

const answer=(status:number,error:string)=>
  Response.json({error},{status,headers});
const id=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const issue=(request:Request,operation:string)=>{
  // A user with a long Inbox must still receive local rules even when the
  // remote model is rate-limited. This is a bounded HTTP request budget, NOT
  // the OpenAI dispatch allowance: the external cross-worker fence keeps its
  // much stricter 3/actor-minute and 12/global-minute provider limits.
  const limited=enforceRateLimit(request,"target-staging-c3b-"+operation,
    operation==="preview-rules"?180:
    operation==="preview-ai"?30:operation==="consent"?10:30,600000);
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
    if([...params.keys()].some(k=>k!=="taskId"&&k!=="mode")||
       params.getAll("taskId").length!==1||
       params.getAll("mode").length>1)return answer(400,"Invalid request");
    const mode=params.get("mode");
    if(mode!==null&&mode!=="rules")return answer(400,"Invalid request");
    const taskId=params.get("taskId");
    if(!taskId||!id.test(taskId))return answer(400,"Invalid request");
    // Local rules must never share the optional AI request-rate bucket.
    const limited=issue(request,mode==="rules"?"preview-rules":"preview-ai");
    if(limited)return limited;
    const cacheKey=previewCacheKey(request,identity,base.ownerUserId,
      taskId,base.expectedRestoreGeneration,mode==="rules"?"rules":"best");
    const cached=cacheKey?previews.get(cacheKey):undefined;
    if(cached&&cached.expiry<=Date.now()&&cacheKey)previews.delete(cacheKey);
    const liveCache=cached&&cached.expiry>Date.now()?cached.result:null;
    // On uncached optional AI work, keep one shared child slot free for rules
    // and critical receipt/Undo operations. Reject additional AI requests
    // without ever consuming a rules slot or its HTTP rate bucket.
    if(mode!=="rules"&&!liveCache&&aiPreviewInFlight)
      return Response.json({error:"AI request busy"},{status:429,headers});
    let result:C3bPreview|null=liveCache;
    if(!result){
      const aiSlot=mode!=="rules";
      if(aiSlot)aiPreviewInFlight=true;
      try{
        result=await previewC3bInChild(childConfig(request,identity,base),taskId,
          mode==="rules"?"rules":"best");
      }finally{
        if(aiSlot)aiPreviewInFlight=false;
      }
    }
    const released=result
      ?verifyStagingReadBeforeRelease(request,identity,base,base.ownerUserId,
        result.linearization,undefined,undefined,undefined,undefined,
        undefined,{scope:"global-all",areas:result.areaEpochs},
        undefined,{privateEpoch:result.privateEpoch},undefined,
        {notificationEpoch:result.notificationEpoch})
      :verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok"&&released!=="stale")return stagingIdentityRefusal(released);
    if(!c3bUnchanged(base)||released==="stale"){
      if(cacheKey)previews.delete(cacheKey);
      return answer(released==="stale"?409:503,
        released==="stale"?"read_stale_reload":"Staging unavailable");
    }
    if(!result||result.taskId!==taskId||
       result.restoreGeneration!==base.expectedRestoreGeneration)
      return answer(503,"Staging unavailable");
    if(result.source==="ai"){
      // A confirmed revoke may interleave with a finished provider promise
      // BEFORE HTTP releases the body. Re-read both durable stores from a
      // freshly authenticated child; never publish a stale AI suggestion.
      const current=await readC3bConsentInChild(
        childConfig(request,identity,base));
      // Consent check is a separate worker round trip. Recheck the ENTIRE
      // actor/Area/personal-plan/timezone witness at the last release point:
      // session-only revalidation here would leak an Area name if its ACL
      // were revoked after the first snapshot check.
      const last=verifyStagingReadBeforeRelease(
        request,identity,base,base.ownerUserId,
        result.linearization,undefined,undefined,undefined,undefined,
        undefined,{scope:"global-all",areas:result.areaEpochs},
        undefined,{privateEpoch:result.privateEpoch},undefined,
        {notificationEpoch:result.notificationEpoch});
      if(last!=="ok"&&last!=="stale")return stagingIdentityRefusal(last);
      if(last==="stale"){
        if(cacheKey)previews.delete(cacheKey);
        return answer(409,"read_stale_reload");
      }
      if(!current||!current.enabled||current.pending||
         current.epoch!==result.consentEpoch||!c3bUnchanged(base)){
        if(cacheKey)previews.delete(cacheKey);
        return answer(409,"read_stale_reload");
      }
      // The child finished its pending dispatch BEFORE this HTTP response.
      // A second process may revoke immediately after the child consent read.
      // Hold the SAME external BEGIN IMMEDIATE fence lock as revoke while
      // checking the grant AND materializing the response. That is the
      // linearization point for release; an in-flight revoke wins or waits.
      // Cached AI proposals also go through this exact path.
      const fence=openVerifiedInboxC3bFence(base.stagingDirectory);
      if(!fence){
        if(cacheKey)previews.delete(cacheKey);
        return answer(503,"Staging unavailable");
      }
      try{
        const response=materializeInboxAIUnderFence(fence,
          base.ownerUserId,base.expectedRestoreGeneration,
          INBOX_AI_DATA_SCOPE_VERSION,result.consentEpoch,()=>{
            if(!c3bUnchanged(base))return null;
            // Synchronously seal the final response body while revoke is
            // still excluded by the shared external SQLite write lock.
            return Response.json({taskId:result.taskId,why:result.why,
              token:result.token,changes:result.changes,source:result.source,
              restoreGeneration:result.restoreGeneration},{headers});
          });
        if(!response){
          if(cacheKey)previews.delete(cacheKey);
          return answer(409,"read_stale_reload");
        }
        if(!cached)rememberPreview(cacheKey,result);
        return response;
      }finally{fence.close();}
    }
    // Local rules have no OpenAI data or consent requirement.
    if(!cached)rememberPreview(cacheKey,result);
    return Response.json({taskId:result.taskId,why:result.why,
      token:result.token,changes:result.changes,source:result.source,
      restoreGeneration:result.restoreGeneration},{headers});
  }catch(error){
    logStagingFailure("target-staging/inbox/c3b-preview","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
export async function postC3b(
  request:Request,operation:"accept"|"undo"|"receipt"|"consent"|"cancel",
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
    const actorChild=childConfig(request,identity,base);
    if(operation==="consent"){
      const reply=await writeC3bConsentInChild(actorChild,
        obj.enabled?"grant":"revoke");
      const after=verifyStagingIdentityBeforeRelease(request,identity,base);
      if(after!=="ok")return stagingIdentityRefusal(after);
      if(!reply||!c3bUnchanged(base,true))return answer(503,"Staging unavailable");
      previews.clear(); // explicit consent/revoke invalidates every actor cache
      return Response.json({ok:true,enabled:reply.enabled,
        pending:reply.pending},{status:reply.pending?202:200,headers});
    }
    if(operation==="receipt"||operation==="cancel"){
      const reply=operation==="receipt"
        ?await receiptC3bInChild(actorChild,
          obj.command as InboxAcceptCommand|InboxAcceptReceiptQuery)
        :await cancelC3bInChild(actorChild,
          obj.command as InboxAcceptReceiptQuery|InboxAcceptUndoCommand);
      const release=reply
        ?verifyStagingReadBeforeRelease(request,identity,base,base.ownerUserId,
          reply.linearization,undefined,undefined,undefined,undefined,
          undefined,{scope:"global-all",areas:reply.areaEpochs})
        :verifyStagingIdentityBeforeRelease(request,identity,base);
      if(release!=="ok"&&release!=="stale")return stagingIdentityRefusal(release);
      if(release==="stale")return answer(409,"read_stale_reload");
      if(!reply||!c3bUnchanged(base,operation==="cancel"))
        return answer(503,"Staging unavailable");
      if(reply.status==="conflict")return answer(409,"Idempotency conflict");
      return Response.json({ok:true,status:reply.status,next:reply.next},{headers});
    }
    const reply=operation==="accept"
      ?await acceptC3bInChild(actorChild,obj.command as InboxAcceptCommand)
      :await undoC3bInChild(actorChild,obj.command as InboxAcceptUndoCommand);
    // A committed write cannot safely be reclassified as uncommitted
    // after a lost response; receipt reconciliation preserves UUID.
    const after=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(after!=="ok")return stagingIdentityRefusal(after);
    if(!c3bUnchanged(base,true))return answer(503,"Staging unavailable");
    if(reply?.ok===false&&reply.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,base);
    if(reply?.ok===true)previews.clear();
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
    const result=await readC3bConsentInChild(
      childConfig(request,identity,base));
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
