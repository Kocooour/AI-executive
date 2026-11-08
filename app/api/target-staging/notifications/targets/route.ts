/** R2d.5d.3: default-off staging-only register/revoke of the actor's OWN push device.
 * The browser endpoint is hashed HERE; only the SHA-256 reaches a child or the store. */
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin}
  from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingUnauthorizedRefusal,stagingChildSessionConfig,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {
  notificationsWriteHttpEnabled,notificationsHttpConfig,notificationsHttpUnchanged,
  notificationsHttpAnswer,notificationsTargetCommand,
} from "../../../../../lib/target-staging-notifications-http";
import {writeNotificationTargetInChild}
  from "../../../../../lib/target-staging-notifications-process";
import {
  targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse,
} from "../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=notificationsHttpAnswer;

export async function POST(request:Request):Promise<Response> {
  if(!notificationsWriteHttpEnabled())return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=notificationsHttpConfig();
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
    const limited=enforceRateLimit(request,"target-staging-notification-target-write",30,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    // 8 KiB: an endpoint is at most 2048 characters (never logged or echoed).
    const body=await readJsonBody<unknown>(request,8*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(body);
    if(legacy)return legacy;
    const command=notificationsTargetCommand(body);
    if(!command)return refuse(400,"Invalid request");
    const before=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(before!=="ok")return stagingIdentityRefusal(before);
    if(!notificationsHttpUnchanged(base,true))return refuse(503,"Staging unavailable");
    const result=await writeNotificationTargetInChild({
      ...base,...stagingChildSessionConfig(identity),
    },command);
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
    if(!notificationsHttpUnchanged(base,true)||!result)
      return refuse(503,"Staging unavailable");
    if(result.ok===false){
      // Own live endpoint registered again: idempotent, returns the same own ID.
      if(result.reason==="unchanged"&&command.action==="register")
        return Response.json({ok:true,unchanged:true,targetId:result.targetId},{headers});
      if(result.reason==="unavailable")return refuse(404,"Not found");
      if(result.reason==="invalid_request")return refuse(400,"Invalid request");
      if(result.reason==="resync_required")return resyncRequiredResponse();
      if(["stale_revision","idempotency_conflict","unchanged"]
        .includes(result.reason))return refuse(409,"Revision conflict");
      return refuse(503,"Staging unavailable");
    }
    if(command.action==="revoke")
      return Response.json(result.replayed?{ok:true,replayed:true}:{ok:true},{headers});
    if(result.targetId===null)return refuse(404,"Not found");
    return Response.json(result.replayed
      ?{ok:true,replayed:true,targetId:result.targetId}
      :{ok:true,targetId:result.targetId},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return refuse(error.status,error.message);
    logStagingFailure("target-staging/notification-target-write","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
