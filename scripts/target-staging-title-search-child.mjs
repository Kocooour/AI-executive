/** R2d.4c — isolated, actor-bound, staging-only title search HTTP worker. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {validAuthorizedTitleQuery} from "../lib/target-authorized-title-search.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try{
  const [scope,encoded,rawLimit,rawOffset,extra]=process.argv.slice(2);
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const canonical=typeof encoded==="string"&&/^[A-Za-z0-9_-]+$/.test(encoded)&&
    encoded.length<=342&&Buffer.from(encoded,"base64url").toString("base64url")===encoded;
  const query=canonical?Buffer.from(encoded,"base64url").toString("utf8"):"";
  if(extra!==undefined||!["all","personal","shared"].includes(scope)||
    !canonical||!validAuthorizedTitleQuery(query)||
    !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit||"")||
    !/^(?:0|[1-9][0-9]{0,6})$/.test(rawOffset||"")||
    Number(rawOffset)>1_000_000||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED!=="true"||
    process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_TITLE_SEARCH_ENABLED!=="true"||
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
      const page=actor&&authority.readAuthorizedTitleSearchPage(
        actor.actor,scope,query,Number(rawLimit),Number(rawOffset));
      if(!page)process.exitCode=1;
      else process.stdout.write(JSON.stringify({ok:true,...page}));
    }finally{authority.close();}
  }
}catch{process.exitCode=1;}
