/** E-2: browser client of the target notification settings, devices and test push.
 * Strict response parsing; nothing is stored in browser storage. */
export type TargetNotificationSettings={
  timeZone:string;attentionPush:boolean;quietStart:string;quietEnd:string;
  dailyLimit:number;paused:boolean;expectedSettingsRevision:number;
  expectedNotificationEpoch:number;restoreGeneration:string;targets:string[];
};
export type TargetPushFailure="disabled"|"unauthorized"|"stale"|"not_found"|"invalid"|"limited"|"unavailable";
export type TargetPushResult<T>={ok:true;value:T}|{ok:false;reason:TargetPushFailure};
export type BrowserSubscription={endpoint:string;keys:{p256dh:string;auth:string}};

const SETTINGS="/api/target-staging/notifications/settings";
const TARGETS="/api/target-staging/notifications/targets";
const CONFIG="/api/target-staging/notifications/push-config";
const TEST="/api/target-staging/notifications/test";
const TARGET_ID=/^pt_[0-9a-f]{32}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HHMM=/^([01]\d|2[0-3]):[0-5]\d$/;
const count=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;

function failure(status:number):TargetPushFailure {
  if(status===404)return "not_found";
  if(status===401||status===403)return "unauthorized";
  if(status===409)return "stale";
  if(status===400||status===413)return "invalid";
  if(status===429)return "limited";
  return "unavailable";
}
async function call(url:string,init:RequestInit,signal?:AbortSignal):Promise<{status:number;body:unknown}|null> {
  try{
    const response=await fetch(url,{...init,cache:"no-store",credentials:"same-origin",redirect:"error",signal});
    let body:unknown=null;
    try{body=await response.json();}catch{body=null;}
    return {status:response.status,body};
  }catch{return null;}
}
const write=(method:"PATCH"|"POST",body:unknown):RequestInit=>({method,
  headers:{"content-type":"application/json",accept:"application/json","x-lumi-target-protocol":"1"},
  body:JSON.stringify(body)});

export function parseTargetNotificationSettings(v:unknown):TargetNotificationSettings|null {
  if(!v||typeof v!=="object"||Array.isArray(v))return null;
  const x=v as Record<string,unknown>;
  if(Object.keys(x).sort().join(",")!=="attentionPush,dailyLimit,expectedNotificationEpoch,"+
    "expectedSettingsRevision,paused,quietEnd,quietStart,restoreGeneration,targets,timeZone")return null;
  if(typeof x.timeZone!=="string"||x.timeZone.length>64||typeof x.attentionPush!=="boolean"||
    typeof x.paused!=="boolean"||typeof x.quietStart!=="string"||!HHMM.test(x.quietStart)||
    typeof x.quietEnd!=="string"||!HHMM.test(x.quietEnd)||!count(x.dailyLimit)||x.dailyLimit>10||
    !count(x.expectedSettingsRevision)||!count(x.expectedNotificationEpoch)||
    typeof x.restoreGeneration!=="string"||!UUID.test(x.restoreGeneration)||
    !Array.isArray(x.targets)||x.targets.length>64||
    x.targets.some(t=>typeof t!=="string"||!TARGET_ID.test(t)))return null;
  return x as unknown as TargetNotificationSettings;
}

export async function readTargetNotificationSettings(signal?:AbortSignal):Promise<TargetPushResult<TargetNotificationSettings>> {
  const r=await call(SETTINGS,{method:"GET",headers:{accept:"application/json"}},signal);
  if(!r)return {ok:false,reason:"unavailable"};
  if(r.status===404)return {ok:false,reason:"disabled"};
  if(r.status!==200)return {ok:false,reason:failure(r.status)};
  const value=parseTargetNotificationSettings(r.body);
  return value?{ok:true,value}:{ok:false,reason:"unavailable"};
}

export async function readTargetPushConfig(signal?:AbortSignal):Promise<TargetPushResult<{available:boolean;publicKey:string|null}>> {
  const r=await call(CONFIG,{method:"GET",headers:{accept:"application/json"}},signal);
  if(!r)return {ok:false,reason:"unavailable"};
  if(r.status===404)return {ok:false,reason:"disabled"};
  if(r.status!==200)return {ok:false,reason:failure(r.status)};
  const b=r.body as Record<string,unknown>|null;
  if(b&&b.available===false&&b.publicKey===null)return {ok:true,value:{available:false,publicKey:null}};
  if(b&&b.available===true&&typeof b.publicKey==="string"&&/^[A-Za-z0-9_-]{87}$/.test(b.publicKey))
    return {ok:true,value:{available:true,publicKey:b.publicKey}};
  return {ok:false,reason:"unavailable"};
}

export async function writeTargetNotificationSettings(
  s:TargetNotificationSettings,
  next:Pick<TargetNotificationSettings,"timeZone"|"attentionPush"|"quietStart"|"quietEnd"|"paused">,
):Promise<TargetPushResult<null>> {
  const r=await call(SETTINGS,write("PATCH",{commandId:crypto.randomUUID(),timeZone:next.timeZone,
    attentionPush:next.attentionPush,quietStart:next.quietStart,quietEnd:next.quietEnd,
    dailyLimit:s.dailyLimit,paused:next.paused,expectedSettingsRevision:s.expectedSettingsRevision,
    expectedNotificationEpoch:s.expectedNotificationEpoch,restoreGeneration:s.restoreGeneration}));
  if(!r)return {ok:false,reason:"unavailable"};
  return r.status===200?{ok:true,value:null}:{ok:false,reason:failure(r.status)};
}

/** Register (or confirm) this browser's subscription as the actor's own device. */
export async function registerTargetPushDevice(
  s:TargetNotificationSettings,subscription:BrowserSubscription,
):Promise<TargetPushResult<string>> {
  const r=await call(TARGETS,write("POST",{commandId:crypto.randomUUID(),action:"register",
    endpoint:subscription.endpoint,keys:{p256dh:subscription.keys.p256dh,auth:subscription.keys.auth},
    expectedNotificationEpoch:s.expectedNotificationEpoch,restoreGeneration:s.restoreGeneration}));
  if(!r)return {ok:false,reason:"unavailable"};
  const b=r.body as Record<string,unknown>|null;
  if(r.status===200&&b&&typeof b.targetId==="string"&&TARGET_ID.test(b.targetId))
    return {ok:true,value:b.targetId};
  return {ok:false,reason:r.status===200?"unavailable":failure(r.status)};
}

export async function revokeTargetPushDevice(
  s:TargetNotificationSettings,targetId:string,
):Promise<TargetPushResult<null>> {
  const r=await call(TARGETS,write("POST",{commandId:crypto.randomUUID(),action:"revoke",targetId,
    expectedNotificationEpoch:s.expectedNotificationEpoch,restoreGeneration:s.restoreGeneration}));
  if(!r)return {ok:false,reason:"unavailable"};
  return r.status===200?{ok:true,value:null}:{ok:false,reason:failure(r.status)};
}

export async function sendTargetPushTest(
  subscription:BrowserSubscription,
):Promise<TargetPushResult<{result:"sent"|"failed"|"gone";targetId:string}>> {
  const r=await call(TEST,write("POST",{subscription:{endpoint:subscription.endpoint,
    keys:{p256dh:subscription.keys.p256dh,auth:subscription.keys.auth}}}));
  if(!r)return {ok:false,reason:"unavailable"};
  const b=r.body as Record<string,unknown>|null;
  if(r.status===200&&b&&["sent","failed","gone"].includes(b.result as string)&&
    typeof b.targetId==="string"&&TARGET_ID.test(b.targetId))
    return {ok:true,value:{result:b.result as "sent"|"failed"|"gone",targetId:b.targetId}};
  return {ok:false,reason:r.status===200?"unavailable":failure(r.status)};
}

/** The browser's PushSubscription as plain data, or null for anything unexpected. */
export function browserSubscription(subscription:PushSubscription|null):BrowserSubscription|null {
  if(!subscription)return null;
  const json=subscription.toJSON() as {endpoint?:unknown;keys?:{p256dh?:unknown;auth?:unknown}};
  if(typeof json.endpoint!=="string"||typeof json.keys?.p256dh!=="string"||typeof json.keys?.auth!=="string")
    return null;
  return {endpoint:json.endpoint,keys:{p256dh:json.keys.p256dh,auth:json.keys.auth}};
}

/** Does the browser subscription belong to this VAPID identity? */
export function subscribedWithKey(subscription:PushSubscription,publicKey:string):boolean {
  const key=subscription.options?.applicationServerKey;
  if(!key)return false;
  const bytes=new Uint8Array(key);
  let binary="";
  for(const b of bytes)binary+=String.fromCharCode(b);
  return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")===publicKey;
}

export function base64UrlToBytes(value:string):Uint8Array<ArrayBuffer> {
  const padded=value.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-value.length%4)%4);
  const binary=atob(padded);
  const out=new Uint8Array(new ArrayBuffer(binary.length));
  for(let i=0;i<binary.length;i++)out[i]=binary.charCodeAt(i);
  return out;
}

/** E-2: on sign-out, stop task alerts on THIS device. Unsubscribing the browser's
 * target push subscription ends delivery at the push service itself; the next
 * pass then sees 404/410 and revokes the device. Best effort, bounded, never throws. */
export async function silenceTargetPushOnThisDevice(timeoutMs=3000):Promise<void> {
  if(typeof window==="undefined"||!("serviceWorker" in navigator)||!("PushManager" in window))return;
  const work=(async()=>{
    const config=await readTargetPushConfig();
    if(config.ok===false||!config.value.publicKey)return;
    const registration=await navigator.serviceWorker.getRegistration();
    const subscription=await registration?.pushManager.getSubscription();
    if(subscription&&subscribedWithKey(subscription,config.value.publicKey))await subscription.unsubscribe();
  })().catch(()=>undefined);
  await Promise.race([work,new Promise<void>(resolve=>setTimeout(resolve,timeoutMs))]);
}
