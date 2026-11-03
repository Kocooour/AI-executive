/** R2d.3g: one isolated, no-listener, actor-bound temporal detail read. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";

try {
  const [taskId, extra] = process.argv.slice(2);
  const directory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const generation = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const owner = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (extra !== undefined || typeof taskId !== "string" ||
      Buffer.byteLength(taskId,"utf8") > 4096 || taskId.includes("\0") ||
      !taskId.isWellFormed() ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      !directory || !path.isAbsolute(directory) || !generation || !owner) {
    process.exitCode = 1;
  } else {
    const authority = new TargetStagingSessionAuthority({
      stagingDirectory:directory, expectedRestoreGeneration:generation,
    });
    try {
      const actor = resolveChildActor({
        stagingDirectory:directory, expectedRestoreGeneration:generation, ownerUserId:owner,
      });
      if (!actor) process.exitCode = 1;
      else {
        const detail = authority.readTemporalTaskDetail(actor.actor,taskId);
        process.stdout.write(JSON.stringify(detail
          ? {ok:true,...detail} : {ok:false,reason:"inaccessible"}));
      }
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}
