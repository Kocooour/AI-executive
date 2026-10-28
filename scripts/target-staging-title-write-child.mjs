/** Owner-private title mutation; title arrives over stdin, never argv. */
import path from "node:path";
import { TargetStagingSessionAuthority } from "../lib/target-staging-session-authority.ts";

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > 8192) throw new Error("Too large");
  }
  return JSON.parse(text);
}
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
  const input = await readInput();
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "commandId,expectedRevision,taskId,title") {
    throw new Error("Invalid input");
  }
  const authority = new TargetStagingSessionAuthority({
    stagingDirectory, expectedRestoreGeneration,
  });
  try {
    const issued = authority.issueWritable(ownerUserId);
    if (!issued) throw new Error("Unavailable");
    const result = authority.updateTaskTitle(issued.sessionToken, input, true);
    if (result.ok) process.stdout.write(JSON.stringify(result.replayed
      ? { ok: true, replayed: true } : { ok: true }));
    else if (result.reason === "unavailable" || result.reason === "stale_revision" ||
        result.reason === "idempotency_conflict" || result.reason === "unchanged" ||
        result.reason === "write_failed") {
      process.stdout.write(JSON.stringify({ ok: false, reason: result.reason }));
    } else throw new Error("Unavailable");
  } finally { authority.close(); }
} catch { process.exitCode = 1; }

