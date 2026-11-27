import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,existsSync,utimesSync} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";
import webpush from "web-push";
import {decryptWebPush,syntheticBrowserKeys} from "./support/web-push-decrypt.mjs";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-e2-push-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
const FLAGS=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED",
];
const VAPID=webpush.generateVAPIDKeys();
const touched=["AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_E2E","LUMI_E2E_TARGET_PUSH_TEST_ORIGIN",
  "AI_EXECUTIVE_TARGET_VAPID_PUBLIC_KEY","AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY","VAPID_SUBJECT",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY","AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",...FLAGS];
const old=Object.fromEntries(touched.map(k=>[k,process.env[k]]));
process.env.AI_EXECUTIVE_DATA_DIR=legacy;

const endpointLib=await import("../lib/target-push-endpoint.ts");
const {allowedTargetPushEndpoint,targetPushSubscription,targetPushTestOrigin,targetPushEndpointHash}=endpointLib;
const {targetVapidConfig,targetVapidSubject}=await import("../lib/target-push-vapid.ts");
const {publicPushAddress,sendTargetWebPush,createTargetWebPushSender}=await import("../lib/target-web-push-sender.ts");
const vaultLib=await import("../lib/target-push-subscription-vault.ts");
const {acquireTargetPushLock,runTargetPushSchedulerTick,targetPushOwnsAttention,targetPushDeliveryConfigured,
  TARGET_PUSH_LOCK_FILENAME,TARGET_PUSH_LOCK_STALE_MS}=await import("../lib/target-push-scheduler.ts");
const {parseTargetPushPassChildResult,parseTargetPushTestChildResult,parseTargetPushStatusChildResult,
  runTargetPushPassInChild}=
  await import("../lib/target-push-process.ts");
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");

const authorities=[];
after(()=>{
  for(const a of authorities)a.close();
  for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  rmSync(root,{recursive:true,force:true});
});
const sha=t=>createHash("sha256").update(t,"utf8").digest("hex");
const KEYS={p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64,7)]).toString("base64url"),
  auth:Buffer.alloc(16,9).toString("base64url")};
const testEnv=origin=>({AI_EXECUTIVE_E2E:"true",LUMI_E2E_TARGET_PUSH_TEST_ORIGIN:origin});

test("only exact public push service hosts on the default HTTPS port are registrable",()=>{
  for(const ok of [
    "https://web.push.apple.com/QK7f-abc","https://fcm.googleapis.com/fcm/send/x:y",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
  ])assert.equal(allowedTargetPushEndpoint(ok,{}),true,ok);
  for(const bad of [
    "http://fcm.googleapis.com/x","https://fcm.googleapis.com:443/x","https://fcm.googleapis.com:8443/x",
    "https://FCM.googleapis.com/x","https://fcm.googleapis.com./x","https://evil.fcm.googleapis.com/x",
    "https://fcm.googleapis.com.evil.test/x","https://xn--fcm-googleapis-com.test/x",
    "https://web.push.apple.com/","https://user@web.push.apple.com/x","https://web.push.apple.com/x#y",
    "https://142.250.0.1/x","https://[2a00::1]/x","https://localhost/x","https://push.example.test/x",
    "https://web.push.apple.com/"+"a".repeat(2048),"https://web.push.apple.com/a\\b",
    "javascript:alert(1)","",null,42,{},
  ])assert.equal(allowedTargetPushEndpoint(bad,{}),false,String(bad));
});

test("the loopback fake push origin needs the browser-test marker, an exact origin and its path prefix",()=>{
  const origin="http://127.0.0.1:43123";
  assert.equal(targetPushTestOrigin({LUMI_E2E_TARGET_PUSH_TEST_ORIGIN:origin}),null,"no marker, no test origin");
  assert.equal(targetPushTestOrigin({...testEnv(origin),AI_EXECUTIVE_E2E:"1"}),null);
  assert.equal(targetPushTestOrigin(testEnv(origin)),origin);
  for(const bad of ["http://localhost:43123","https://127.0.0.1:43123","http://127.0.0.2:43123",
    "http://127.0.0.1","http://127.0.0.1:0","http://127.0.0.1:99999","http://127.0.0.1:43123/"])
    assert.equal(targetPushTestOrigin(testEnv(bad)),null,bad);
  assert.equal(allowedTargetPushEndpoint(origin+"/lumi-e2e-push/a",testEnv(origin)),true);
  assert.equal(allowedTargetPushEndpoint(origin+"/lumi-e2e-push/",testEnv(origin)),false);
  assert.equal(allowedTargetPushEndpoint(origin+"/admin",testEnv(origin)),false);
  assert.equal(allowedTargetPushEndpoint("http://127.0.0.1:43124/lumi-e2e-push/a",testEnv(origin)),false);
  assert.equal(allowedTargetPushEndpoint(origin+"/lumi-e2e-push/a",{}),false);
});

test("a subscription must be the strict browser shape with valid P-256 and auth keys",()=>{
  const ep="https://fcm.googleapis.com/fcm/send/abc";
  assert.deepEqual(targetPushSubscription({endpoint:ep,keys:KEYS},{}),{endpoint:ep,...KEYS});
  assert.deepEqual(targetPushSubscription({endpoint:ep,expirationTime:null,keys:KEYS},{}),{endpoint:ep,...KEYS});
  for(const bad of [
    {endpoint:ep},{endpoint:ep,keys:KEYS,extra:1},{endpoint:ep,expirationTime:5,keys:KEYS},
    {endpoint:ep,keys:{...KEYS,extra:"x"}},{endpoint:ep,keys:{p256dh:KEYS.p256dh}},
    {endpoint:ep,keys:{...KEYS,p256dh:Buffer.alloc(65,5).toString("base64url")}},
    {endpoint:ep,keys:{...KEYS,p256dh:Buffer.alloc(33,4).toString("base64url")}},
    {endpoint:ep,keys:{...KEYS,auth:Buffer.alloc(15,1).toString("base64url")}},
    {endpoint:ep,keys:{...KEYS,auth:KEYS.auth+"="}},{endpoint:ep,keys:{...KEYS,auth:"+/+/"}},
    {endpoint:"https://push.example.test/x",keys:KEYS},null,[],"x",
  ])assert.equal(targetPushSubscription(bad,{}),null,JSON.stringify(bad));
});

test("only globally routable unicast addresses may be contacted",()=>{
  for(const ok of ["142.250.74.10","17.57.144.10","2a00:1450:4001:82a::200a"])
    assert.equal(publicPushAddress(ok),true,ok);
  for(const bad of ["127.0.0.1","10.0.0.1","172.16.5.4","192.168.1.1","169.254.169.254","100.64.0.1",
    "0.0.0.0","224.0.0.1","255.255.255.255","198.18.0.1","::1","::","fe80::1","fc00::1","fd12::1",
    "::ffff:127.0.0.1","::ffff:10.0.0.1","64:ff9b::a00:1","2001:db8::1","ff02::1","not-an-ip",""])
    assert.equal(publicPushAddress(bad),false,bad);
});

test("VAPID: dedicated, consistent keys and a public subject are required",()=>{
  const base={AI_EXECUTIVE_TARGET_VAPID_PUBLIC_KEY:VAPID.publicKey,
    AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:VAPID.privateKey,VAPID_SUBJECT:"https://lumi.example.test"};
  assert.deepEqual({...targetVapidConfig(base)},{publicKey:VAPID.publicKey,privateKey:VAPID.privateKey,
    subject:"https://lumi.example.test"});
  const other=webpush.generateVAPIDKeys();
  for(const bad of [{},{...base,AI_EXECUTIVE_TARGET_VAPID_PUBLIC_KEY:""},
    {...base,AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:other.privateKey},
    {...base,AI_EXECUTIVE_TARGET_VAPID_PUBLIC_KEY:VAPID.publicKey+"="},
    {...base,AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:"short"},
    {...base,VAPID_SUBJECT:"http://lumi.example.test"},{...base,VAPID_SUBJECT:"mailto:nobody"},
  ])assert.equal(targetVapidConfig(bad),null);
  // Without an explicit subject, only a configured public HTTPS origin is used.
  const {VAPID_SUBJECT:_,...noSubject}=base;
  assert.equal(targetVapidConfig(noSubject),null);
  assert.equal(targetVapidSubject({AI_EXECUTIVE_PASSKEY_ORIGINS:"http://x.test,https://app.example.test"}),
    "https://app.example.test");
  assert.equal(targetVapidSubject({VAPID_SUBJECT:"mailto:ops@example.test"}),"mailto:ops@example.test");
});

const vapid={publicKey:VAPID.publicKey,privateKey:VAPID.privateKey,subject:"https://lumi.example.test"};
const PAYLOAD={title:"Zaplatit nájem",body:"Termín 1. 11. uplynul.",url:"/?view=MyPlanPreview&taskId=t1",tag:"attention-t1"};
const publicResolver=async()=>[{address:"142.250.74.10",family:4}];

test("the sender encrypts, pins the checked address and maps push service statuses",async()=>{
  const browser=syntheticBrowserKeys();
  const subscription={endpoint:"https://fcm.googleapis.com/fcm/send/device-1",...browser.keys};
  const seen=[];
  const transportFor=status=>async request=>{seen.push(request);return status;};
  assert.equal(await sendTargetWebPush(subscription,PAYLOAD,{vapid,env:{},resolve:publicResolver,
    transport:transportFor(201)}),"sent");
  const request=seen[0];
  assert.equal(request.address,"142.250.74.10");
  assert.equal(request.url.hostname,"fcm.googleapis.com");
  assert.equal(request.method,"POST");
  assert.equal(request.headers["Content-Encoding"],"aes128gcm");
  assert.match(String(request.headers.Authorization),/^vapid t=.+, k=/);
  assert.equal(request.body.includes(Buffer.from("Zaplatit")),false,"payload is encrypted");
  assert.deepEqual(JSON.parse(decryptWebPush(request.body,browser)),PAYLOAD);
  for(const [status,result] of [[200,"sent"],[202,"sent"],[404,"gone"],[410,"gone"],[301,"failed"],
    [400,"failed"],[403,"failed"],[413,"failed"],[429,"failed"],[500,"failed"],[503,"failed"]])
    assert.equal(await sendTargetWebPush(subscription,PAYLOAD,{vapid,env:{},resolve:publicResolver,
      transport:transportFor(status)}),result,String(status));
  assert.equal(await sendTargetWebPush(subscription,PAYLOAD,{vapid,env:{},resolve:publicResolver,
    transport:async()=>{throw new Error("ECONNRESET");}}),"failed");
  // Among public answers IPv4 is preferred (a host without an IPv6 route still delivers).
  const pinned=[];
  await sendTargetWebPush(subscription,PAYLOAD,{vapid,env:{},
    resolve:async()=>[{address:"2a00:1450:4001:82a::200a",family:6},{address:"142.250.74.10",family:4}],
    transport:async r=>{pinned.push(r.address);return 201;}});
  assert.deepEqual(pinned,["142.250.74.10"]);
});

test("the sender contacts nothing for a private, mixed or empty DNS answer, a foreign host or a huge payload",async()=>{
  const subscription={endpoint:"https://web.push.apple.com/device",...KEYS};
  let calls=0;
  const transport=async()=>{calls++;return 201;};
  for(const answer of [[],[{address:"10.0.0.5",family:4}],[{address:"142.250.74.10",family:4},
    {address:"127.0.0.1",family:4}],[{address:"::1",family:6}],[{address:"::ffff:192.168.0.1",family:6}]])
    assert.equal(await sendTargetWebPush(subscription,PAYLOAD,{vapid,env:{},resolve:async()=>answer,transport}),
      "failed",JSON.stringify(answer));
  assert.equal(await sendTargetWebPush(subscription,PAYLOAD,{vapid,env:{},
    resolve:async()=>{throw new Error("ENOTFOUND");},transport}),"failed");
  assert.equal(await sendTargetWebPush({...subscription,endpoint:"https://push.example.test/x"},PAYLOAD,
    {vapid,env:{},resolve:publicResolver,transport}),"failed");
  assert.equal(await sendTargetWebPush(subscription,{...PAYLOAD,body:"x".repeat(4000)},
    {vapid,env:{},resolve:publicResolver,transport}),"failed");
  assert.equal(calls,0);
  // A missing device secret is a retryable failure, never a revocation.
  const sender=createTargetWebPushSender({vapid,env:{},resolve:publicResolver,transport,
    subscriptionFor:()=>null});
  assert.equal(await sender.sendTo("alice","pt_"+"0".repeat(32),PAYLOAD),"failed");
  assert.equal(calls,0);
});

// Exercise the real transport adapter with a real, actor-bound device lookup.
test("revocation during DNS preparation fences the transport, while another live device still sends",async()=>{
  const stage=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice"});
  const authority=new TargetStagingSessionAuthority({stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration});
  authorities.push(authority);
  const subscriptions=new Map();
  const ids=[];
  const token=authority.issueWritable("alice").sessionToken;
  for(const name of ["first","second"]){
    const browser=syntheticBrowserKeys();
    const subscription={endpoint:"https://fcm.googleapis.com/fcm/send/"+name,...browser.keys};
    const hash=targetPushEndpointHash(subscription.endpoint);
    const settings=authority.readNotificationSettings("alice");
    const result=authority.changePushTarget(token,{commandId:randomUUID(),action:"register",
      endpointHash:hash,expectedNotificationEpoch:settings.notificationEpoch,
      restoreGeneration:stage.restoreGeneration});
    assert.equal(result.ok,true,JSON.stringify(result));
    subscriptions.set(hash,subscription);ids.push(result.targetId);
  }
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;});
  const gated=new Promise(resolve=>{release=resolve;});
  let calls=0;
  const sender=createTargetWebPushSender({vapid,env:{},
    subscriptionFor:(userId,targetId)=>{
      const hash=authority.livePushEndpointHash(userId,targetId);
      return hash?subscriptions.get(hash)??null:null;
    },
    resolve:async()=>{enter();await gated;return publicResolver();},
    transport:async()=>{calls++;return 201;}
  });
  const pending=sender.sendTo("alice",ids[0],PAYLOAD);
  await entered;
  const settings=authority.readNotificationSettings("alice");
  assert.equal(authority.changePushTarget(token,{commandId:randomUUID(),action:"revoke",
    targetId:ids[0],expectedNotificationEpoch:settings.notificationEpoch,
    restoreGeneration:stage.restoreGeneration}).ok,true);
  release();
  assert.equal(await pending,"failed");
  assert.equal(calls,0,"revoked during DNS: no network request");
  assert.equal(await sender.sendTo("alice",ids[1],PAYLOAD),"sent");
  assert.equal(calls,1,"other device remains live");
});

test("cancelled or timed-out preparation can never start a late transport",async()=>{
  const subscription={endpoint:"https://fcm.googleapis.com/fcm/send/slow",...syntheticBrowserKeys().keys};
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;});
  const gated=new Promise(resolve=>{release=resolve;});
  let calls=0;
  const sender=createTargetWebPushSender({vapid,env:{},subscriptionFor:()=>subscription,
    resolve:async()=>{enter();await gated;return publicResolver();},
    transport:async()=>{calls++;return 201;}});
  const {sendTargetPushWithTimeout}=await import("../lib/target-attention-push-pass.ts");
  let attempt;
  let observedSignal;
  const timed=sendTargetPushWithTimeout(signal=>{
    observedSignal=signal;
    return attempt=sender.sendTo("alice","pt_"+"1".repeat(32),PAYLOAD,signal);
  },25);
  await entered;
  assert.equal(await timed,"timeout");
  assert.equal(observedSignal.aborted,true);
  release();
  assert.equal(await attempt,"failed");
  assert.equal(calls,0,"late DNS cannot start transport");
  const controller=new AbortController();controller.abort();
  assert.equal(await sender.sendTo("alice","pt_"+"1".repeat(32),PAYLOAD,controller.signal),"failed");
  assert.equal(calls,0);
});

test("logout remains bounded when browser unsubscribe hangs after confirmed server revocation",async()=>{
  const {silenceTargetPushOnThisDevice}=await import("../lib/target-push-client.ts");
  const targetId="pt_"+"1".repeat(32),other="pt_"+"2".repeat(32);
  const keyBytes=Buffer.alloc(65,1),publicKey=keyBytes.toString("base64url");
  const endpoint="https://fcm.googleapis.com/fcm/send/hanging";
  const subscription={endpoint,keys:syntheticBrowserKeys().keys};
  const calls=[];
  const browserSubscription={
    options:{applicationServerKey:Uint8Array.from(keyBytes).buffer},
    toJSON:()=>subscription,
    unsubscribe:()=>{calls.push("unsubscribe");return new Promise(()=>{});}
  };
  const globals={
    window:{PushManager:function(){}},
    navigator:{serviceWorker:{getRegistration:async()=>({pushManager:{
      getSubscription:async()=>browserSubscription}})}},
    fetch:async(url,init)=>{
      const route=String(url).split("/").pop();
      calls.push(route);
      if(route==="push-config")return Response.json({available:true,publicKey});
      if(route==="device-status")return Response.json({registered:true,targetId});
      if(route==="settings")return Response.json({
        timeZone:"Europe/Prague",attentionPush:true,quietStart:"22:00",quietEnd:"08:00",
        dailyLimit:3,paused:false,expectedSettingsRevision:1,expectedNotificationEpoch:2,
        restoreGeneration:randomUUID(),targets:[targetId,other]});
      if(route==="targets"){
        const body=JSON.parse(init.body);
        assert.equal(body.action,"revoke");
        assert.equal(body.targetId,targetId);
        assert.equal(body.expectedNotificationEpoch,2);
        return Response.json({ok:true});
      }
      throw Error("unexpected request");
    }
  };
  const descriptors=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try{
    for(const [key,value] of Object.entries(globals))
      Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    assert.equal(await silenceTargetPushOnThisDevice(5000),true);
    assert.deepEqual(calls,["push-config","device-status","settings","targets","unsubscribe"]);
  }finally{
    for(const [key,descriptor] of descriptors)
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
  }
});

function memoryVault(){
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE target_push_subscriptions (endpoint_hash TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  return db;
}

test("the vault stores only a valid secret under its own endpoint hash and prunes devices that are no longer live",()=>{
  const db=memoryVault();
  const ep=n=>"https://fcm.googleapis.com/fcm/send/"+n;
  const sub=n=>({endpoint:ep(n),...KEYS});
  assert.equal(vaultLib.upsertTargetPushSubscription(db,sha(ep("a")),sub("a"),1000),true);
  assert.equal(vaultLib.upsertTargetPushSubscription(db,sha(ep("b")),sub("a"),1000),false,"hash must match");
  assert.equal(vaultLib.upsertTargetPushSubscription(db,"x",sub("a"),1000),false);
  assert.equal(vaultLib.upsertTargetPushSubscription(db,sha("https://push.example.test/x"),
    {endpoint:"https://push.example.test/x",...KEYS},1000),false,"foreign host");
  assert.equal(vaultLib.upsertTargetPushSubscription(db,sha(ep("b")),sub("b"),5000),true);
  assert.equal(vaultLib.upsertTargetPushSubscription(db,sha(ep("a")),{...sub("a"),auth:Buffer.alloc(16,1).toString("base64url")},2000),true);
  assert.equal(vaultLib.readTargetPushSubscription(db,sha(ep("a"))).auth,Buffer.alloc(16,1).toString("base64url"));
  assert.equal(vaultLib.listTargetPushSubscriptions(db).length,2);
  const grace=vaultLib.TARGET_PUSH_VAULT_PRUNE_GRACE_MS;
  // b was touched inside the grace window: kept although not live yet.
  assert.equal(vaultLib.pruneTargetPushSubscriptions(db,new Set(),5000+grace-1),1);
  assert.deepEqual(vaultLib.listTargetPushSubscriptions(db).map(r=>r.endpointHash),[sha(ep("b"))]);
  assert.equal(vaultLib.pruneTargetPushSubscriptions(db,new Set([sha(ep("b"))]),5000+grace*10),0);
  assert.equal(vaultLib.pruneTargetPushSubscriptions(db,new Set(),5000+grace),1);
  assert.equal(vaultLib.listTargetPushSubscriptions(db).length,0);
});

test("the cross-process pass lock is exclusive, released only by its holder and recovered when stale",()=>{
  const dir=mkdtempSync(path.join(root,"lock-"));
  const a=acquireTargetPushLock(dir,1000);
  assert.ok(a);
  assert.equal(acquireTargetPushLock(dir,1000+TARGET_PUSH_LOCK_STALE_MS-1),null,"a live pass holds it");
  a.release();
  assert.equal(existsSync(path.join(dir,TARGET_PUSH_LOCK_FILENAME)),false);
  const b=acquireTargetPushLock(dir,Date.now());
  assert.ok(b);
  // A crashed holder's lock is recovered only after it can no longer be running.
  const file=path.join(dir,TARGET_PUSH_LOCK_FILENAME);
  const past=(Date.now()-TARGET_PUSH_LOCK_STALE_MS-5000)/1000;
  utimesSync(file,past,past);
  const c=acquireTargetPushLock(dir,Date.now());
  assert.ok(c,"stale lock recovered");
  b.release();
  assert.equal(existsSync(file),true,"an old holder cannot release the new holder's lock");
  c.release();
  assert.equal(existsSync(file),false);
});

const configuredEnv=(extra={})=>({...Object.fromEntries(FLAGS.map(f=>[f,"true"])),
  AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:"/srv/target",
  AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:randomUUID(),
  AI_EXECUTIVE_TARGET_VAPID_PUBLIC_KEY:VAPID.publicKey,AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:VAPID.privateKey,
  VAPID_SUBJECT:"https://lumi.example.test",...extra});

test("target push owns attention once flags and store are set; delivery also needs VAPID",()=>{
  assert.equal(targetPushOwnsAttention({}),false);
  assert.equal(targetPushOwnsAttention(configuredEnv()),true);
  assert.equal(targetPushOwnsAttention(configuredEnv({AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:""})),true,
    "legacy stays silent even before keys exist");
  assert.equal(targetPushDeliveryConfigured(configuredEnv({AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:""})),false);
  for(const flag of FLAGS)assert.equal(targetPushOwnsAttention(configuredEnv({[flag]:"false"})),false,flag);
  assert.equal(targetPushOwnsAttention(configuredEnv({AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:"relative"})),false);
  assert.equal(targetPushDeliveryConfigured(configuredEnv()),true);
});

test("a scheduler tick hands the vault to one pass and prunes secrets of devices that are no longer live",async()=>{
  const db=memoryVault();
  const ep=n=>"https://fcm.googleapis.com/fcm/send/"+n;
  vaultLib.upsertTargetPushSubscription(db,sha(ep("live")),{endpoint:ep("live"),...KEYS},1);
  vaultLib.upsertTargetPushSubscription(db,sha(ep("gone")),{endpoint:ep("gone"),...KEYS},1);
  const dir=mkdtempSync(path.join(root,"tick-"));
  let handed=null;
  const summary={users:1,sent:1,held:{quiet_hours:0,daily_limit:0,disabled:0}};
  const deps={env:configuredEnv(),directory:dir,database:()=>db,now:()=>10_000_000,
    runPass:async(store,rows)=>{handed={store,rows};return {summary,liveHashes:[sha(ep("live"))]};}};
  const tick=await runTargetPushSchedulerTick(deps);
  assert.equal(tick.state,"done");
  assert.equal(tick.pruned,1);
  assert.deepEqual(handed.rows.map(r=>r.endpointHash).sort(),[sha(ep("gone")),sha(ep("live"))].sort());
  assert.deepEqual(vaultLib.listTargetPushSubscriptions(db).map(r=>r.endpointHash),[sha(ep("live"))]);
  assert.equal(existsSync(path.join(dir,TARGET_PUSH_LOCK_FILENAME)),false,"lock released");
  // Flags on but no VAPID keys yet: a prune-only pass that is handed no secret.
  let prune=null;
  const noKeys={...deps,env:configuredEnv({AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:""}),
    runPass:async(store,rows,deliver)=>{prune={rows,deliver};return {summary:{...summary,sent:0},liveHashes:[]};}};
  vaultLib.upsertTargetPushSubscription(db,sha(ep("removed")),{endpoint:ep("removed"),...KEYS},1);
  const pruned=await runTargetPushSchedulerTick(noKeys);
  assert.equal(pruned.state,"done");
  assert.deepEqual(prune,{rows:[],deliver:false});
  assert.equal(vaultLib.listTargetPushSubscriptions(db).length,0,"secrets of devices that are no longer live are pruned");
  // Not configured: nothing runs. Locked by another process: nothing runs.
  let ran=0;
  const counting={...deps,runPass:async()=>{ran++;return {summary,liveHashes:[]};}};
  assert.equal((await runTargetPushSchedulerTick({...counting,env:{}})).state,"off");
  const held=acquireTargetPushLock(dir,Date.now());
  assert.equal((await runTargetPushSchedulerTick({...counting,now:()=>Date.now()})).state,"locked");
  held.release();
  // A failed child prunes nothing.
  assert.equal((await runTargetPushSchedulerTick({...counting,runPass:async()=>null})).state,"failed");
  // Concurrent ticks in one process: the second is busy.
  let release;
  const slow={...counting,runPass:()=>new Promise(r=>{release=()=>r({summary,liveHashes:null});})};
  const first=runTargetPushSchedulerTick(slow);
  assert.equal((await runTargetPushSchedulerTick(counting)).state,"busy");
  await new Promise(r=>setTimeout(r,20));release();
  assert.equal((await first).state,"done");
  assert.equal(ran,0);
});

test("child replies are parsed strictly",()=>{
  const summary={users:1,sent:0,held:{quiet_hours:0,daily_limit:0,disabled:0}};
  assert.ok(parseTargetPushPassChildResult({ok:true,summary,liveHashes:[sha("x")]}));
  assert.ok(parseTargetPushPassChildResult({ok:true,summary:{...summary,busy:true,deferred:2},liveHashes:null}));
  for(const bad of [null,{ok:true,summary},{ok:true,summary,liveHashes:["x"]},
    {ok:true,summary:{...summary,users:-1},liveHashes:[]},{ok:true,summary,liveHashes:[],extra:1},
    {ok:true,summary:{...summary,held:{}},liveHashes:[]}])
    assert.equal(parseTargetPushPassChildResult(bad),null,JSON.stringify(bad));
  const id="pt_"+"a".repeat(32);
  assert.deepEqual(parseTargetPushTestChildResult({ok:true,result:"sent",targetId:id}),{ok:true,result:"sent",targetId:id});
  assert.deepEqual(parseTargetPushTestChildResult({ok:false,reason:"not_found"}),{ok:false,reason:"not_found"});
  assert.deepEqual(parseTargetPushTestChildResult({ok:true,result:"gone",targetId:id,revoked:true}),
    {ok:true,result:"gone",targetId:id,revoked:true});
  assert.equal(parseTargetPushTestChildResult({ok:true,result:"sent",targetId:id,revoked:true}),null,
    "only a gone result can revoke");
  assert.deepEqual(parseTargetPushStatusChildResult({ok:true,status:"registered",targetId:id}),
    {ok:true,status:"registered",targetId:id});
  assert.deepEqual(parseTargetPushStatusChildResult({ok:true,status:"not_registered"}),{ok:true,status:"not_registered"});
  for(const bad of [{ok:true,status:"registered"},{ok:true,status:"not_registered",targetId:id},
    {ok:false,reason:"not_found"},{ok:true,status:"maybe"}])
    assert.equal(parseTargetPushStatusChildResult(bad),null,JSON.stringify(bad));
  for(const bad of [{ok:true,result:"maybe",targetId:id},{ok:true,result:"sent",targetId:"x"},
    {ok:false,reason:"other"},{ok:true,result:"sent",targetId:id,endpoint:"x"}])
    assert.equal(parseTargetPushTestChildResult(bad),null);
});

// ------------------------------------------------------------- integration
function fakePushServer(){
  const received=[];
  const statusFor=new Map();
  const server=http.createServer((req,res)=>{
    const chunks=[];
    req.on("data",c=>chunks.push(c));
    req.on("end",()=>{
      received.push({path:req.url,headers:req.headers,body:Buffer.concat(chunks)});
      res.writeHead(statusFor.get(req.url)??201);res.end();
    });
  });
  return new Promise(resolve=>server.listen(0,"127.0.0.1",()=>resolve({
    server,received,statusFor,origin:"http://127.0.0.1:"+server.address().port})));
}

test("the real pass child: baseline first, then exactly one encrypted message per new item; 410 revokes the device",async()=>{
  const fake=await fakePushServer();
  try{
    const stage=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice"});
    const authority=new TargetStagingSessionAuthority({stagingDirectory:stage.directory,
      expectedRestoreGeneration:stage.restoreGeneration});
    authorities.push(authority);
    const db=new DatabaseSync(stage.databasePath);
    const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
    Object.assign(process.env,{...Object.fromEntries(FLAGS.map(f=>[f,"true"])),...testEnv(fake.origin),
      AI_EXECUTIVE_TARGET_VAPID_PUBLIC_KEY:VAPID.publicKey,AI_EXECUTIVE_TARGET_VAPID_PRIVATE_KEY:VAPID.privateKey,
      VAPID_SUBJECT:"https://lumi.example.test"});
    const token=authority.issueWritable("alice").sessionToken;
    const epoch=()=>db.prepare("SELECT revision FROM personal_notification_epochs WHERE user_id='alice'").get().revision;
    const settings=db.prepare("SELECT revision FROM personal_notification_settings WHERE user_id='alice'").get().revision;
    // An empty quiet window (start = end), so the real clock never holds this test.
    assert.equal(authority.changeNotificationSettings(token,{commandId:randomUUID(),timeZone:"UTC",
      attentionPush:true,quietStart:"00:00",quietEnd:"00:00",dailyLimit:3,paused:false,
      expectedSettingsRevision:settings,expectedNotificationEpoch:epoch(),
      restoreGeneration:stage.restoreGeneration}).ok,true);
    const devices={};
    for(const name of ["phone","old"]){
      const browser=syntheticBrowserKeys();
      const endpoint=fake.origin+"/lumi-e2e-push/"+name;
      const result=authority.changePushTarget(token,{commandId:randomUUID(),action:"register",
        endpointHash:targetPushEndpointHash(endpoint),expectedNotificationEpoch:epoch(),
        restoreGeneration:stage.restoreGeneration});
      assert.equal(result.ok,true,JSON.stringify(result));
      devices[name]={browser,endpoint,targetId:result.targetId,
        row:{endpointHash:targetPushEndpointHash(endpoint),endpoint,...browser.keys}};
    }
    fake.statusFor.set("/lumi-e2e-push/old",410);
    const vault=[devices.phone.row,devices.old.row,
      // A forged row whose hash does not match its endpoint is ignored by the child.
      {...devices.phone.row,endpointHash:sha("forged")}];
    const put=(id,title)=>db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)")
      .run(id,stage.unassignedAreaId,null,title,null,"2026-01-05");
    put("backlog","Starý dluh");
    const first=await runTargetPushPassInChild(store,vault);
    assert.ok(first,"child answered");
    assert.equal(first.summary.sent,0,"first enabled pass only records the baseline");
    assert.equal(fake.received.length,0);
    put("rent","Zaplatit nájem");
    const second=await runTargetPushPassInChild(store,vault);
    assert.equal(second.summary.sent,1);
    const toPhone=fake.received.filter(r=>r.path==="/lumi-e2e-push/phone");
    assert.equal(toPhone.length,1,"exactly one message to the live device");
    assert.equal(toPhone[0].headers["content-encoding"],"aes128gcm");
    assert.equal(toPhone[0].body.includes(Buffer.from("nájem")),false);
    const payload=JSON.parse(decryptWebPush(toPhone[0].body,devices.phone.browser));
    assert.deepEqual(Object.keys(payload).sort(),["body","tag","title","url"]);
    assert.equal(payload.title,"Zaplatit nájem");
    assert.equal(payload.url,"/?view=MyPlanPreview&taskId=rent");
    assert.equal(JSON.stringify(payload).includes("Starý dluh"),false);
    // 410 from the push service revokes that device in the target store.
    assert.notEqual(db.prepare("SELECT revoked_at_ms AS r FROM personal_push_targets WHERE target_id=?")
      .get(devices.old.targetId).r,null);
    assert.deepEqual(second.liveHashes,[devices.phone.row.endpointHash]);
    // Nothing new: nothing sent again.
    const before=fake.received.length;
    const third=await runTargetPushPassInChild(store,vault);
    assert.equal(third.summary.sent,0);
    assert.equal(fake.received.length,before);
    // Prune-only (no VAPID): sends nothing, still reports the live devices.
    const pruneOnly=await runTargetPushPassInChild(store,[],false);
    assert.equal(pruneOnly.summary.sent,0);
    assert.deepEqual(pruneOnly.liveHashes,[devices.phone.row.endpointHash]);
    assert.equal(fake.received.length,before);
    // A device without a secret is retried later, never revoked.
    put("call","Zavolat");
    await runTargetPushPassInChild(store,[devices.old.row]);
    assert.equal(fake.received.length,before);
    assert.equal(db.prepare("SELECT revoked_at_ms AS r FROM personal_push_targets WHERE target_id=?")
      .get(devices.phone.targetId).r,null);
    // A verified absence is a different result from an unavailable authority.
    assert.deepEqual(authority.ownLivePushTargetStatus("alice",devices.phone.row.endpointHash),
      {targetId:devices.phone.targetId});
    assert.deepEqual(authority.ownLivePushTargetStatus("alice",devices.old.row.endpointHash),{targetId:null});
    assert.equal(authority.ownLivePushTargetStatus("missing-actor",devices.phone.row.endpointHash),null);
    db.close();
    authority.close();
    assert.equal(authority.ownLivePushTargetStatus("alice",devices.phone.row.endpointHash),null);
  }finally{
    for(const k of [...FLAGS,"AI_EXECUTIVE_E2E","LUMI_E2E_TARGET_PUSH_TEST_ORIGIN"])delete process.env[k];
    await new Promise(r=>fake.server.close(r));
  }
});
