/** R3-FE-1: default-off staging-only opaque auth-generation for the target client runtime. */
import {enforceRateLimit} from "../../../../lib/http-security";
import {logStagingFailure} from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  admitStagingIdentity,stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import {readTargetStagingAuthEpochLive} from "../../../../lib/target-staging-durable-session";
import {
  targetUiEnabled,targetSessionGenerationConfig,targetSessionGenerationUnchanged,
  targetAuthGeneration,
} from "../../../../lib/target-staging-session-generation";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=(status:number,error:string):Response=>
  Response.json({error},{status,headers});

export async function GET(request:Request):Promise<Response> {
  if(!targetUiEnabled())return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=targetSessionGenerationConfig();
  if(!base)return refuse(503,"Staging unavailable");
  const admitted=admitStagingIdentity(request,identity,base);
  if(admitted)return admitted;
  try {
    // Any query, including a bare "?" (URL.search is then ""), is refused.
    if(request.url.includes("?"))return refuse(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-session-generation",120,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const live=readTargetStagingAuthEpochLive(base,
      identity.kind==="owner"?{ownerUserId:base.ownerUserId}:{tokenHash:identity.tokenHash});
    if(live.ok===false){
      if(live.reason==="unavailable")return refuse(503,"Staging unavailable");
      return stagingIdentityRefusal(live.code);
    }
    const released=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok")return stagingIdentityRefusal(released);
    if(!targetSessionGenerationUnchanged(base))return refuse(503,"Staging unavailable");
    return Response.json({generation:targetAuthGeneration(request,identity,live.epoch)},{headers});
  }catch(error){
    logStagingFailure("target-staging/session-generation","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
