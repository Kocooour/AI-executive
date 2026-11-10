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
        // A writable actor can receive the task CAS and the visible detail from ONE
        // preflighted SQLite snapshot. Never combine a separate CAS GET with a detail GET.
        // Read-only viewers keep the legacy detail-only DTO and are not given a write token.
        const revisioned = process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED === "true" &&
          process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED === "true"
          ? authority.readTemporalStatusPreview(actor.actor,taskId) : null;
        const detail = revisioned?.detail ?? authority.readTemporalTaskDetail(actor.actor,taskId);
        process.stdout.write(JSON.stringify(detail
          ? {ok:true,...detail,...(revisioned ? {expectedRevision:revisioned.expectedRevision} : {})}
          : {ok:false,reason:"inaccessible"}));
      }
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}
