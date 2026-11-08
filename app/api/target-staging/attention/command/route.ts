/** R2d.5c.2: default-off staging-only Attention lifecycle CAS preview and snooze/dismiss/restore. */
import {HttpInputError,enforceRateLimit,readJsonBody,requireSameOrigin}
  from "../../../../../lib/http-security";
import {logStagingFailure} from "../../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingUnauthorizedRefusal,stagingChildSessionConfig,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,
} from "../../../../../lib/target-staging-http-identity";
import {
  attentionCommandHttpEnabled,attentionCommandHttpConfig,attentionCommandHttpUnchanged,
  attentionCommandHttpAnswer,attentionCommandHttpTaskId,attentionCommandHttpCommand,
  verifyAttentionCommandPreviewLive,
} from "../../../../../lib/target-staging-attention-command-http";
import {readStagingAttentionCommandPreviewInChild}
  from "../../../../../lib/target-staging-read-process";
import {writeAttentionCommandInChild}
  from "../../../../../lib/target-staging-attention-command-process";
import {validTargetDueOn} from "../../../../../lib/target-task-temporal-due-on-writer";
import {
  targetProtocolRefusal,legacySnapshotRefusal,resyncRequiredResponse,
  writeAreaMismatchResponse,
} from "../../../../../lib/target-staging-write-contract";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const refuse=attentionCommandHttpAnswer;
const RULES=["deadline_overdue","deadline_soon","planned_date_passed"];

/** One pinned actor-bound snapshot: exactly the lifecycle command's CAS inputs. */
export async function GET(request:Request):Promise<Response> {
  if(!attentionCommandHttpEnabled())return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const base=attentionCommandHttpConfig();
  if(!base)return refuse(503,"Staging unavailable");
  const admitted=admitStagingIdentity(request,identity,base);
  if(admitted)return admitted;
  try {
    const query=new URL(request.url).searchParams;
    const keys=["taskId","ruleId","occurrenceOn"];
    const ruleId=query.get("ruleId"),occurrenceOn=query.get("occurrenceOn");
    if([...query.keys()].some(k=>!keys.includes(k))||
        keys.some(k=>query.getAll(k).length!==1)||
        !attentionCommandHttpTaskId(query.get("taskId"))||
        ruleId===null||!RULES.includes(ruleId)||
        occurrenceOn===null||!validTargetDueOn(occurrenceOn))
      return refuse(400,"Invalid request");
    const taskId=query.get("taskId") as string;
    const limited=enforceRateLimit(request,"target-staging-attention-command-preview",60,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const result=await readStagingAttentionCommandPreviewInChild(
      {...base,...stagingChildSessionConfig(identity)},taskId,ruleId,occurrenceOn);
    const released=result?.ok===true
      ? verifyAttentionCommandPreviewLive(request,identity,base,result.preview)
      : verifyStagingIdentityBeforeRelease(request,identity,base);
    if(released!=="ok"&&released!=="stale")return stagingIdentityRefusal(released);
    if(!attentionCommandHttpUnchanged(base))return refuse(503,"Staging unavailable");
    if(released==="stale"||result?.ok===false)return refuse(404,"Not found");
    if(!result)return refuse(503,"Staging unavailable");
    const p=result.preview;
    // Never expose the actor, Area witness, task detail, title or live guard.
    return Response.json({
      expectedRevision:p.expectedRevision,
      expectedAttentionEpoch:p.expectedAttentionEpoch,
      expectedStateRevision:p.expectedStateRevision,
      writeAreaId:p.writeAreaId,restoreGeneration:base.expectedRestoreGeneration,
      lifecycle:p.lifecycle,snoozedUntilMs:p.snoozedUntilMs,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/attention-command-preview","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}

/** CSRF-safe exact twelve-field command; child validates the durable session
 * inside the pinned BEGIN IMMEDIATE transaction before committing. */
export async function PATCH(request:Request):Promise<Response> {
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
    const limited=enforceRateLimit(request,"target-staging-attention-command-write",30,600000);
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
    const result=await writeAttentionCommandInChild({
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
    if(!attentionCommandHttpUnchanged(base)||!result)
      return refuse(503,"Staging unavailable");
    if(result.ok===false){
      if(result.reason==="unavailable")return refuse(404,"Not found");
      if(result.reason==="invalid_request")return refuse(400,"Invalid request");
      if(result.reason==="resync_required")return resyncRequiredResponse();
      if(result.reason==="write_area_mismatch")return writeAreaMismatchResponse();
      if(["stale_revision","idempotency_conflict","unchanged","not_active"]
        .includes(result.reason))return refuse(409,"Revision conflict");
      return refuse(503,"Staging unavailable");
    }
    return Response.json(result.replayed?{ok:true,replayed:true}:{ok:true},{headers});
  }catch(error){
    if(error instanceof HttpInputError)return refuse(error.status,error.message);
    logStagingFailure("target-staging/attention-command-write","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
