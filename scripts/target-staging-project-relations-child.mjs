/** Isolated, staging-only structural project->task/note relation page. */
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
      !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit || "") ||
      !/^(?:0|[1-9][0-9]{0,6})$/.test(rawOffset || "") ||
      Number(rawOffset) > 1_000_000 ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      !stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !ownerUserId) {
    process.exitCode = 1;
  } else {
    const authority = new TargetStagingSessionAuthority({
      stagingDirectory, expectedRestoreGeneration,
    });
    try {
      const resolved = resolveChildActor({
        stagingDirectory, expectedRestoreGeneration, ownerUserId,
      });
      const result = resolved && authority.readAuthorizedProjectStructuralRelations(
        resolved.actor, projectId, Number(rawLimit), Number(rawOffset),
      );
      if (!result) process.exitCode = 1;
      else process.stdout.write(JSON.stringify(result.ok
        ? { ok: true, ...result.page }
        : { ok: false, reason: result.reason }));
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}
