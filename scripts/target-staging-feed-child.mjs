/**
 * R2c.2a short-lived, no-listener reader for the bootstrap / Area bootstrap / change feed.
 * The only argument is the base64url JSON of the already DECRYPTED cursor claims (or
 * "-" for a first bootstrap page); the parent holds the secret, this child never does.
 * Claims are re-validated here and checked against the authenticated snapshot
 * (uid, generation, epoch). Cursor failures are printed as results (exit 0).
 */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { validFeedClaims } from "../lib/target-staging-feed-cursor.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";

try {
  const [encoded, extra] = process.argv.slice(2);
  let claims = null;
  let valid = extra === undefined && typeof encoded === "string" && encoded.length > 0 && encoded.length <= 4096;
  if (valid && encoded !== "-") {
    try {
      claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      valid = validFeedClaims(claims);
    } catch {
      valid = false;
    }
  }
  const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if (!valid || process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED !== "true" ||
      !stagingDirectory || !path.isAbsolute(stagingDirectory) ||
      !expectedRestoreGeneration || !ownerUserId) {
    process.exitCode = 1;
  } else {
    const authority = new TargetStagingSessionAuthority({ stagingDirectory, expectedRestoreGeneration });
    try {
      const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
      const page = resolved && authority.readChangeFeedPage(resolved.actor, claims);
      if (!page) process.exitCode = 1;
      else process.stdout.write(JSON.stringify(page));
    } finally {
      authority.close();
    }
  }
} catch {
  process.exitCode = 1;
}
