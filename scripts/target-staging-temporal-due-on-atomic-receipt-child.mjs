/** BE-07: read-only dueOn receipt + live task/Area witness from one snapshot.
 * Request on stdin only; no command, identity, token, or title in argv. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {validTargetStagingTemporalDueOnCommand} from "../lib/target-task-temporal-due-on-writer.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";

const directory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const generation=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const owner=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
try {
  if(process.argv.length!==2||
    ![
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_DUE_ON_WRITE_ENABLED",
    ].every(name=>process.env[name]==="true")||
    !directory||!path.isAbsolute(directory)||!generation||!owner)
    throw new Error("unavailable");
  const command=await readTitleCommand(process.stdin);
  if(!validTargetStagingTemporalDueOnCommand(command))throw new Error("invalid");
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:directory,expectedRestoreGeneration:generation,
  });
  try {
    const identity=resolveChildActor({
      stagingDirectory:directory,expectedRestoreGeneration:generation,ownerUserId:owner,
    });
    if(!identity)throw new Error("unauthorized");
    const issued=authority.issueWritable(identity.actor);
    if(!issued)throw new Error("unavailable");
    process.stdout.write(JSON.stringify(
      authority.temporalDueOnReceiptSnapshot(issued.sessionToken,command)));
  }finally{authority.close();}
}catch{process.exitCode=1;}
