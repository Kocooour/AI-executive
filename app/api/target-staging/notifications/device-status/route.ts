/** E-2: read-only — is the browser's current PushSubscription the actor's OWN live
 * device? Opening Settings never registers a device; only an explicit click does.
 * POST only because the subscription (endpoint + keys) must not appear in a URL. */
import {HttpInputError,enforceRateLimit,readJsonBody,requireTargetSameOrigin}
  from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingUnauthorizedRefusal,stagingChildSessionConfig,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {
  notificationsWriteHttpEnabled,notificationsHttpConfig,notificationsHttpUnchanged,
  notificationsHttpAnswer,
} from "../../../../../lib/target-staging-notifications-http";
import {targetProtocolRefusal} from "../../../../../lib/target-staging-write-contract";
import {targetPushEndpointHash,targetPushSubscription} from "../../../../../lib/target-push-endpoint";
import {readTargetPushDeviceStatusInChild} from "../../../../../lib/target-push-process";

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
    requireTargetSameOrigin(request);
    const admitted=admitStagingIdentity(request,identity,base);
    if(admitted)return admitted;
    if(new URL(request.url).search!=="")return refuse(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);
    if(protocol)return protocol;
    const limited=enforceRateLimit(request,"target-staging-notification-device-status",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const body=await readJsonBody<unknown>(request,4*1024,{strictUtf8:true});
    const x=body&&typeof body==="object"&&!Array.isArray(body)?body as Record<string,unknown>:null;
    if(!x||Object.keys(x).join(",")!=="subscription")return refuse(400,"Invalid request");
    const subscription=targetPushSubscription(x.subscription);
    if(!subscription)return refuse(400,"Invalid request");
    const before=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(before!=="ok")return stagingIdentityRefusal(before);
    if(!notificationsHttpUnchanged(base,true))return refuse(503,"Staging unavailable");
    const result=await readTargetPushDeviceStatusInChild({...base,...stagingChildSessionConfig(identity)},
      {...subscription,endpointHash:targetPushEndpointHash(subscription.endpoint)});
    const after=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(after!=="ok")return stagingIdentityRefusal(after);
    if(result?.ok===false)return stagingUnauthorizedRefusal(request,identity,base);
    if(!notificationsHttpUnchanged(base,true)||!result)return refuse(503,"Staging unavailable");
    return Response.json(result.status==="registered"
      ?{registered:true,targetId:result.targetId}:{registered:false},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return refuse(error.status,error.message);
    logStagingFailure("target-staging/notification-device-status","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
