/** Owner-private title CAS preflight; no session token leaves this process. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";
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
      Object.keys(input).some(key => key !== "taskId" && key !== "expectedRevision")) {
    throw new Error("Invalid input");
  }
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory, expectedRestoreGeneration,
  });
  try {
    const issued = authority.issue(ownerUserId);
    if (!issued) throw new Error("Unavailable");
    const result = authority.previewTaskTitleEdit(issued.sessionToken, input, true);
    if (result.ok) process.stdout.write(JSON.stringify({
      ok: true, snapshotRevision: result.snapshotRevision,
    }));
    else if (result.reason === "unavailable" || result.reason === "stale_revision") {
      process.stdout.write(JSON.stringify({ ok: false, reason: result.reason }));
    } else throw new Error("Unavailable");
  } finally { authority.close(); }
} catch { process.exitCode = 1; }

