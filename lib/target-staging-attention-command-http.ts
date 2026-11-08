/** Default-off staging-only R2d.5c.2 actor-private Attention lifecycle command HTTP. */
import path from "node:path";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {StagingHttpIdentity} from "./target-staging-http-identity";
import type {AttentionCommandPreview} from "./target-attention-command-read";
import type {TargetStagingAttentionLifecycleCommand}
  from "./target-attention-lifecycle-writer";
import {validTargetStagingAttentionLifecycleCommand}
  from "./target-attention-lifecycle-writer";
import {verifyStagingReadBeforeRelease} from "./target-staging-http-identity";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
/** All four flags are required for the preview, PATCH and receipt alike. */
export const ATTENTION_COMMAND_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_WRITE_ENABLED",
] as const;
export const attentionCommandHttpEnabled=()=>
  ATTENTION_COMMAND_FLAGS.every(name=>process.env[name]==="true");

export function attentionCommandHttpConfig():StagingPersonalReadConfig|null {
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!UUID.test(expectedRestoreGeneration)||
    !ownerUserId||!ACTOR.test(ownerUserId))return null;
  return {stagingDirectory,expectedRestoreGeneration,ownerUserId};
}
export function attentionCommandHttpUnchanged(config:StagingPersonalReadConfig):boolean {
  const current=attentionCommandHttpConfig();
  return attentionCommandHttpEnabled()&&
    current?.stagingDirectory===config.stagingDirectory&&
    current.expectedRestoreGeneration===config.expectedRestoreGeneration&&
    current.ownerUserId===config.ownerUserId;
}
export const attentionCommandHttpAnswer=(status:number,error:string):Response=>
  Response.json({error},{status,headers:{"cache-control":"no-store"}});
export function attentionCommandHttpTaskId(id:unknown):id is string {
  return typeof id==="string"&&id.length>0&&
    Buffer.byteLength(id,"utf8")<=4096&&!id.includes("\0")&&id.isWellFormed();
}
export function attentionCommandHttpCommand(
  value:unknown,
):TargetStagingAttentionLifecycleCommand|null {
  return validTargetStagingAttentionLifecycleCommand(value)&&
    attentionCommandHttpTaskId(value.taskId)?value:null;
}
/** Live release guard: session, Area/policy, task revision and attention epoch. */
export function verifyAttentionCommandPreviewLive(
  request:Request,identity:StagingHttpIdentity,store:StagingPersonalReadConfig,
  preview:AttentionCommandPreview,
) {
  return verifyStagingReadBeforeRelease(request,identity,store,store.ownerUserId,
    preview.linearization,undefined,undefined,undefined,undefined,undefined,
    undefined,preview.guard,undefined,{attentionEpoch:preview.expectedAttentionEpoch});
}
