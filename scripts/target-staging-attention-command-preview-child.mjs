/** R2d.5c.2: actor-bound, read-only Attention lifecycle command preview. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {validTargetDueOn} from "../lib/target-task-temporal-due-on-writer.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try {
  const [taskId,ruleId,occurrenceOn,extra]=process.argv.slice(2);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(extra!==undefined||typeof taskId!=="string"||!taskId||
     Buffer.byteLength(taskId,"utf8")>4096||taskId.includes("\0")||
     !taskId.isWellFormed()||
     !["deadline_overdue","deadline_soon","planned_date_passed"].includes(ruleId)||
     !validTargetDueOn(occurrenceOn)||
     ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_ATTENTION_WRITE_ENABLED"]
       .some(name=>process.env[name]!=="true")||
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
    // Server clock decides whether a snooze has expired.
    const preview=authority.previewAttentionCommand(
      identity.actor,taskId,ruleId,occurrenceOn,Date.now());
    process.stdout.write(JSON.stringify(preview
      ?{ok:true,...preview}:{ok:false,reason:"inaccessible"}));
  }finally{authority.close();}
}catch{process.exitCode=1;}
