/** E-2: bounded subprocesses for target push delivery (scheduled pass, test message).
 *
 * The child receives an explicit environment allowlist: the notification flags,
 * the staging store binding, the VAPID identity and, only in an isolated browser
 * test run (AI_EXECUTIVE_E2E=true), the loopback fake push origin. Device secrets
 * travel through stdin, never argv or env. The child prints one JSON line. */
import {spawn} from "node:child_process";
import path from "node:path";
import type {StagingPersonalReadConfig} from "./target-staging-read-process";
import type {TargetPushSubscription} from "./target-push-endpoint";
import {TARGET_PUSH_TEST_ORIGIN_ENV} from "./target-push-endpoint";
import {TARGET_VAPID_PRIVATE_ENV,TARGET_VAPID_PUBLIC_ENV} from "./target-push-vapid";
import type {TargetPushVaultRow} from "./target-push-subscription-vault";

/** A pass is bounded by its own send timeouts; this is the outer safety net. */
export const TARGET_PUSH_PASS_CHILD_TIMEOUT_MS=4*60_000;
export const TARGET_PUSH_TEST_CHILD_TIMEOUT_MS=30_000;
const HASH=/^[0-9a-f]{64}$/;
const TARGET_ID=/^pt_[0-9a-f]{32}$/;
const MAX_OUTPUT=512*1024;

export const TARGET_PUSH_FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED",
] as const;
export const targetPushFlagsEnabled=(env:Record<string,string|undefined>=process.env):boolean=>
  TARGET_PUSH_FLAGS.every(name=>env[name]==="true");

function childEnv(config:{stagingDirectory:string;expectedRestoreGeneration:string;
  ownerUserId?:string;sessionTokenHash?:string}):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={
    NODE_ENV:process.env.NODE_ENV||"production",
    AI_EXECUTIVE_DATA_DIR:process.env.AI_EXECUTIVE_DATA_DIR||"",
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:config.stagingDirectory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:config.expectedRestoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:config.ownerUserId||"",
    AI_EXECUTIVE_TARGET_STAGING_SESSION_HASH:config.sessionTokenHash||"",
    [TARGET_VAPID_PUBLIC_ENV]:process.env[TARGET_VAPID_PUBLIC_ENV]||"",
    [TARGET_VAPID_PRIVATE_ENV]:process.env[TARGET_VAPID_PRIVATE_ENV]||"",
    VAPID_SUBJECT:process.env.VAPID_SUBJECT||"",
    AI_EXECUTIVE_PASSKEY_ORIGINS:process.env.AI_EXECUTIVE_PASSKEY_ORIGINS||"",
    AI_EXECUTIVE_ALLOWED_ORIGINS:process.env.AI_EXECUTIVE_ALLOWED_ORIGINS||"",
  };
  for(const flag of TARGET_PUSH_FLAGS)env[flag]=process.env[flag]||"";
  if(process.env.AI_EXECUTIVE_E2E==="true"&&process.env[TARGET_PUSH_TEST_ORIGIN_ENV]){
    env.AI_EXECUTIVE_E2E="true";
    env[TARGET_PUSH_TEST_ORIGIN_ENV]=process.env[TARGET_PUSH_TEST_ORIGIN_ENV];
  }
  return env;
}

function runChild(script:string,env:NodeJS.ProcessEnv,input:string,timeoutMs:number):Promise<unknown|null> {
  return new Promise(resolve=>{
    const cwd=process.cwd();
    let child:ReturnType<typeof spawn>;
    try{
      child=spawn(process.execPath,[
        "--experimental-loader",path.join(cwd,"scripts/target-staging-ts-loader.mjs"),
        path.join(cwd,"scripts",script),
      ],{cwd,windowsHide:true,stdio:["pipe","pipe","ignore"],env});
    }catch{resolve(null);return;}
    let done=false,failed=false,size=0;
    const chunks:Buffer[]=[];
    const finish=(value:unknown|null)=>{if(!done){done=true;clearTimeout(timer);resolve(value);}};
    const timer=setTimeout(()=>{failed=true;child.kill("SIGKILL");},timeoutMs);
    child.stdout!.on("data",(chunk:Buffer)=>{
      size+=chunk.length;
      if(size>MAX_OUTPUT){failed=true;child.kill("SIGKILL");}else chunks.push(chunk);
    });
    child.on("error",()=>{failed=true;finish(null);});
    child.on("close",code=>{
      if(failed||code!==0)return finish(null);
      try{finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch{finish(null);}
    });
    child.stdin!.on("error",()=>{failed=true;child.kill("SIGKILL");});
    child.stdin!.end(input);
  });
}

export interface TargetPushPassChildResult {
  readonly summary:{users:number;sent:number;held:{quiet_hours:number;daily_limit:number;disabled:number};
    deferred?:number;busy?:true};
  /** Hashes of every live device, so secrets of any other device can be pruned. */
  readonly liveHashes:readonly string[]|null;
}

const count=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
export function parseTargetPushPassChildResult(value:unknown):TargetPushPassChildResult|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  if(v.ok!==true||Object.keys(v).sort().join(",")!=="liveHashes,ok,summary")return null;
  const s=v.summary as Record<string,unknown>|null;
  if(!s||typeof s!=="object"||!count(s.users)||!count(s.sent))return null;
  const held=s.held as Record<string,unknown>|null;
  if(!held||typeof held!=="object"||!count(held.quiet_hours)||!count(held.daily_limit)||
    !count(held.disabled))return null;
  if(s.deferred!==undefined&&!count(s.deferred))return null;
  if(s.busy!==undefined&&s.busy!==true)return null;
  const live=v.liveHashes;
  if(live!==null&&(!Array.isArray(live)||live.length>4096||
    live.some(h=>typeof h!=="string"||!HASH.test(h))))return null;
  return {summary:{users:s.users,sent:s.sent,
    held:{quiet_hours:held.quiet_hours,daily_limit:held.daily_limit,disabled:held.disabled},
    ...(s.deferred===undefined?{}:{deferred:s.deferred as number}),
    ...(s.busy===true?{busy:true as const}:{})},
    liveHashes:live as string[]|null};
}

/** One scheduled, identity-bound attention push pass over the whole target store.
 * With deliver=false (no VAPID identity yet) the child sends nothing and only
 * reports the live devices, so secrets of removed devices are still pruned. */
export async function runTargetPushPassInChild(
  store:{stagingDirectory:string;expectedRestoreGeneration:string},
  subscriptions:readonly TargetPushVaultRow[],deliver=true,
):Promise<TargetPushPassChildResult|null> {
  const input=JSON.stringify({deliver,subscriptions:deliver?subscriptions.map(s=>({
    endpointHash:s.endpointHash,endpoint:s.endpoint,p256dh:s.p256dh,auth:s.auth})):[]});
  return parseTargetPushPassChildResult(await runChild("target-staging-push-pass-child.mjs",
    childEnv(store),input,TARGET_PUSH_PASS_CHILD_TIMEOUT_MS));
}

export type TargetPushTestChildResult=
  |{ok:true;result:"sent"|"failed"|"gone";targetId:string;revoked?:true}
  |{ok:false;reason:"not_found"|"unavailable"|"session_revoked"};
export type TargetPushStatusChildResult=
  |{ok:true;status:"registered";targetId:string}|{ok:true;status:"not_registered"}
  |{ok:false;reason:"session_revoked"};
export function parseTargetPushTestChildResult(value:unknown):TargetPushTestChildResult|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  const keys=Object.keys(v).sort().join(",");
  if(v.ok===true&&(keys==="ok,result,targetId"||(keys==="ok,result,revoked,targetId"&&v.revoked===true&&v.result==="gone"))&&
    ["sent","failed","gone"].includes(v.result as string)&&
    typeof v.targetId==="string"&&TARGET_ID.test(v.targetId))
    return {ok:true,result:v.result as "sent"|"failed"|"gone",targetId:v.targetId,...(v.revoked===true?{revoked:true as const}:{})};
  if(v.ok===false&&keys==="ok,reason"&&["not_found","unavailable","session_revoked"].includes(v.reason as string))
    return {ok:false,reason:v.reason as "not_found"|"unavailable"|"session_revoked"};
  return null;
}
export function parseTargetPushStatusChildResult(value:unknown):TargetPushStatusChildResult|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Record<string,unknown>;
  const keys=Object.keys(v).sort().join(",");
  if(v.ok===true&&v.status==="registered"&&keys==="ok,status,targetId"&&typeof v.targetId==="string"&&
    TARGET_ID.test(v.targetId))return {ok:true,status:"registered",targetId:v.targetId};
  if(v.ok===true&&v.status==="not_registered"&&keys==="ok,status")return {ok:true,status:"not_registered"};
  if(v.ok===false&&v.reason==="session_revoked"&&keys==="ok,reason")return {ok:false,reason:"session_revoked"};
  return null;
}

type DeviceConfig=StagingPersonalReadConfig&{sessionTokenHash?:string};
type DeviceSubscription=TargetPushSubscription&{endpointHash:string};
const deviceInput=(mode:"status"|"test",s:DeviceSubscription,language:"cs"|"en")=>JSON.stringify({
  mode,language,endpointHash:s.endpointHash,endpoint:s.endpoint,p256dh:s.p256dh,auth:s.auth});

/** One content-free test message to the ACTOR's own live device (gone revokes it). */
export async function sendTargetPushTestInChild(
  config:DeviceConfig,subscription:DeviceSubscription,language:"cs"|"en"="cs",
):Promise<TargetPushTestChildResult|null> {
  return parseTargetPushTestChildResult(await runChild("target-staging-push-test-child.mjs",
    childEnv(config),deviceInput("test",subscription,language),TARGET_PUSH_TEST_CHILD_TIMEOUT_MS));
}
/** Read-only: is this browser subscription the actor's own live device? */
export async function readTargetPushDeviceStatusInChild(
  config:DeviceConfig,subscription:DeviceSubscription,
):Promise<TargetPushStatusChildResult|null> {
  return parseTargetPushStatusChildResult(await runChild("target-staging-push-test-child.mjs",
    childEnv(config),deviceInput("status",subscription,"cs"),TARGET_PUSH_TEST_CHILD_TIMEOUT_MS));
}
