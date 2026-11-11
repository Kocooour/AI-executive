/** Content-free, signed-actor private CREATE receipt; no content on stdout. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";
let diagnosticStage="configuration";
try{
  const dir=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const generation=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const owner=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(process.argv.length!==2||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED!=="true"||
    !dir||!path.isAbsolute(dir)||!generation||!owner)throw Error("Unavailable");
  diagnosticStage="input";
  const input=await readTitleCommand(process.stdin,128);
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(!input||typeof input!=="object"||Array.isArray(input)||
    Object.keys(input).join(",")!=="commandId"||
    typeof input.commandId!=="string"||!uuid.test(input.commandId))
    throw Error("Invalid");
  diagnosticStage="authority";
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:dir,expectedRestoreGeneration:generation,
  });
  try{
    const resolved=resolveChildActor({
      stagingDirectory:dir,expectedRestoreGeneration:generation,ownerUserId:owner,
    });
    if(!resolved)throw Error("Unavailable");
    diagnosticStage="session";
    const session=authority.issueWritable(resolved.actor);
    if(!session)throw Error("Unavailable");
    diagnosticStage="receipt";
    process.stdout.write(JSON.stringify(
      authority.noteCreateRecovery(session.sessionToken,input.commandId)));
  }finally{authority.close();}
 }catch(error){
  // Only a separately invoked synthetic test process may print diagnostics.
  // The actual HTTP worker never receives this flag; no note data is printed.
  if(process.env.LUMI_SYNTHETIC_CHILD_DIAG==="true")
    process.stderr.write("synthetic create-recovery "+diagnosticStage+": "+
      (error instanceof Error?error.name+": "+error.message:"unknown")+"\n");
  process.exitCode=1;
}
