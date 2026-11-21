/** C-3a: actor-bound read-only receipt reconciliation after uncertain writes. */
import {HttpInputError,enforceRateLimit,readJsonBody,requireTargetSameOrigin}
  from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingReadBeforeRelease,verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {targetProtocolRefusal,legacySnapshotRefusal}
  from "../../../../../lib/target-staging-write-contract";
import {targetInboxWriteEnabled,targetInboxHttpConfig,targetInboxHttpUnchanged,
  targetInboxCommand,inboxAnswer} from "../../../../../lib/target-inbox-http";
import {readInboxTriageReceiptInChild} from "../../../../../lib/target-inbox-http-process";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
export async function POST(request:Request):Promise<Response>{
  if(!targetInboxWriteEnabled())return inboxAnswer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=targetInboxHttpConfig();
  if(!base)return inboxAnswer(503,"Staging unavailable");
  try{
    requireTargetSameOrigin(request);
    const admission=admitStagingIdentity(request,identity,base);
    if(admission)return admission;
    if(new URL(request.url).search!=="")return inboxAnswer(400,"Invalid request");
    const protocol=targetProtocolRefusal(request);
    if(protocol)return protocol;
    const limited=enforceRateLimit(request,"target-staging-inbox-receipt",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{status:429,
      headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const body=await readJsonBody<unknown>(request,32*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(body);
    if(legacy)return legacy;
    const command=targetInboxCommand(body);
    if(!command)return inboxAnswer(400,"Invalid request");
    const result=await readInboxTriageReceiptInChild(
      {...base,...stagingChildSessionConfig(identity)},command);
    const release=result
      ?verifyStagingReadBeforeRelease(request,identity,base,base.ownerUserId,
        result.linearization,undefined,undefined,undefined,undefined,undefined,
        {scope:"global-all",areas:result.areaEpochs})
      :verifyStagingIdentityBeforeRelease(request,identity,base);
    if(release!=="ok"&&release!=="stale")return stagingIdentityRefusal(release);
    if(!targetInboxHttpUnchanged(base))return inboxAnswer(503,"Staging unavailable");
    if(release==="stale")return inboxAnswer(409,"read_stale_reload");
    if(!result)return inboxAnswer(503,"Staging unavailable");
    if(result.status==="conflict")return inboxAnswer(409,"Idempotency conflict");
    // Never send the internal actor/Area witness to a client.
    // not_recorded does NOT prove that an in-flight write cannot still commit.
    return Response.json({ok:true,status:result.status,next:result.next},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return inboxAnswer(error.status,error.message);
    logStagingFailure("target-staging/inbox/receipt","route_exception",error);
    return inboxAnswer(503,"Staging unavailable");
  }
}
