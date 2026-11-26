/** E-2: one scheduled, identity-bound target attention push pass.
 * Identities come only from the verified store; device secrets arrive on stdin
 * and are used only for a device the store confirms as that user's own live target.
 * Prints the content-free summary and the live device hashes (for vault pruning). */
import path from "node:path";
import {TargetStagingSessionAuthority} from "../lib/target-staging-session-authority.ts";
import {targetPushEndpointHash,targetPushSubscription} from "../lib/target-push-endpoint.ts";
import {targetVapidConfig} from "../lib/target-push-vapid.ts";
import {createTargetWebPushSender} from "../lib/target-web-push-sender.ts";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";

const directory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const generation=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
try {
  if (process.argv.length!==2 ||
      ["AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
       "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
       "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED",
       "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED"]
        .some(name=>process.env[name]!=="true") ||
      !directory || !path.isAbsolute(directory) || !generation)
    throw new Error("unavailable");
  // At most 4096 devices of at most ~2.3 KiB each.
  const request=await readTitleCommand(process.stdin,12*1024*1024);
  if (!request||typeof request!=="object"||!Array.isArray(request.subscriptions)||
      Object.keys(request).sort().join(",")!=="deliver,subscriptions"||typeof request.deliver!=="boolean"||
      request.subscriptions.length>4096||(!request.deliver&&request.subscriptions.length!==0))
    throw new Error("invalid");
  // Prune-only (no VAPID identity yet): report the live devices, send nothing.
  const vapid=request.deliver?targetVapidConfig(process.env):null;
  if (request.deliver&&!vapid) throw new Error("unavailable");
  const secrets=new Map();
  for (const row of request.subscriptions) {
    if (!row||typeof row!=="object") continue;
    const subscription=targetPushSubscription(
      {endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}},process.env);
    // A row whose hash does not match its endpoint is ignored, never trusted.
    if (subscription&&targetPushEndpointHash(subscription.endpoint)===row.endpointHash)
      secrets.set(row.endpointHash,subscription);
  }
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:directory,expectedRestoreGeneration:generation,
  });
  try {
    const sender=vapid&&createTargetWebPushSender({vapid,env:process.env,
      subscriptionFor:(userId,targetId)=>{
        const hash=authority.livePushEndpointHash(userId,targetId);
        return hash?secrets.get(hash)??null:null;
      }});
    const summary=vapid?await authority.runAttentionPushPass(Date.now(),sender)
      :{users:0,sent:0,held:{quiet_hours:0,daily_limit:0,disabled:0}};
    const liveHashes=authority.allLivePushEndpointHashes();
    process.stdout.write(JSON.stringify({ok:true,summary,liveHashes}));
  } finally { authority.close(); }
} catch { process.exitCode=1; }
