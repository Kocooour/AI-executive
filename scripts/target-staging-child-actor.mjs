/**
 * Shared actor resolution for short-lived staging child workers (R2-ID.1).
 *
 * The parent HTTP process passes either nothing (legacy owner-cookie path: the
 * actor is the configured owner) or the SHA-256 HASH of a durable staging
 * session token. The raw token never enters a child. A durable session is
 * resolved against the LIVE store; an unknown, revoked, expired or stale-epoch
 * session yields null, so no snapshot is read on its behalf.
 */
import { verifyDurableTargetStagingSessionLive } from "../lib/target-staging-durable-session.ts";

export function resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId }) {
  const sessionTokenHash = process.env.AI_EXECUTIVE_TARGET_STAGING_SESSION_HASH || "";
  if (sessionTokenHash === "") return { actor: ownerUserId, sessionTokenHash: undefined };
  const live = verifyDurableTargetStagingSessionLive(
    { stagingDirectory, expectedRestoreGeneration }, sessionTokenHash,
  );
  return live.ok ? { actor: live.userId, sessionTokenHash } : null;
}
