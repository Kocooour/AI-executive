/** R2d.5c.1: isolated default-off Attention candidates GET (read-only). */
import {createHash} from "node:crypto";
import path from "node:path";
import {authenticationBinding} from "../../../../lib/auth";
import {enforceRateLimit} from "../../../../lib/http-security";
import {logStagingFailure} from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,stagingCursorIdentity,admitStagingIdentity,
  stagingIdentityRefusal,verifyStagingIdentityBeforeRelease,verifyStagingReadBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import {attentionEvaluationWindow} from "../../../../lib/target-attention-read-model";
import type {AttentionAreaFilter,AttentionView}
  from "../../../../lib/target-attention-read-model";
import {readStagingAttentionInChild} from "../../../../lib/target-staging-read-process";
import {signStagingProjectHttpCursor,verifyStagingProjectHttpCursor}
  from "../../../../lib/target-staging-project-http-cursor";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const cursorPattern=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const answer=(status:number,error:string):Response=>
  Response.json({error},{status,headers});
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED==="true";

/** The evaluation instant is NOT part of this hash: it is a separately signed
 * claim of the cursor itself (see signStagingProjectHttpCursor `instantMs`). */
function attentionCursorBinding(
  binding:string,areaFilter:AttentionAreaFilter,view:AttentionView,
  timeZone:string,limit:number,
):string {
  return createHash("sha256").update("lumi:r2d5:attention-http-cursor:v1\0")
    .update(JSON.stringify([binding,areaFilter,view,timeZone,limit]))
    .digest("base64url");
}

export async function GET(request:Request):Promise<Response>{
  if(!enabled())return answer(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!uuid.test(expectedRestoreGeneration)||
    !ownerUserId||!actor.test(ownerUserId))
    return answer(503,"Staging unavailable");
  const store={stagingDirectory,expectedRestoreGeneration};
  const refused=admitStagingIdentity(request,identity,store);
  if(refused)return refused;

  try {
    const params=new URL(request.url).searchParams;
    const keys=["areaFilter","view","timeZone","limit","cursor"];
    if([...params.keys()].some(k=>!keys.includes(k))||
      keys.some(k=>params.getAll(k).length>1))return answer(400,"Invalid request");
    const areaFilter=params.get("areaFilter")??"all";
    const view=params.get("view")??"active";
    const timeZone=params.get("timeZone");
    if(!["all","personal","shared"].includes(areaFilter)||
      !["active","hidden"].includes(view)||
      timeZone===null||attentionEvaluationWindow(0,timeZone)===null)
      return answer(400,"Invalid request");
    const rawLimit=params.get("limit");
    if(rawLimit!==null&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return answer(400,"Invalid request");
    const limit=rawLimit===null?50:Number(rawLimit);
    const cursor=params.get("cursor");
    if(cursor!==null&&(cursor.length>4096||!cursorPattern.test(cursor)))
      return answer(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-attention",120,600000);
    if(limited)return Response.json({error:"Too many requests"},{
      status:429,headers:{...headers,"retry-after":String(limited.retryAfter)},
    });
    const filter=areaFilter as AttentionAreaFilter;
    const selected=view as AttentionView;
    const identityBinding=stagingCursorIdentity(
      identity,ownerUserId,authenticationBinding(request));
    const context={
      ...identityBinding,
      authenticationBinding:attentionCursorBinding(identityBinding.authenticationBinding,
        filter,selected,timeZone,limit),
      stagingDirectory,restoreGeneration:expectedRestoreGeneration,
      sessionSecret:process.env.AI_EXECUTIVE_SESSION_SECRET||"",
    };
    const nowSeconds=Math.floor(Date.now()/1000);
    const previous=cursor===null?null:
      verifyStagingProjectHttpCursor(context,cursor,nowSeconds,true);
    if(previous?.ok===false)return answer(previous.reason==="expired"?409:400,
      previous.reason==="expired"?"Cursor expired":"Invalid cursor");
    const offset=previous?.ok===true?previous.offset:0;
    // Server clock only; later pages reuse the instant signed into the cursor.
    const evaluatedAtMs=previous?.ok===true?previous.instantMs as number:Date.now();
    if(attentionEvaluationWindow(evaluatedAtMs,timeZone)===null)
      return answer(400,"Invalid cursor");
    const page=await readStagingAttentionInChild({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
      ...stagingChildSessionConfig(identity),
    },filter,selected,evaluatedAtMs,timeZone,limit,offset);
    // One live transaction: session, Area/content epochs, private plan epoch
    // and attention epoch (a lifecycle write moves it) before any release.
    const release=page?verifyStagingReadBeforeRelease(
      request,identity,store,ownerUserId,page.linearization,
      undefined,undefined,undefined,undefined,undefined,
      {areas:page.areaEpochs,scope:"my-plan"},undefined,
      {privateEpoch:page.privateEpoch},
      {attentionEpoch:page.attentionEpoch}
    ):verifyStagingIdentityBeforeRelease(request,identity,store);
    if(release!=="ok"&&release!=="stale")return stagingIdentityRefusal(release);
    if(!enabled()||
      process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY!==stagingDirectory||
      process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION!==expectedRestoreGeneration||
      process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID!==ownerUserId)
      return answer(503,"Staging unavailable");
    if(release==="stale")return answer(409,"read_stale_reload");
    if(!page){
      logStagingFailure("attention","child_page_unavailable");
      return answer(503,"Staging unavailable");
    }
    if(previous?.ok===true&&previous.revision!==page.revision)
      return answer(409,"Cursor stale");
    const nextCursor=page.hasMore?signStagingProjectHttpCursor(
      context,page.revision,offset+page.items.length,
      previous?.ok===true?previous.expiresAt:undefined,nowSeconds,evaluatedAtMs):null;
    if(page.hasMore&&!nextCursor)return answer(503,"Staging unavailable");
    // Strict DTO. attentionEpoch is the lifecycle command's CAS input: a
    // per-actor counter of the actor's own state, no foreign data. No private
    // epoch, linearization, Area epochs, revision or actor id.
    return Response.json({
      items:page.items,hasMore:page.hasMore,nextCursor,areaFilter:page.areaFilter,
      view:page.view,timeZone:page.timeZone,evaluationDate:page.evaluationDate,
      soonThroughDate:page.soonThroughDate,evaluatedAtMs:page.evaluatedAtMs,
      attentionEpoch:page.attentionEpoch,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/attention","route_exception",error);
    return answer(503,"Staging unavailable");
  }
}
