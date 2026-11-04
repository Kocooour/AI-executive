/** R2d.3k.4b: default-off staging-only private whenOn CAS preview and set/clear. */
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin}
  from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingUnauthorizedRefusal,stagingChildSessionConfig,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {
  personalWhenHttpEnabled,personalWhenHttpConfig,personalWhenHttpUnchanged,
  personalWhenHttpAnswer,personalWhenHttpTaskId,personalWhenHttpCommand,
  verifyPersonalWhenPreviewLive,
} from "../../../../../lib/target-staging-personal-when-http";
import {readStagingPersonalWhenPreviewInChild}
  from "../../../../../lib/target-staging-read-process";
import {writePersonalWhenInChild}
  from "../../../../../lib/target-staging-personal-when-http-process";
import {
  targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse,
  writeAreaMismatchResponse,
} from "../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=personalWhenHttpAnswer;

/** One pinned actor-private snapshot for task CAS + private plan CAS values. */
export async function GET(request:Request):Promise<Response> {
  if(!personalWhenHttpEnabled())return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=personalWhenHttpConfig();
  if(!base)return refuse(503,"Staging unavailable");
  const admitted=admitStagingIdentity(request,identity,base);
  if(admitted)return admitted;
  try {
    const query=new URL(request.url).searchParams;
    if([...query.keys()].some(k=>k!=="taskId")||
        query.getAll("taskId").length!==1||
        !personalWhenHttpTaskId(query.get("taskId")))
      return refuse(400,"Invalid request");
    const taskId=query.get("taskId") as string;
    const limited=enforceRateLimit(request,"target-staging-personal-when-command-preview",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const result=await readStagingPersonalWhenPreviewInChild(
      {...base,...stagingChildSessionConfig(identity)},taskId);
    const released=result?.ok===true
      ? verifyPersonalWhenPreviewLive(request,identity,base,result.preview)
      : verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok"&&released!=="stale")return stagingIdentityRefusal(released);
    if(!personalWhenHttpUnchanged(base))return refuse(503,"Staging unavailable");
    if(released==="stale"||result?.ok===false)return refuse(404,"Not found");
    if(!result)return refuse(503,"Staging unavailable");
    const p=result.preview;
    // Never expose the actor, Area witness, raw task detail, or live guard.
    return Response.json({
      expectedRevision:p.expectedRevision,
      expectedPrivateEpoch:p.expectedPrivateEpoch,
      expectedPlanRevision:p.expectedPlanRevision,
      whenOn:p.whenOn,writeAreaId:p.writeAreaId,
      restoreGeneration:base.expectedRestoreGeneration,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/personal-when-command-preview","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}

/** CSRF-safe exact eight-field command; child validates durable session
 * inside the pinned BEGIN IMMEDIATE transaction before committing. */
export async function PATCH(request:Request):Promise<Response> {
  if(!personalWhenHttpEnabled())return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=personalWhenHttpConfig();
  if(!base)return refuse(503,"Staging unavailable");
  try {
    requireSameOrigin(request);
    if(request.headers.get("origin")!==new URL(request.url).origin)
      return refuse(403,"Cross-origin request rejected");
    const admitted=admitStagingIdentity(request,identity,base);
    if(admitted)return admitted;
    if(new URL(request.url).search!=="")return refuse(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);
    if(protocol)return protocol;
    const limited=enforceRateLimit(request,"target-staging-personal-when-command-write",30,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const body=await readJsonBody<unknown>(request,32*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(body);
    if(legacy)return legacy;
    const command=personalWhenHttpCommand(body);
    if(!command)return refuse(400,"Invalid request");
    const before=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(before!=="ok")return stagingIdentityRefusal(before);
    if(!personalWhenHttpUnchanged(base))return refuse(503,"Staging unavailable");
    const result=await writePersonalWhenInChild({
      ...base,...stagingChildSessionConfig(identity),
    },command);
    // Avoid an apparent 401 after an actual durable-session commit.
    if(identity.kind==="owner"){
      const after=verifyStagingIdentityBeforeRelease(request,identity,base);
      if(after!=="ok")return stagingIdentityRefusal(after);
    }
    if(result?.ok===false&&result.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,base);
    if(!result&&identity.kind==="session"){
      const after=verifyStagingIdentityBeforeRelease(request,identity,base);
      if(after!=="ok")return stagingIdentityRefusal(after);
    }
    if(!personalWhenHttpUnchanged(base)||!result)
      return refuse(503,"Staging unavailable");
    if(result.ok===false){
      if(result.reason==="unavailable")return refuse(404,"Not found");
      if(result.reason==="resync_required")return resyncRequiredResponse();
      if(result.reason==="write_area_mismatch")return writeAreaMismatchResponse();
      if(["stale_revision","idempotency_conflict","unchanged"].includes(result.reason))
        return refuse(409,"Revision conflict");
      return refuse(503,"Staging unavailable");
    }
    return Response.json(result.replayed?{ok:true,replayed:true}:{ok:true},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return refuse(error.status,error.message);
    logStagingFailure("target-staging/personal-when-command-write","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
