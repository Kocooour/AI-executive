/** R2d.5d.3: actor-bound, read-only notification settings snapshot. No listeners/writes. */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";

try {
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(process.argv.length!==2||
     ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
      "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED"]
       .some(name=>process.env[name]!=="true")||
     !stagingDirectory||!path.isAbsolute(stagingDirectory)||
     !expectedRestoreGeneration||!ownerUserId)throw new Error("unavailable");
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory,expectedRestoreGeneration,
  });
  try {
    const identity=resolveChildActor({
      stagingDirectory,expectedRestoreGeneration,ownerUserId,
    });
    if(!identity)throw new Error("unauthorized");
    const view=authority.readNotificationSettings(identity.actor);
    // actorUserId only feeds the parent's live guard; the route never releases it.
    process.stdout.write(JSON.stringify(view
      ?{ok:true,actorUserId:identity.actor,timeZone:view.timeZone,
        attentionPush:view.attentionPush,quietStart:view.quietStart,
        quietEnd:view.quietEnd,dailyLimit:view.dailyLimit,paused:view.paused,
        settingsRevision:view.settingsRevision,
        notificationEpoch:view.notificationEpoch,targetIds:view.targetIds}
      :{ok:false,reason:"inaccessible"}));
  }finally{authority.close();}
}catch{process.exitCode=1;}
