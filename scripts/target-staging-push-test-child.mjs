/** E-2: one content-free test notification to the ACTOR's own live device.
 * The device must already be the actor's live target in the verified store. */
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
      Object.keys(request).sort().join(",")!=="auth,endpoint,endpointHash,p256dh")
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
    else if (!vapid) reply({ok:false,reason:"unavailable"});
    else {
      const targetId=authority.ownLivePushTarget(identity.actor,request.endpointHash);
      if (!targetId) reply({ok:false,reason:"not_found"});
      else {
        // No task, title or any other personal content.
        const result=await sendTargetWebPush(subscription,{
          title:"Lumi",body:"Testovací oznámení: upozornění na tomto zařízení fungují.",
          url:"/?view=Settings",tag:"lumi-push-test",
        },{vapid,env:process.env});
        reply({ok:true,result,targetId});
      }
    }
  } finally { authority.close(); }
} catch { process.exitCode=1; }
