/** R2d.3h.2: read-only per-current-writer receipt reconciliation. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {validTargetStagingTemporalStatusCommand} from "../lib/target-task-temporal-status-writer.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";

const directory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const generation=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const owner=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
try {
  if (process.argv.length!==2 ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED!=="true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED!=="true" ||
      process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED!=="true" ||
      !directory || !path.isAbsolute(directory) || !generation || !owner)
    throw new Error("unavailable");
  const request=await readTitleCommand(process.stdin);
  if (!validTargetStagingTemporalStatusCommand(request)) throw new Error("invalid");
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:directory,expectedRestoreGeneration:generation,
  });
  try {
    const identity=resolveChildActor({
      stagingDirectory:directory,expectedRestoreGeneration:generation,ownerUserId:owner,
    });
    if (!identity) throw new Error("unauthorized");
    const issued=authority.issueWritable(identity.actor);
    if (!issued) throw new Error("unavailable");
    const result=authority.temporalStatusReceipt(issued.sessionToken,request);
    if (result.ok || ["unavailable","idempotency_conflict",
      "resync_required","write_area_mismatch"].includes(result.reason))
      process.stdout.write(JSON.stringify(result));
    else throw new Error("unavailable");
  } finally { authority.close(); }
} catch { process.exitCode=1; }
