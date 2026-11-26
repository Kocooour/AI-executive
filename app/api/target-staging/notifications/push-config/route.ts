/** E-2: whether target push can deliver, and the public VAPID key a browser must
 * subscribe with. Nothing secret: no private key, subject, endpoint or device. */
import {enforceRateLimit} from "../../../../../lib/http-security";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  admitStagingIdentity,stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {
  notificationsReadHttpEnabled,notificationsHttpConfig,notificationsHttpUnchanged,
  notificationsHttpAnswer,
} from "../../../../../lib/target-staging-notifications-http";
import {targetPushFlagsEnabled} from "../../../../../lib/target-push-process";
import {targetVapidConfig} from "../../../../../lib/target-push-vapid";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=notificationsHttpAnswer;

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
  if(new URL(request.url).search!=="")return refuse(400,"Invalid request");
  const limited=enforceRateLimit(request,"target-staging-notification-push-config",60,600000);
  if(limited)return Response.json({error:"Too many requests"},{
    status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
  });
  const released=verifyStagingIdentityBeforeRelease(request,identity,base);
  if(released!=="ok")return stagingIdentityRefusal(released);
  if(!notificationsHttpUnchanged(base,false))return refuse(503,"Staging unavailable");
  // Delivery needs the write flags (the pass records deliveries) and valid keys.
  const vapid=targetPushFlagsEnabled()?targetVapidConfig():null;
  return Response.json(vapid?{available:true,publicKey:vapid.publicKey}:{available:false,publicKey:null},{headers});
}
