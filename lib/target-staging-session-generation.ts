/** R3-FE-1: default-off opaque auth-generation for the target client runtime. */
import {createHmac} from "node:crypto";
import path from "node:path";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {StagingHttpIdentity} from "./target-staging-http-identity";
import {authenticationBinding} from "./auth";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
export const TARGET_UI_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED","AI_EXECUTIVE_TARGET_UI_ENABLED",
] as const;
/** Both flags must be exactly "true"; used by the route and the server page. */
export const targetUiEnabled=():boolean=>
  TARGET_UI_FLAGS.every(name=>process.env[name]==="true");

export function targetSessionGenerationConfig():StagingPersonalReadConfig|null {
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  if(!stagingDirectory||!path.isAbsolute(stagingDirectory)||
    !expectedRestoreGeneration||!UUID.test(expectedRestoreGeneration)||
    !ownerUserId||!ACTOR.test(ownerUserId))return null;
  return {stagingDirectory,expectedRestoreGeneration,ownerUserId};
}
export function targetSessionGenerationUnchanged(config:StagingPersonalReadConfig):boolean {
  const current=targetSessionGenerationConfig();
  return targetUiEnabled()&&current?.stagingDirectory===config.stagingDirectory&&
    current.expectedRestoreGeneration===config.expectedRestoreGeneration&&
    current.ownerUserId===config.ownerUserId;
}

/** Opaque, non-secret: HMAC over the identity binding and its live revocation
 * epoch. It reveals neither actor id, token nor cookie. */
export function targetAuthGeneration(
  request:Request,identity:StagingHttpIdentity,epoch:number,
):string {
  const secret=process.env.AI_EXECUTIVE_SESSION_SECRET||"";
  const binding=identity.kind==="owner"
    ?"owner:"+authenticationBinding(request):"session:"+identity.tokenHash;
  return createHmac("sha256",secret)
    .update("lumi:r3:auth-generation:v1\0"+binding+"\0"+String(epoch))
    .digest("base64url");
}
