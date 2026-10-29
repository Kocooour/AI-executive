/**
 * R2-ID.2b short-lived, no-listener reader for the shared / my-plan scopes.
 * Emits one page plus the read-linearization record (contributing Areas with the
 * policy_revision and the actor's access observed in this very snapshot).
 * The personal scope deliberately keeps using target-staging-read-child.mjs.
 */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";

try {
  const [scope, rawLimit, rawOffset, extra] = process.argv.slice(2);
  if (extra !== undefined || (scope !== "shared" && scope !== "my-plan") ||
      !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit || "") ||
      !/^(?:0|[1-9][0-9]{0,6})$/.test(rawOffset || "")) {
    process.exitCode = 1;
  } else {
    const limit = Number(rawLimit);
    const offset = Number(rawOffset);
    const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
    const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
    const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
    if (offset > 1_000_000 ||
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
        const page = resolved && authority.readScopedOffsetPage(resolved.actor, scope, limit, offset);
        if (!page) process.exitCode = 1;
        else process.stdout.write(JSON.stringify({ ok: true, ...page }));
      } finally {
        authority.close();
      }
    }
  }
} catch {
  process.exitCode = 1;
}
