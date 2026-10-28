/**
 * Isolated, short-lived staging SQLite reader. Spawned only by the authenticated
 * Next route; it has no listener and receives only bounded numeric arguments.
 * All database access continues to use canonical pinned preflight and live ACL.
 */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";

try {
  const [rawLimit, rawOffset, extra] = process.argv.slice(2);
  if (extra !== undefined || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit || "") ||
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
        const page = authority.readPersonalOffsetPage(ownerUserId, limit, offset);
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
