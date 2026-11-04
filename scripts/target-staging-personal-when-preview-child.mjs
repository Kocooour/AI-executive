/** R2d.3k.4b: actor-bound, read-only private whenOn command preview. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try {
  const [taskId,extra]=process.argv.slice(2);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(extra!==undefined||typeof taskId!=="string"||!taskId||
     Buffer.byteLength(taskId,"utf8")>4096||taskId.includes("\0")||
     !taskId.isWellFormed()||
     process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
     process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED!=="true"||
     process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED!=="true"||
     process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED!=="true"||
     !stagingDirectory||!path.isAbsolute(stagingDirectory)||
     !expectedRestoreGeneration||!ownerUserId)throw new Error("unavailable");
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory,expectedRestoreGeneration,
  });
  try {
    const identity=resolveChildActor({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
    });
    if(!identity)throw new Error("unauthorized");
    const preview=authority.previewPersonalWhen(identity.actor,taskId);
    process.stdout.write(JSON.stringify(preview
      ?{ok:true,...preview}:{ok:false,reason:"inaccessible"}));
  }finally{authority.close();}
}catch{process.exitCode=1;}
