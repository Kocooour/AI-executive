/** Short-lived, no-listener owner-only detail reader. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";

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
      const result = authority.readPersonalTaskDetailWithRevision(ownerUserId, taskId);
      if (result.ok) process.stdout.write(JSON.stringify({ ok: true, task: result.task, snapshotRevision: result.snapshotRevision }));
      else if (result.reason === "unavailable") {
        process.stdout.write(JSON.stringify({ ok: false, reason: "unavailable" }));
      } else process.exitCode = 1;
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}

