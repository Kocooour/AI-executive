/** Short-lived, no-listener owner-only detail reader. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";

try {
  const [taskId, extra] = process.argv.slice(2);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (extra !== undefined || !taskId || taskId.trim() !== taskId ||
      Buffer.byteLength(taskId, "utf8") > 512 || /[\u0000-\u001f\u007f]/.test(taskId) ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      !stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !ownerUserId) {
    process.exitCode = 1;
  } else {
    const authority = new TargetStagingSessionAuthority({
      stagingDirectory, expectedRestoreGeneration,
    });
    try {
      const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
      if (!resolved) throw new Error("Unavailable");
      const result = authority.readPersonalTaskDetailWithRevision(resolved.actor, taskId);
      if (result.ok) process.stdout.write(JSON.stringify({ ok: true, task: result.task, snapshotRevision: result.snapshotRevision }));
      else if (result.reason === "unavailable") {
        // Not a private task of this actor: R2-ID.2b falls back to a shared-Area
        // task of which the actor is a current member (any role). The private
        // path above is unchanged; unknown / foreign / non-member stay "unavailable".
        const shared = authority.readSharedTaskDetail(resolved.actor, taskId);
        if (shared && shared.ok) {
          process.stdout.write(JSON.stringify({
            ok: true, scope: "shared", task: shared.task, linearization: shared.linearization,
            ...(shared.snapshotRevision === undefined ? {} : { snapshotRevision: shared.snapshotRevision }),
          }));
        } else if (shared && shared.reason === "unavailable") {
          process.stdout.write(JSON.stringify({ ok: false, reason: "unavailable" }));
        } else process.exitCode = 1;
      } else process.exitCode = 1;
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}

