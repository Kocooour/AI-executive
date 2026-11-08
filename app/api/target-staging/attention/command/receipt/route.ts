/** R2d.5c.2: read-only confirmation of an uncertain Attention lifecycle command. */
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin}
  from "../../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingIdentityBeforeRelease,
} from "../../../../../../lib/target-staging-http-identity";
import {
  attentionCommandHttpEnabled,attentionCommandHttpConfig,attentionCommandHttpUnchanged,
  attentionCommandHttpAnswer,attentionCommandHttpCommand,verifyAttentionCommandPreviewLive,
} from "../../../../../../lib/target-staging-attention-command-http";
import {readAttentionCommandReceiptSnapshotInChild}
  from "../../../../../../lib/target-staging-attention-command-process";
import {
  targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse,
  writeAreaMismatchResponse,
} from "../../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=attentionCommandHttpAnswer;

export async function POST(request:Request):Promise<Response> {
  if(!attentionCommandHttpEnabled())return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=attentionCommandHttpConfig();
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
    const limited=enforceRateLimit(request,"target-staging-attention-command-receipt",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const body=await readJsonBody<unknown>(request,32*1024,{strictUtf8:true});
    const legacy=legacySnapshotRefusal(body);
    if(legacy)return legacy;
    const command=attentionCommandHttpCommand(body);
    if(!command)return refuse(400,"Invalid request");
    const before=verifyStagingIdentityBeforeRelease(request,identity,base);
    if(before!=="ok")return stagingIdentityRefusal(before);
    if(!attentionCommandHttpUnchanged(base))return refuse(503,"Staging unavailable");

    // Current write ACL, attention epoch and the exact old command receipt are
    // read in one pinned snapshot; ACL is checked before the receipt lookup.
    const snapshot=await readAttentionCommandReceiptSnapshotInChild(
      {...base,...stagingChildSessionConfig(identity)},command);
    const released=snapshot?.ok===true
      ? verifyAttentionCommandPreviewLive(request,identity,base,snapshot.preview)
      : verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok"&&released!=="stale")return stagingIdentityRefusal(released);
    if(!attentionCommandHttpUnchanged(base))return refuse(503,"Staging unavailable");
    if(released==="stale"||snapshot?.ok===false)return refuse(404,"Not found");
    if(!snapshot)return refuse(503,"Staging unavailable");
    const result=snapshot.receipt;
    if(result.ok===false){
      if(result.reason==="unavailable")return refuse(404,"Not found");
      if(result.reason==="resync_required")return resyncRequiredResponse();
      if(result.reason==="write_area_mismatch")return writeAreaMismatchResponse();
      return refuse(409,"Revision conflict");
    }
    return Response.json({status:result.status},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return refuse(error.status,error.message);
    logStagingFailure("target-staging/attention-command-receipt","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
