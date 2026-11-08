/** Default-off staging-only R2d.5d.3 actor-private notification settings / push device HTTP. */
import {createHash} from "node:crypto";
import path from "node:path";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {StagingHttpIdentity} from "./target-staging-http-identity";
import {verifyStagingReadBeforeRelease} from "./target-staging-http-identity";
import type {
  TargetStagingNotificationSettingsCommand,TargetStagingPushTargetCommand,
} from "./target-notification-writer";
import {
  validTargetStagingNotificationSettingsCommand,validTargetStagingPushTargetCommand,
} from "./target-notification-writer";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
export const NOTIFICATIONS_READ_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED",
] as const;
/** Mutations additionally need the generic and the notifications write flags. */
export const NOTIFICATIONS_WRITE_FLAGS=[
  ...NOTIFICATIONS_READ_FLAGS,
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED",
] as const;
export const notificationsReadHttpEnabled=()=>
  NOTIFICATIONS_READ_FLAGS.every(name=>process.env[name]==="true");
export const notificationsWriteHttpEnabled=()=>
  NOTIFICATIONS_WRITE_FLAGS.every(name=>process.env[name]==="true");

export function notificationsHttpConfig():StagingPersonalReadConfig|null {
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!UUID.test(expectedRestoreGeneration)||
    !ownerUserId||!ACTOR.test(ownerUserId))return null;
  return {stagingDirectory,expectedRestoreGeneration,ownerUserId};
}
export function notificationsHttpUnchanged(
  config:StagingPersonalReadConfig,write:boolean,
):boolean {
  const current=notificationsHttpConfig();
  return (write?notificationsWriteHttpEnabled():notificationsReadHttpEnabled())&&
    current?.stagingDirectory===config.stagingDirectory&&
    current.expectedRestoreGeneration===config.expectedRestoreGeneration&&
    current.ownerUserId===config.ownerUserId;
}
export const notificationsHttpAnswer=(status:number,error:string):Response=>
  Response.json({error},{status,headers:{"cache-control":"no-store"}});

export function notificationsSettingsCommand(
  value:unknown,
):TargetStagingNotificationSettingsCommand|null {
  return validTargetStagingNotificationSettingsCommand(value)?value:null;
}

/** Browser PushSubscription endpoint: https only, canonical, no credentials or fragment. */
export function validPushEndpoint(value:unknown):value is string {
  if(typeof value!=="string"||value.length===0||value.length>2048||
    !value.isWellFormed()||/[\u0000- \u007f-\u009f\\]/u.test(value)||
    value.includes("#"))return false;
  let url:URL;
  try{url=new URL(value);}catch{return false;}
  return url.protocol==="https:"&&url.username===""&&url.password===""&&
    url.hash===""&&url.hostname!==""&&url.href===value;
}
export const pushEndpointHash=(endpoint:string):string=>
  createHash("sha256").update(endpoint,"utf8").digest("hex");

/** Public body -> writer command. The raw endpoint is hashed here and goes no further. */
export function notificationsTargetCommand(
  value:unknown,
):TargetStagingPushTargetCommand|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const x=value as Record<string,unknown>;
  const keys=Object.keys(x).sort().join(",");
  let command:unknown;
  if(x.action==="register"){
    if(keys!=="action,commandId,endpoint,expectedNotificationEpoch,restoreGeneration"||
      !validPushEndpoint(x.endpoint))return null;
    command={action:"register",commandId:x.commandId,
      endpointHash:pushEndpointHash(x.endpoint),
      expectedNotificationEpoch:x.expectedNotificationEpoch,
      restoreGeneration:x.restoreGeneration};
  }else if(x.action==="revoke"){
    if(keys!=="action,commandId,expectedNotificationEpoch,restoreGeneration,targetId")
      return null;
    command=x;
  }else return null;
  return validTargetStagingPushTargetCommand(command)?command:null;
}

/** Live release guard: session plus the actor's notification epoch. */
export function verifyNotificationSettingsLive(
  request:Request,identity:StagingHttpIdentity,store:StagingPersonalReadConfig,
  actorUserId:string,notificationEpoch:number,
) {
  return verifyStagingReadBeforeRelease(request,identity,store,store.ownerUserId,
    {actorUserId,areas:[]},undefined,undefined,undefined,undefined,undefined,
    undefined,undefined,undefined,undefined,{notificationEpoch});
}
