/** R3-BE-4c.2: a strictly read-only, exact-command receipt probe. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {validPrivateTaskCreateCommand} from "../lib/target-private-task-create-writer.ts";
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
  const input=await readTitleCommand(process.stdin,16*1024);
  if(!validPrivateTaskCreateCommand(input))throw Error("Invalid");
  const auth=new TargetStagingSessionAuthority({
    stagingDirectory:dir,expectedRestoreGeneration:generation,
  });
  try{
    const resolved=resolveChildActor({
      stagingDirectory:dir,expectedRestoreGeneration:generation,ownerUserId:owner,
    });
    if(!resolved)throw Error("Unavailable");
    const issued=auth.issueWritable(resolved.actor);
    if(!issued)throw Error("Unavailable");
    process.stdout.write(JSON.stringify(
      auth.privateTaskCreateStatus(issued.sessionToken,input),
    ));
  }finally{auth.close();}
}catch{process.exitCode=1;}
