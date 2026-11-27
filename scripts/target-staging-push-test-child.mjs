/** E-2: the ACTOR's own device, by the browser's current subscription.
 *  - mode "status": read-only; is this endpoint the actor's live device?
 *  - mode "test": one content-free test notification to that device; a push
 *    service answer of gone (404/410) revokes the device, exactly like the pass.
 * The device must already be the actor's live target in the verified store. */
import {randomUUID} from "node:crypto";
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {targetPushEndpointHash,targetPushSubscription} from "../lib/target-push-endpoint.ts";
import {targetVapidConfig} from "../lib/target-push-vapid.ts";
import {sendTargetWebPush} from "../lib/target-web-push-sender.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";

const directory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const generation=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const owner=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
const reply=value=>process.stdout.write(JSON.stringify(value));
const MESSAGE={
  cs:"Testovací oznámení: upozornění na tomto zařízení fungují.",
  en:"Test notification: alerts work on this device.",
};
try {
  if (process.argv.length!==2 ||
      ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
       "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
       "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED",
       "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED"]
        .some(name=>process.env[name]!=="true") ||
      !directory || !path.isAbsolute(directory) || !generation || !owner)
    throw new Error("unavailable");
  const request=await readTitleCommand(process.stdin,8*1024);
  if (!request||typeof request!=="object"||
      Object.keys(request).sort().join(",")!=="auth,endpoint,endpointHash,language,mode,p256dh"||
      !["status","test"].includes(request.mode)||!["cs","en"].includes(request.language))
    throw new Error("invalid");
  const subscription=targetPushSubscription(
    {endpoint:request.endpoint,keys:{p256dh:request.p256dh,auth:request.auth}},process.env);
  if (!subscription||targetPushEndpointHash(subscription.endpoint)!==request.endpointHash)
    throw new Error("invalid");
  const vapid=targetVapidConfig(process.env);
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:directory,expectedRestoreGeneration:generation,
  });
  try {
    const identity=resolveChildActor({
      stagingDirectory:directory,expectedRestoreGeneration:generation,ownerUserId:owner,
    });
    if (!identity) reply({ok:false,reason:"session_revoked"});
    else {
      const status=authority.ownLivePushTargetStatus(identity.actor,request.endpointHash);
      // A failed preflight or authorization is not proof of device absence.
      if(!status)throw new Error("unavailable");
      const targetId=status.targetId;
      if (request.mode==="status")
        reply(targetId?{ok:true,status:"registered",targetId}:{ok:true,status:"not_registered"});
      else if (!vapid) reply({ok:false,reason:"unavailable"});
      else if (!targetId) reply({ok:false,reason:"not_found"});
      else {
        // No task, title or any other personal content.
        const result=await sendTargetWebPush(subscription,{
          title:"Lumi",body:MESSAGE[request.language],url:"/?view=Settings",tag:"lumi-push-test",
        },{vapid,env:process.env});
        let revoked=false;
        if (result==="gone") {
          // The push service no longer knows this device: revoke it like the pass does.
          const issued=authority.issueWritable(identity.actor);
          const settings=authority.readNotificationSettings(identity.actor);
          if (issued&&settings) {
            const r=authority.changePushTarget(issued.sessionToken,{commandId:randomUUID(),
              action:"revoke",targetId,expectedNotificationEpoch:settings.notificationEpoch,
              restoreGeneration:generation},identity.sessionTokenHash);
            revoked=r.ok===true;
          }
        }
        reply(revoked?{ok:true,result,targetId,revoked:true}:{ok:true,result,targetId});
      }
    }
  } finally { authority.close(); }
} catch { process.exitCode=1; }
