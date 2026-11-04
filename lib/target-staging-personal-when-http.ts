/** Default-off staging-only R2d.3k.4b actor-private whenOn command HTTP. */
import path from "node:path";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {StagingHttpIdentity} from "./target-staging-http-identity";
import type {PersonalWhenCommandPreview} from "./target-personal-when-command-read";
import type {TargetStagingPersonalWhenCommand} from "./target-personal-when-writer";
import {validTargetStagingPersonalWhenCommand} from "./target-personal-when-writer";
import {verifyStagingReadBeforeRelease} from "./target-staging-http-identity";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
export const personalWhenHttpEnabled=()=>[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED",
].every(name=>process.env[name]==="true");

export function personalWhenHttpConfig():StagingPersonalReadConfig|null {
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!UUID.test(expectedRestoreGeneration)||
    !ownerUserId||!ACTOR.test(ownerUserId))return null;
  return {stagingDirectory,expectedRestoreGeneration,ownerUserId};
}
export function personalWhenHttpUnchanged(config:StagingPersonalReadConfig):boolean {
  const current=personalWhenHttpConfig();
  return personalWhenHttpEnabled()&&
    current?.stagingDirectory===config.stagingDirectory&&
    current.expectedRestoreGeneration===config.expectedRestoreGeneration&&
    current.ownerUserId===config.ownerUserId;
}
export const personalWhenHttpAnswer=(status:number,error:string):Response=>
  Response.json({error},{status,headers:{"cache-control":"no-store"}});
export function personalWhenHttpTaskId(id:unknown):id is string {
  return typeof id==="string"&&id.length>0&&
    Buffer.byteLength(id,"utf8")<=4096&&!id.includes("\0")&&id.isWellFormed();
}
export function personalWhenHttpCommand(value:unknown):TargetStagingPersonalWhenCommand|null {
  return validTargetStagingPersonalWhenCommand(value)&&
    personalWhenHttpTaskId(value.taskId)?value:null;
}
export function verifyPersonalWhenPreviewLive(
  request:Request,identity:StagingHttpIdentity,store:StagingPersonalReadConfig,
  preview:PersonalWhenCommandPreview,
) {
  return verifyStagingReadBeforeRelease(request,identity,store,store.ownerUserId,
    preview.linearization,undefined,undefined,undefined,undefined,undefined,
    undefined,preview.guard,{privateEpoch:preview.expectedPrivateEpoch});
}
