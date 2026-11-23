#!/usr/bin/env node
/** C-3b deploy-only consent fence provision, first owner grant, or strict check.
 * No HTTP, app startup or restore path calls this script. A later deploy uses
 * --check ONLY and cannot repair a missing/revoked grant.
 */
import path from "node:path";
import {provisionInboxAIFenceFile,INBOX_AI_FENCE_PRODUCTION_PATH}
  from "../lib/target-inbox-ai-consent-fence.ts";
import {openVerifiedInboxC3bFence} from "../lib/target-inbox-c3b-runtime.ts";
import {TargetStagingSessionAuthority}
  from "../lib/target-staging-session-authority.ts";
import {checkFirstDeployInboxAIConsent,grantFirstDeployInboxAIConsent}
  from "../lib/target-inbox-ai-first-deploy.ts";

const usage="usage: target-inbox-ai-fence-provision.mjs --provision|--first-grant|--check --directory /var/lib/ai-executive-target/personal-v1 [--owner ID --generation UUID]";
const args=process.argv.slice(2),mode=args[0];
const dir=args[1]==="--directory"?args[2]:null;
const owner=args[3]==="--owner"?args[4]:null;
const generation=args[5]==="--generation"?args[6]:null;
const expected="/var/lib/ai-executive-target/personal-v1";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actor=/^[A-Za-z0-9_.:@-]{1,120}$/;
if(!["--provision","--first-grant","--check"].includes(mode)||
   !dir||dir!==expected||!path.isAbsolute(dir)||
   INBOX_AI_FENCE_PRODUCTION_PATH!=="/var/lib/ai-executive-target/inbox-ai-consent-fence.sqlite"||
   (mode==="--provision"
     ?args.length!==3
     :args.length!==7||!actor.test(owner??"")||!uuid.test(generation??""))){
  process.stderr.write(usage+"\n");
  process.exitCode=1;
}else{
  let ok=false;
  if(mode==="--provision"){
    ok=provisionInboxAIFenceFile(dir,"provision");
  }else if(provisionInboxAIFenceFile(dir,"check")){
    const fence=openVerifiedInboxC3bFence(dir);
    if(fence){
      const authority=new TargetStagingSessionAuthority({
        stagingDirectory:dir,expectedRestoreGeneration:generation,
      });
      try{
        ok=mode==="--check"
          ?checkFirstDeployInboxAIConsent(authority,fence,owner,generation)
          :process.env.LUMI_INBOX_AI_FIRST_ROLLOUT==="1"&&
            grantFirstDeployInboxAIConsent(authority,fence,owner,generation);
      }finally{authority.close();fence.close();}
    }
  }
  process.stdout.write(JSON.stringify({ok,mode:mode.slice(2)})+"\n");
  process.exitCode=ok?0:1;
}
