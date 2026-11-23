/** C-3b default-off runtime gates and cross-worker cryptographic bindings.
 * Never derive an actor or commit key from a client request. */
import {createHmac} from "node:crypto";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {inboxWorkerProofKey} from "./target-inbox-command-identity";
import {INBOX_AI_FENCE_PRODUCTION_PATH,verifiedInboxAIFencePath}
  from "./target-inbox-ai-consent-fence";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const HEX=/^[a-f0-9]{64}$/;
export const c3bEnabled=()=>[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_C3B_ENABLED",
].every(v=>process.env[v]==="true");
export const c3bWriteEnabled=()=>c3bEnabled()&&[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED",
].every(v=>process.env[v]==="true");
export function c3bConfig():StagingPersonalReadConfig|null{
  const stagingDirectory=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  const expectedRestoreGeneration=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
  const ownerUserId=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  return stagingDirectory?.startsWith("/")&&typeof expectedRestoreGeneration==="string"&&
    UUID.test(expectedRestoreGeneration)&&typeof ownerUserId==="string"&&
    ACTOR.test(ownerUserId)
    ?{stagingDirectory,expectedRestoreGeneration,ownerUserId}:null;
}
export function c3bUnchanged(base:StagingPersonalReadConfig,write=false):boolean{
  const now=c3bConfig();
  return (write?c3bWriteEnabled():c3bEnabled())&&Boolean(now&&
    now.stagingDirectory===base.stagingDirectory&&
    now.expectedRestoreGeneration===base.expectedRestoreGeneration&&
    now.ownerUserId===base.ownerUserId);
}
export function inboxC3bActionKey():Buffer|null{
  const raw=process.env.AI_EXECUTIVE_SESSION_SECRET===undefined
    ?process.env.AI_EXECUTIVE_TARGET_STAGING_INBOX_PROOF_KEY:inboxWorkerProofKey();
  return raw&&HEX.test(raw)?Buffer.from(raw,"hex"):null;
}
/** Derive a secret one-way binding from the VALIDATED owner cookie.
 * Parent HTTP verifies this cookie first; its RAW value NEVER enters workers.
 * A newly issued owner session cannot accept the previous session's token. */
export function inboxC3bOwnerCookieBinding(
  ownerCookie:string,actor:string,restoreGeneration:string,
):string|null{
  const key=inboxC3bActionKey();
  return key&&typeof ownerCookie==="string"&&ownerCookie.length>0&&
     ownerCookie.length<=8192&&ACTOR.test(actor)&&UUID.test(restoreGeneration)
    ?createHmac("sha256",key).update(JSON.stringify([
      "lumi:c3b:owner-cookie-binding:v2",ownerCookie,
      actor,restoreGeneration.toLowerCase(),
    ])).digest("hex"):null;
}
export function inboxC3bSessionBinding(
  actor:string,restoreGeneration:string,durableSessionHash?:string,
  ownerCookieBinding?:string,
):string|null{
  if(durableSessionHash!==undefined)
    return HEX.test(durableSessionHash)?durableSessionHash:null;
  return ACTOR.test(actor)&&UUID.test(restoreGeneration)&&
    typeof ownerCookieBinding==="string"&&HEX.test(ownerCookieBinding)
    ?ownerCookieBinding:null;
}
/** Missing/unprovisioned/corrupt external fence is always AI-OFF. */
export function openVerifiedInboxC3bFence(targetDirectory:string):DatabaseSync|null{
  const testParent=path.dirname(targetDirectory);
  const e2e=process.env.AI_EXECUTIVE_E2E==="true"&&
    process.env.LUMI_TARGET_INBOX_C3B_E2E==="true"&&
    targetDirectory===path.join(testParent,"target-store")&&
    /^lumi-e2e-[A-Za-z0-9_-]+$/.test(path.basename(testParent))&&
    testParent.startsWith("/tmp/");
  const filename=e2e?path.join(testParent,"inbox-ai-consent-fence.sqlite")
    :INBOX_AI_FENCE_PRODUCTION_PATH;
  // Synthetic substitution is limited to the explicitly isolated Playwright
  // directory, never a configurable arbitrary path or the target restore DB.
  if(!verifiedInboxAIFencePath(filename,targetDirectory))return null;
  let db:DatabaseSync|null=null;
  try{
    db=new DatabaseSync(filename,{timeout:200});
    const check=db.prepare("SELECT v FROM inbox_ai_fence_meta WHERE k='schema_version'")
      .get() as {v:unknown}|undefined;
    const integrity=db.prepare("PRAGMA quick_check").get() as {quick_check:unknown}|undefined;
    if(check?.v!==1||integrity?.quick_check!=="ok"||
       !verifiedInboxAIFencePath(filename,targetDirectory)){
      db.close();return null;
    }
    db.exec("PRAGMA busy_timeout=200");
    return db;
  }catch{try{db?.close();}catch{}return null;}
}
