/** Bounded, no-listener owner-private project detail reader. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";
import { isReadableStagingProjectId } from "../lib/target-project-id.ts";

try {
  const [projectId, extra] = process.argv.slice(2);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (extra !== undefined || !isReadableStagingProjectId(projectId) ||
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
      const result = authority.readPrivateProjectDetail(resolved.actor, projectId);
      if (result.ok) process.stdout.write(JSON.stringify({ ok: true, project: result.project }));
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
