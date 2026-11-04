/** Shared default-off configuration and guards for R2d.3i.2 HTTP dueOn. */
import path from "node:path";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {StagingHttpIdentity} from "./target-staging-http-identity";
import type {TemporalTaskDetail} from "./target-task-temporal-read-model";
import type {TargetStagingTemporalDueOnCommand} from "./target-task-temporal-due-on-writer";
import {validTargetStagingTemporalDueOnCommand} from "./target-task-temporal-due-on-writer";
import {verifyStagingReadBeforeRelease} from "./target-staging-http-identity";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
export const temporalDueOnEnabled=()=>[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED",
].every(name=>process.env[name]==="true");

export function temporalDueOnConfig():StagingPersonalReadConfig|null {
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !UUID.test(expectedRestoreGeneration) ||
      !ownerUserId || !ACTOR.test(ownerUserId)) return null;
  return {stagingDirectory,expectedRestoreGeneration,ownerUserId};
}
export function temporalDueOnUnchanged(config:StagingPersonalReadConfig):boolean {
  const current=temporalDueOnConfig();
  return temporalDueOnEnabled() &&
    current?.stagingDirectory===config.stagingDirectory &&
    current.expectedRestoreGeneration===config.expectedRestoreGeneration &&
    current.ownerUserId===config.ownerUserId;
}
export const temporalDueOnAnswer=(status:number,error:string):Response=>
  Response.json({error},{status,headers:{"cache-control":"no-store"}});
export function temporalDueOnTaskId(value:unknown):value is string {
  return typeof value==="string" && value.length>0 &&
    Buffer.byteLength(value,"utf8")<=4096 && !value.includes("\0") &&
    value.isWellFormed();
}
export function temporalDueOnCommand(value:unknown):TargetStagingTemporalDueOnCommand|null {
  return validTargetStagingTemporalDueOnCommand(value) &&
    temporalDueOnTaskId(value.taskId) ? value : null;
}
export function temporalDueOnWriterCanRead(detail:TemporalTaskDetail):boolean {
  const access=detail.linearization.areas[0]?.access;
  return access==="private-owner"||access==="editor"||access==="admin";
}
export function verifyTemporalDueOnTaskLive(
  request:Request,identity:StagingHttpIdentity,store:StagingPersonalReadConfig,
  detail:TemporalTaskDetail,
) {
  return verifyStagingReadBeforeRelease(request,identity,store,store.ownerUserId,
    detail.linearization,undefined,undefined,undefined,undefined,undefined,
    undefined,detail.guard);
}
