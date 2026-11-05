/** R2d.3m.4 — isolated, actor-bound global Vše/Personal/Shared project read. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try{
  const [scope,rawLimit,rawOffset,extra]=process.argv.slice(2);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(extra!==undefined||!["all","personal","shared"].includes(scope)||
    !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit||"")||
    !/^(?:0|[1-9][0-9]{0,6})$/.test(rawOffset||"")||
    Number(rawOffset)>1_000_000||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_PROJECTS_ENABLED!=="true"||
    !stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!ownerUserId)
    process.exitCode=1;
  else{
    const authority=new TargetStagingSessionAuthority({
      stagingDirectory,expectedRestoreGeneration,
    });
    try{
      const actor=resolveChildActor({
        stagingDirectory,expectedRestoreGeneration,ownerUserId,
      });
      const page=actor&&authority.readGlobalProjectPage(
        actor.actor,scope,Number(rawLimit),Number(rawOffset));
      if(!page)process.exitCode=1;
      else process.stdout.write(JSON.stringify({ok:true,...page}));
    }finally{authority.close();}
  }
}catch{process.exitCode=1;}
