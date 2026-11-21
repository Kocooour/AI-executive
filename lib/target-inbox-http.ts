/** C-3a: default-off HTTP gates; read and write remain separate privileges. */
import path from "node:path";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import {validTargetInboxTriageCommand,type TargetInboxTriageCommand}
  from "./target-inbox-triage-writer";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
export const targetInboxWriteEnabled=()=>[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED",
].every(flag=>process.env[flag]==="true");
export function targetInboxHttpConfig():StagingPersonalReadConfig|null{
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
     !expectedRestoreGeneration||!uuid.test(expectedRestoreGeneration)||
     !ownerUserId||!actor.test(ownerUserId))return null;
  return {stagingDirectory,expectedRestoreGeneration,ownerUserId};
}
export const targetInboxHttpUnchanged=(base:StagingPersonalReadConfig):boolean=>{
  const now=targetInboxHttpConfig();
  return targetInboxWriteEnabled()&&now?.stagingDirectory===base.stagingDirectory&&
    now.expectedRestoreGeneration===base.expectedRestoreGeneration&&
    now.ownerUserId===base.ownerUserId;
};
export const targetInboxCommand=(raw:unknown):TargetInboxTriageCommand|null=>
  validTargetInboxTriageCommand(raw)?raw:null;
export const inboxAnswer=(status:number,error:string):Response=>
  Response.json({error},{status,headers:{"cache-control":"no-store"}});
