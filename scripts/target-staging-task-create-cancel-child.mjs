/** Pinned cancellation fence; actor and durable session never come from JSON. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";
try{
  const dir=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const generation=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const owner=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(process.argv.length!==2||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED!=="true"||
    !dir||!path.isAbsolute(dir)||!generation||!owner)throw Error("Unavailable");
  const input=await readTitleCommand(process.stdin,128);
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(!input||typeof input!=="object"||Array.isArray(input)||
    Object.keys(input).join(",")!=="commandId"||
    typeof input.commandId!=="string"||!uuid.test(input.commandId))
    throw Error("Invalid");
  const auth=new TargetStagingSessionAuthority({
    stagingDirectory:dir,expectedRestoreGeneration:generation,
  });
  try{
    const resolved=resolveChildActor({
      stagingDirectory:dir,expectedRestoreGeneration:generation,ownerUserId:owner,
    });
    if(!resolved)throw Error("Unavailable");
    const session=auth.issueWritable(resolved.actor);
    if(!session)throw Error("Unavailable");
    const result=auth.cancelPrivateTaskCreate(
      session.sessionToken,input.commandId,resolved.sessionTokenHash);
    if(result.ok)process.stdout.write(JSON.stringify(result));
    else if(["unavailable","session_revoked","resync_required","write_failed"].includes(result.reason))
      process.stdout.write(JSON.stringify(result));
    else throw Error("Unauthorized");
  }finally{auth.close();}
}catch{process.exitCode=1;}
