/** R2d.5d.3: default-off staging-only actor-private notification settings read and CAS write. */
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin}
  from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingUnauthorizedRefusal,stagingChildSessionConfig,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {
  notificationsReadHttpEnabled,notificationsWriteHttpEnabled,notificationsHttpConfig,
  notificationsHttpUnchanged,notificationsHttpAnswer,notificationsSettingsCommand,
  verifyNotificationSettingsLive,
} from "../../../../../lib/target-staging-notifications-http";
import {readStagingNotificationSettingsInChild}
  from "../../../../../lib/target-staging-read-process";
import {writeNotificationSettingsInChild}
  from "../../../../../lib/target-staging-notifications-process";
import {
  targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse,
} from "../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=notificationsHttpAnswer;

/** The actor's OWN settings, CAS inputs and live target IDs from one pinned snapshot. */
export async function GET(request:Request):Promise<Response> {
  if(!notificationsReadHttpEnabled())return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=notificationsHttpConfig();
  if(!base)return refuse(503,"Staging unavailable");
  const admitted=admitStagingIdentity(request,identity,base);
  if(admitted)return admitted;
  try {
    if(new URL(request.url).search!=="")return refuse(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-notification-settings",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const result=await readStagingNotificationSettingsInChild(
      {...base,...stagingChildSessionConfig(identity)});
    const released=result?.ok===true
      ? verifyNotificationSettingsLive(request,identity,base,
          result.settings.actorUserId,result.settings.notificationEpoch)
      : verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok"&&released!=="stale")return stagingIdentityRefusal(released);
    if(!notificationsHttpUnchanged(base,false))return refuse(503,"Staging unavailable");
    if(released==="stale")return refuse(409,"read_stale_reload");
    if(result?.ok===false)return refuse(404,"Not found");
    if(!result)return refuse(503,"Staging unavailable");
    const s=result.settings;
    // Never expose the actor, endpoint hashes, other users or the live guard.
    return Response.json({
      timeZone:s.timeZone,attentionPush:s.attentionPush,quietStart:s.quietStart,
      quietEnd:s.quietEnd,dailyLimit:s.dailyLimit,paused:s.paused,
      expectedSettingsRevision:s.settingsRevision,
      expectedNotificationEpoch:s.notificationEpoch,
      restoreGeneration:base.expectedRestoreGeneration,targets:s.targetIds,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/notification-settings","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}

/** CSRF-safe exact ten-field command; the child validates the durable session
 * inside the pinned BEGIN IMMEDIATE transaction before committing. */
export async function PATCH(request:Request):Promise<Response> {
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
    const limited=enforceRateLimit(request,"target-staging-notification-settings-write",30,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const body=await readJsonBody<unknown>(request,8*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(body);
    if(legacy)return legacy;
    const command=notificationsSettingsCommand(body);
    if(!command)return refuse(400,"Invalid request");
    const before=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(before!=="ok")return stagingIdentityRefusal(before);
    if(!notificationsHttpUnchanged(base,true))return refuse(503,"Staging unavailable");
    const result=await writeNotificationSettingsInChild({
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
    if(!notificationsHttpUnchanged(base,true)||!result)
      return refuse(503,"Staging unavailable");
    if(result.ok===false){
      if(result.reason==="unavailable")return refuse(404,"Not found");
      if(result.reason==="invalid_request")return refuse(400,"Invalid request");
      if(result.reason==="resync_required")return resyncRequiredResponse();
      if(["stale_revision","idempotency_conflict","unchanged"]
        .includes(result.reason))return refuse(409,"Revision conflict");
      return refuse(503,"Staging unavailable");
    }
    return Response.json(result.replayed?{ok:true,replayed:true}:{ok:true},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return refuse(error.status,error.message);
    logStagingFailure("target-staging/notification-settings-write","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
