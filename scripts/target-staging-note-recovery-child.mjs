/** Content-free, actor-scoped receipt lookup for a reloaded tab. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";

try{
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(process.argv.length!==2||process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED!=="true"||
    !stagingDirectory||!path.isAbsolute(stagingDirectory)||!expectedRestoreGeneration||!ownerUserId)
    throw Error("Unavailable");
  const input=await readTitleCommand(process.stdin,128);
  if(!input||typeof input!=="object"||Array.isArray(input)||
    Object.keys(input).join(",")!=="commandId"||typeof input.commandId!=="string")throw Error("Invalid");
  const authority=new TargetStagingSessionAuthority({stagingDirectory,expectedRestoreGeneration});
  try{
    const resolved=resolveChildActor({stagingDirectory,expectedRestoreGeneration,ownerUserId});
    if(!resolved)throw Error("Unavailable");
    const session=authority.issueWritable(resolved.actor);
    if(!session)throw Error("Unavailable");
    process.stdout.write(JSON.stringify(authority.noteEditRecovery(session.sessionToken,input.commandId)));
  }finally{authority.close();}
}catch{process.exitCode=1;}
