/** Default-off staging canonical parent backlinks. No direct SQLite path from HTTP. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";
import { validBacklinkId } from "../lib/target-parent-backlinks.ts";

try {
  const [kind, id, extra] = process.argv.slice(2);
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (extra !== undefined || (kind !== "task" && kind !== "note") ||
      !validBacklinkId(id) ||
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
      if (!resolved) throw Error("Unavailable");
      const result = authority.readAuthorizedTargetParentBacklink(resolved.actor, kind, id);
      process.stdout.write(JSON.stringify(result
        ? { ok: true, ...result } : { ok: false, reason: "unavailable" }));
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}
