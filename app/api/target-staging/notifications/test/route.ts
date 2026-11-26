/** E-2: one content-free test notification to the actor's OWN live device. The
 * browser sends its current PushSubscription; the child confirms in the verified
 * store that its endpoint hash is the actor's live target before sending. */
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
import {sendTargetPushTestInChild} from "../../../../../lib/target-push-process";

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
    // A test message reaches a real device: keep it rare.
    const limited=enforceRateLimit(request,"target-staging-notification-test",5,600000);
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
    const result=await sendTargetPushTestInChild({...base,...stagingChildSessionConfig(identity)},
      {...subscription,endpointHash:targetPushEndpointHash(subscription.endpoint)});
    const after=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(after!=="ok")return stagingIdentityRefusal(after);
    if(result?.ok===false&&result.reason==="session_revoked")
      return stagingUnauthorizedRefusal(request,identity,base);
    if(!notificationsHttpUnchanged(base,true)||!result)return refuse(503,"Staging unavailable");
    if(result.ok===false)
      return result.reason==="not_found"?refuse(404,"Not found"):refuse(503,"Push unavailable");
    return Response.json({ok:true,result:result.result,targetId:result.targetId},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return refuse(error.status,error.message);
    logStagingFailure("target-staging/notification-test","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
