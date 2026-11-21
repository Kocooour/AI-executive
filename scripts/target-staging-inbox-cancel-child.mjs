/** C-3a: one pinned, durable-session-bound irreversible triage UUID fence. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {validTargetInboxTriageCommand} from "../lib/target-inbox-triage-writer.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";

const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
const enabled=()=>process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED==="true"&&
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED==="true";

try{
  if(process.argv.length!==2||!enabled()||!stagingDirectory||
      !path.isAbsolute(stagingDirectory)||!expectedRestoreGeneration||!ownerUserId)
    throw Error("unavailable");
  const command=await readTitleCommand(process.stdin);
  if(!validTargetInboxTriageCommand(command))throw Error("invalid");
  const authority=new TargetStagingSessionAuthority({stagingDirectory,expectedRestoreGeneration});
  try{
    const resolved=resolveChildActor({stagingDirectory,expectedRestoreGeneration,ownerUserId});
    if(!resolved)throw Error("unauthorized");
    const issued=authority.issueWritable(resolved.actor);
    if(!issued)throw Error("unavailable");
    const result=authority.cancelInboxTriage(issued.sessionToken,command,resolved.sessionTokenHash);
    if(result.ok)process.stdout.write(JSON.stringify(result));
    else if(["unavailable","resync_required","session_revoked",
        "write_failed","idempotency_conflict"].includes(result.reason))
      process.stdout.write(JSON.stringify({ok:false,reason:result.reason}));
    else throw Error("unavailable");
  }finally{authority.close();}
}catch{process.exitCode=1;}
