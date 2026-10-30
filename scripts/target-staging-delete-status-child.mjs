/** R2c.1 read-only per-identity delete receipt reconciliation (live task or tombstone Area); command arrives over stdin. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
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
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "commandId,expectedRevision,restoreGeneration,taskId,writeAreaId") {
    throw new Error("Invalid input");
  }
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory, expectedRestoreGeneration,
  });
  try {
    const resolved = resolveChildActor({ stagingDirectory, expectedRestoreGeneration, ownerUserId });
    // An unresolvable durable session produces no output; the HTTP parent
    // re-verifies the live session and answers 401, never a task result.
    if (!resolved) throw new Error("Unavailable");
    const issued = authority.issueWritable(resolved.actor);
    if (!issued) throw new Error("Unavailable");
    const result = authority.taskDeleteCommandStatus(issued.sessionToken, input, false);
    if (result.ok) process.stdout.write(JSON.stringify(result));
    else if (result.reason === "unavailable" || result.reason === "idempotency_conflict" ||
        result.reason === "resync_required" || result.reason === "write_area_mismatch") {
      process.stdout.write(JSON.stringify(result));
    } else throw new Error("Unavailable");
  } finally { authority.close(); }
} catch { process.exitCode = 1; }
