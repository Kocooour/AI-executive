/** Authenticated pinned-SQLite worker; no actor, credential or title in argv. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {validPrivateStructureCreateCommand} from "../lib/target-private-structure-create-writer.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";
try{
  const dir=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const generation=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const owner=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(process.argv.length!==2||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED!=="true"||
    !dir||!path.isAbsolute(dir)||!generation||!owner)throw Error("Unavailable");
  const data=await readTitleCommand(process.stdin,16*1024);
  if(!data||typeof data!=="object"||Array.isArray(data)||
    Object.keys(data).sort().join(",")!=="command,kind,mode"||
    !["project","project-task"].includes(data.kind)||
    !["create","status","recovery"].includes(data.mode))throw Error("Invalid");
  if(process.env[data.kind==="project"
    ?"AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED"
    :"AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED"]!=="true")
    throw Error("Disabled");
  const recovery=data.mode==="recovery";
  const opaque=recovery&&data.command&&typeof data.command==="object"&&
    !Array.isArray(data.command)&&Object.keys(data.command).join(",")==="commandId"&&
    typeof data.command.commandId==="string"&&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.command.commandId);
  if(recovery?!opaque:!validPrivateStructureCreateCommand(data.kind,data.command))
    throw Error("Invalid");
  const auth=new TargetStagingSessionAuthority({
    stagingDirectory:dir,expectedRestoreGeneration:generation,
  });
  try{
    const resolved=resolveChildActor({
      stagingDirectory:dir,expectedRestoreGeneration:generation,ownerUserId:owner,
    });
    if(!resolved)throw Error("Unavailable");
    const issued=auth.issueWritable(resolved.actor);
    if(!issued)throw Error("Unavailable");
    const result=data.mode==="create"
      ?auth.createPrivateStructure(issued.sessionToken,data.kind,data.command,resolved.sessionTokenHash)
      :data.mode==="status"
        ?auth.privateStructureCreateStatus(issued.sessionToken,data.kind,data.command)
        :auth.privateStructureCreateRecovery(issued.sessionToken,data.kind,data.command.commandId);
    if(result.ok===false&&result.reason==="invalid_request")throw Error("Invalid");
    process.stdout.write(JSON.stringify(result));
  }finally{auth.close();}
}catch{process.exitCode=1;}
