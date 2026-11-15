/** R3-slice/BE-02: one short-lived actor-bound read of two My Plan days. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try {
  const [areaFilter,evaluationDate,nextDate,rawLimit,rawToday,rawTomorrow,rawUndated,extra]=
    process.argv.slice(2);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const offset=/^(?:0|[1-9][0-9]{0,6})$/;
  if(extra!==undefined||
    !["all","personal","shared"].includes(areaFilter)||
    !/^\d{4}-\d{2}-\d{2}$/.test(evaluationDate||"")||
    !/^\d{4}-\d{2}-\d{2}$/.test(nextDate||"")||
    !/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit||"")||
    !offset.test(rawToday||"")||!offset.test(rawTomorrow||"")||
    !offset.test(rawUndated||"")||
    Number(rawToday)>1_000_000||Number(rawTomorrow)>1_000_000||
    Number(rawUndated)>1_000_000||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED!=="true"||
    !stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!ownerUserId)process.exitCode=1;
  else {
    const authority=new TargetStagingSessionAuthority({
      stagingDirectory,expectedRestoreGeneration,
    });
    try {
      const actor=resolveChildActor({
        stagingDirectory,expectedRestoreGeneration,ownerUserId,
      });
      const page=actor&&authority.readMyPlanTwoDayTaskPage(
        actor.actor,areaFilter,evaluationDate,nextDate,Number(rawLimit),
        Number(rawToday),Number(rawTomorrow),Number(rawUndated));
      if(!page)process.exitCode=1;
      else process.stdout.write(JSON.stringify({
        ok:true,today:{ok:true,...page.today},
        tomorrow:{ok:true,...page.tomorrow},
        undated:{ok:true,...page.undated},
      }));
    }finally{authority.close();}
  }
}catch{process.exitCode=1;}
