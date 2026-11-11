/** Bounded child for the durable project-title cancellation fence. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";
import {validProjectTitleCancelCommand} from "../lib/target-project-title-cancel.ts";
try{
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(process.argv.length!==2||process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED!=="true"||
    !stagingDirectory||!path.isAbsolute(stagingDirectory)||!expectedRestoreGeneration||!ownerUserId)
    throw Error("Unavailable");
  const input=await readTitleCommand(process.stdin,2048);
  if(!input||typeof input!=="object"||Array.isArray(input)||
     Object.keys(input).sort().join(",")!=="command,expectedActorUserId"||
     typeof input.expectedActorUserId!=="string"||
     !/^[A-Za-z0-9_.:@-]{1,120}$/.test(input.expectedActorUserId)||
     !validProjectTitleCancelCommand(input.command))throw Error("Invalid command");
  const authority=new TargetStagingSessionAuthority({stagingDirectory,expectedRestoreGeneration});
  try{
    const resolved=resolveChildActor({stagingDirectory,expectedRestoreGeneration,ownerUserId});
    if(!resolved||resolved.actor!==input.expectedActorUserId)throw Error("Unavailable");
    const session=authority.issueWritable(resolved.actor);
    if(!session)throw Error("Unavailable");
    const result=authority.cancelProjectTitle(session.sessionToken,input.command,
      input.expectedActorUserId,resolved.sessionTokenHash);
    if(result.ok)process.stdout.write(JSON.stringify({ok:true,status:result.status}));
    else if(["unavailable","session_revoked","resync_required","write_failed"].includes(result.reason))
      process.stdout.write(JSON.stringify({ok:false,reason:result.reason}));
    else throw Error("Unauthorized");
  }finally{authority.close();}
}catch{process.exitCode=1;}
