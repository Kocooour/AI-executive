/** BE-08: canonical one-snapshot task/Area witness and dueOn CAS token. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try {
  const [taskId,extra]=process.argv.slice(2);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(extra!==undefined||typeof taskId!=="string"||!taskId||
    taskId.includes("\0")||!taskId.isWellFormed()||
    Buffer.byteLength(taskId,"utf8")>4096||
    !stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!ownerUserId||
    ![
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED",
    ].every(name=>process.env[name]==="true"))process.exitCode=1;
  else {
    const authority=new TargetStagingSessionAuthority({
      stagingDirectory,expectedRestoreGeneration,
    });
    try {
      const actor=resolveChildActor({stagingDirectory,expectedRestoreGeneration,ownerUserId});
      if(!actor)process.exitCode=1;
      else {
        const preview=authority.readTemporalDueOnPreview(actor.actor,taskId);
        process.stdout.write(JSON.stringify(preview
          ? {ok:true,...preview}:{ok:false,reason:"inaccessible"}));
      }
    }finally{authority.close();}
  }
}catch{process.exitCode=1;}
