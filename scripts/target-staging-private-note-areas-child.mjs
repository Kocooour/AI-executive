/** R3-CAPTURE-1: actor-scoped private writable Area choices. No request IDs,
 * notes, credentials or content in argv/stdout. Pinned SQL + signed actor.
 * This is a read-only preflight, NOT permission to create a note. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try{
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(process.argv.length!==2||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED!=="true"||
    !stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!ownerUserId)throw Error("Unavailable");
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory,expectedRestoreGeneration,
  });
  try{
    const resolved=resolveChildActor({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
    });
    const targets=resolved&&authority.readPrivateNoteAreaTargets(resolved.actor);
    if(!targets)throw Error("Unavailable");
    process.stdout.write(JSON.stringify({ok:true,...targets}));
  }finally{authority.close();}
}catch{process.exitCode=1;}
