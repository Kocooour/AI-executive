/** R2d.3m.8 — one actor-bound, preflighted mixed Vše read snapshot. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try{
  const [scope,rawLimit,rawProjects,rawTasks,rawNotes,extra]=process.argv.slice(2);
  const directory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const restoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const offsetPattern=/^(?:0|[1-9][0-9]{0,6})$/;
  const offsets=[rawProjects,rawTasks,rawNotes];
  if(extra!==undefined||!["all","personal","shared"].includes(scope)||
    !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit||"")||
    offsets.some(x=>!offsetPattern.test(x||"")||Number(x)>1_000_000)||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_GLOBAL_COMBINED_ENABLED!=="true"||
    !directory||!path.isAbsolute(directory)||!restoreGeneration||!ownerUserId)
    process.exitCode=1;
  else{
    const authority=new TargetStagingSessionAuthority({
      stagingDirectory:directory,expectedRestoreGeneration:restoreGeneration,
    });
    try{
      const actor=resolveChildActor({
        stagingDirectory:directory,expectedRestoreGeneration:restoreGeneration,
        ownerUserId,
      });
      const page=actor&&authority.readGlobalCombinedPage(
        actor.actor,scope,Number(rawLimit),{
          projects:Number(rawProjects),tasks:Number(rawTasks),notes:Number(rawNotes),
        });
      if(!page)process.exitCode=1;
      else process.stdout.write(JSON.stringify({ok:true,...page}));
    }finally{authority.close();}
  }
}catch{process.exitCode=1;}
