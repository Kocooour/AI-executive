/** Shared-Area membership command; the command arrives over stdin, never argv. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
import { validTargetStagingMembershipCommand } from "../lib/target-staging-membership-command.ts";
import { resolveChildActor } from "./target-staging-child-actor.mjs";
import { readTitleCommand } from "./target-staging-title-stdin.mjs";
const stagingDirectory = process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const expectedRestoreGeneration = process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const ownerUserId = process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
const available = process.argv.length === 2 &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED === "true" &&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED === "true" &&
  !!stagingDirectory && path.isAbsolute(stagingDirectory) &&
  !!expectedRestoreGeneration && !!ownerUserId;

try {
  if (!available) throw new Error("Unavailable");
  const input = await readTitleCommand(process.stdin);
  if (!validTargetStagingMembershipCommand(input)) throw new Error("Invalid input");
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory, expectedRestoreGeneration,
  });
  try {
    const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
    // An unresolvable durable session produces no output; the HTTP parent
    // re-verifies the live session and answers 401.
    if (!resolved) throw new Error("Unavailable");
    const issued = authority.issueWritable(resolved.actor);
    if (!issued) throw new Error("Unavailable");
    const result = authority.applyMembershipCommand(
      issued.sessionToken, input, resolved.sessionTokenHash);
    if (result.ok) process.stdout.write(JSON.stringify(result));
    else if (["unavailable", "stale_policy_revision", "idempotency_conflict", "already_member",
        "last_admin", "write_failed", "session_revoked"].includes(result.reason)) {
      process.stdout.write(JSON.stringify({ ok: false, reason: result.reason }));
    } else throw new Error("Unavailable");
  } finally { authority.close(); }
} catch { process.exitCode = 1; }
