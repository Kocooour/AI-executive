/** E-2: which Web Push endpoints the target push may register and contact.
 *
 * Only the browser vendors' public push services are accepted, by exact host on
 * the default HTTPS port. A test run may additionally name ONE loopback fake push
 * origin through LUMI_E2E_TARGET_PUSH_TEST_ORIGIN, honoured only together with the
 * isolated browser-test marker AI_EXECUTIVE_E2E=true; deploy-safe.sh refuses every
 * LUMI_E2E_* key in the production EnvironmentFile, so production cannot enable it.
 * Pure (no I/O); DNS checks of the resolved addresses live in the sender. */
import {createHash} from "node:crypto";
import {isIP} from "node:net";

/** Exact hosts of the public Web Push services (Safari/iOS, Chrome/Edge via FCM, Firefox). */
export const TARGET_PUSH_SERVICE_HOSTS=Object.freeze([
  "web.push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
]);
export const TARGET_PUSH_TEST_ORIGIN_ENV="LUMI_E2E_TARGET_PUSH_TEST_ORIGIN";
/** Every fake endpoint lives under this path, so a stray loopback URL is never accepted. */
export const TARGET_PUSH_TEST_PATH_PREFIX="/lumi-e2e-push/";
const TEST_ORIGIN=/^http:\/\/127\.0\.0\.1:([1-9][0-9]{1,4})$/;
const B64URL=/^[A-Za-z0-9_-]+$/;

export type TargetPushEnv=Record<string,string|undefined>;

/** The loopback fake push origin of a test run, or null (always null in production). */
export function targetPushTestOrigin(env:TargetPushEnv=process.env):string|null {
  const value=env[TARGET_PUSH_TEST_ORIGIN_ENV];
  if(value===undefined||value===""||env.AI_EXECUTIVE_E2E!=="true")return null;
  const match=TEST_ORIGIN.exec(value);
  if(!match||Number(match[1])>65535)return null;
  return value;
}

/** A canonical PushSubscription endpoint of an allowed push service. */
export function allowedTargetPushEndpoint(value:unknown,env:TargetPushEnv=process.env):value is string {
  if(typeof value!=="string"||value.length===0||value.length>2048||
    !value.isWellFormed()||/[\u0000- \u007f-\u009f\\]/u.test(value)||value.includes("#"))return false;
  let url:URL;
  try{url=new URL(value);}catch{return false;}
  if(url.href!==value||url.username!==""||url.password!==""||url.hash!=="")return false;
  const test=targetPushTestOrigin(env);
  if(test!==null&&url.origin===test)
    return url.protocol==="http:"&&url.pathname.startsWith(TARGET_PUSH_TEST_PATH_PREFIX)&&
      url.pathname.length>TARGET_PUSH_TEST_PATH_PREFIX.length;
  // Exact host, default port: no IP literal, userinfo, other port or look-alike suffix.
  return url.protocol==="https:"&&url.port===""&&isIP(url.hostname)===0&&
    TARGET_PUSH_SERVICE_HOSTS.includes(url.hostname)&&url.pathname.length>1;
}

const decoded=(value:unknown,bytes:number):boolean=>{
  if(typeof value!=="string"||!B64URL.test(value))return false;
  const raw=Buffer.from(value,"base64url");
  return raw.length===bytes&&raw.toString("base64url")===value.replace(/=+$/,"");
};

export interface TargetPushSubscription {
  readonly endpoint:string;
  /** Uncompressed P-256 public key of the browser (65 bytes, base64url). */
  readonly p256dh:string;
  /** Web Push auth secret (16 bytes, base64url). */
  readonly auth:string;
}

/** Strict browser `PushSubscription.toJSON()` subset: {endpoint, keys:{p256dh, auth}}
 * (an `expirationTime` of null is tolerated). Anything else is refused. */
export function targetPushSubscription(value:unknown,env:TargetPushEnv=process.env):TargetPushSubscription|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const x=value as Record<string,unknown>;
  const keys=Object.keys(x).sort().join(",");
  if(keys!=="endpoint,keys"&&!(keys==="endpoint,expirationTime,keys"&&x.expirationTime===null))return null;
  if(!allowedTargetPushEndpoint(x.endpoint,env))return null;
  const k=x.keys;
  if(!k||typeof k!=="object"||Array.isArray(k))return null;
  const kk=k as Record<string,unknown>;
  if(Object.keys(kk).sort().join(",")!=="auth,p256dh")return null;
  if(!decoded(kk.p256dh,65)||Buffer.from(kk.p256dh as string,"base64url")[0]!==4||
    !decoded(kk.auth,16))return null;
  return {endpoint:x.endpoint as string,p256dh:kk.p256dh as string,auth:kk.auth as string};
}

/** The same SHA-256 the canonical target store keeps for a device. */
export const targetPushEndpointHash=(endpoint:string):string=>
  createHash("sha256").update(endpoint,"utf8").digest("hex");
