/**
 * Isolated R2d.1a project task reader. Only a live-session-resolved actor
 * reaches the pinned read gateway. No writable store or network listener.
 */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";
import { isReadableStagingProjectId } from "../lib/target-project-id.ts";

try {
  const [projectId, rawLimit, rawOffset, extra] = process.argv.slice(2);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (extra !== undefined || !isReadableStagingProjectId(projectId) ||
      !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit || "") ||
      !/^(?:0|[1-9][0-9]{0,6})$/.test(rawOffset || "") ||
      Number(rawOffset) > 1_000_000 ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED !== "true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TITLE_WRITE_ENABLED !== "true" ||
      !stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !ownerUserId) {
    process.exitCode = 1;
  } else {
    const authority = new TargetStagingSessionAuthority({ stagingDirectory, expectedRestoreGeneration });
    try {
      const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
      const result = resolved && authority.readProjectTitlePreview(resolved.actor, projectId);
      if (!result) process.exitCode = 1;
      else process.stdout.write(JSON.stringify(result.ok
        ? { ok: true, ...result.page }
        : { ok: false, reason: "unavailable" }));
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}
