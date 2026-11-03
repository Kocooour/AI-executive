/** Isolated authorized Personal/Shared/My Plan staging Home summary worker. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";

try {
  const [scope,extra] = process.argv.slice(2);
  if (extra !== undefined ||
      (scope !== "personal" && scope !== "shared" && scope !== "my-plan") ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true")
    throw Error("Disabled or invalid scope");
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !ownerUserId) throw Error("Invalid staging");
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory, expectedRestoreGeneration,
  });
  try {
    const identity = resolveChildActor({
      stagingDirectory, expectedRestoreGeneration, ownerUserId,
    });
    const result = identity &&
      authority.readScopedHomeSummary(identity.actor, scope);
    if (!result) throw Error("Unavailable");
    process.stdout.write(JSON.stringify({ok:true,...result}));
  } finally {
    authority.close();
  }
} catch {
  process.exitCode = 1;
}
