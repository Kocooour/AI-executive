/** C-3a: server-authorized Inbox read/count. Never emit legacy data or ACL proof. */
import path from "node:path";
import {enforceRateLimit} from "../../../../lib/http-security";
import {logStagingFailure} from "../../../../lib/target-staging-failure-log";
import {
  resolveStagingHttpIdentity,stagingAnchorRefusal,stagingUnauthenticatedRefusal,
  stagingChildSessionConfig,admitStagingIdentity,stagingIdentityRefusal,
  verifyStagingReadBeforeRelease,verifyStagingIdentityBeforeRelease,
} from "../../../../lib/target-staging-http-identity";
import {readStagingTargetInboxInChild} from "../../../../lib/target-staging-read-process";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"cache-control":"no-store"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
const refuse=(status:number,error:string)=>Response.json({error},{status,headers});
export const targetInboxReadEnabled=()=>
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED==="true";

export async function GET(request:Request):Promise<Response>{
  if(!targetInboxReadEnabled())return refuse(404,"Not found");
  const anchor=stagingAnchorRefusal(request,true);
  if(anchor)return anchor;
  const identity=resolveStagingHttpIdentity(request);
  if(!identity)return stagingUnauthenticatedRefusal(request);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
      !expectedRestoreGeneration||!uuid.test(expectedRestoreGeneration)||
      !ownerUserId||!actor.test(ownerUserId))return refuse(503,"Staging unavailable");
  const store={stagingDirectory,expectedRestoreGeneration};
  const admission=admitStagingIdentity(request,identity,store);
  if(admission)return admission;
  try{
    const params=new URL(request.url).searchParams;
    if([...params.keys()].some(k=>k!=="limit"&&k!=="cursor")||
        params.getAll("limit").length>1||params.getAll("cursor").length>1)
      return refuse(400,"Invalid request");
    const rawLimit=params.get("limit");
    if(rawLimit!==null&&!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit))
      return refuse(400,"Invalid request");
    const limit=rawLimit===null?50:Number(rawLimit);
    const cursor=params.get("cursor");
    if(cursor!==null&&(!cursor||Buffer.byteLength(cursor)>512||
      /[\u0000-\u001f\u007f]/u.test(cursor)))return refuse(400,"Invalid request");
    const limited=enforceRateLimit(request,"target-staging-inbox",100,600000);
    if(limited)return Response.json({error:"Too many requests"},{status:429,
      headers:{...headers,"retry-after":String(limited.retryAfter)}});
    const page=await readStagingTargetInboxInChild({
      ...store,ownerUserId,...stagingChildSessionConfig(identity),
    },limit,cursor);
    const released=page
      ?verifyStagingReadBeforeRelease(request,identity,store,ownerUserId,
        page.linearization,undefined,undefined,undefined,undefined,undefined,
        {scope:"global-all",areas:page.areaEpochs})
      :verifyStagingIdentityBeforeRelease(request,identity,store);
    if(released!=="ok"&&released!=="stale")return stagingIdentityRefusal(released);
    if(!targetInboxReadEnabled()||
       process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY!==stagingDirectory||
       process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION!==expectedRestoreGeneration||
       process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID!==ownerUserId)
      return refuse(503,"Staging unavailable");
    if(released==="stale")return refuse(409,"read_stale_reload");
    if(!page)return refuse(503,"Staging unavailable");
    return Response.json({
      items:page.items,count:page.count,nextCursor:page.nextCursor,
      restoreGeneration:expectedRestoreGeneration,
    },{headers});
  }catch(error){
    logStagingFailure("target-staging/inbox","route_exception",error);
    return refuse(503,"Staging unavailable");
  }
}
