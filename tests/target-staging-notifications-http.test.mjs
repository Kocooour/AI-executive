import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,readdirSync,statSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const flagNames=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_ENABLED",
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTIFICATIONS_WRITE_ENABLED",
];
const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  ...flagNames,"AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const old=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d5d3-notifications-http-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:"synthetic-notifications-secret-at-least-32",
  ...Object.fromEntries(flagNames.map(k=>[k,"true"])),
});
const {bootstrapIsolatedTargetStore,
  TARGET_STAGING_PERSONAL_NOTIFICATION_RECEIPT_PREFIX:SETTINGS_PREFIX,
  TARGET_STAGING_PERSONAL_PUSH_TARGET_RECEIPT_PREFIX:TARGET_PREFIX}=
  await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET,PATCH}=await import("../app/api/target-staging/notifications/settings/route.ts");
const {POST}=await import("../app/api/target-staging/notifications/targets/route.ts");
const {parseStagingNotificationSettings,readStagingNotificationSettingsInChild}=
  await import("../lib/target-staging-read-process.ts");
const {parseNotificationSettingsWriteReply,parseNotificationTargetWriteReply}=
  await import("../lib/target-staging-notifications-process.ts");
const {verifyNotificationSettingsLive,validPushEndpoint,pushEndpointHash}=
  await import("../lib/target-staging-notifications-http.ts");

const logs=[];
const realError=console.error;
console.error=(...args)=>{logs.push(args.map(String).join(" "));};
let count=0;
after(()=>{
  console.error=realError;
  for(const [key,value] of Object.entries(old)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++count)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  for(const who of ["bob","carol"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  db.close();
  Object.assign(process.env,{
    AI_EXECUTIVE_TARGET_STAGING_DIRECTORY:stage.directory,
    AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION:stage.restoreGeneration,
    AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID:"alice",
  });
  return {stage,store:{
    stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration,
  }};
}
const owner=()=>sessionCookieName+"="+createSessionToken();
function login(fx,who){
  const issued=durable.issueDurableTargetStagingSession(fx.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken;
}
const origin="http://localhost:3001";
let ipCounter=0;
const nextIp=()=>{ipCounter++;return "10.53."+(ipCounter>>8&255)+"."+(ipCounter&255);};
const settingsUrl=origin+"/api/target-staging/notifications/settings";
const targetsUrl=origin+"/api/target-staging/notifications/targets";
const getSettings=(cookie=owner(),extra="",options={})=>GET(new Request(settingsUrl+extra,{
  headers:{cookie,"x-forwarded-for":options.ip||nextIp()}}));
function send(handler,url,body,cookie=owner(),options={}){
  return handler(new Request(url+(options.query||""),{
    method:handler===PATCH?"PATCH":"POST",headers:{
      cookie,"content-type":"application/json","x-forwarded-for":options.ip||nextIp(),
      ...(options.origin===null?{}:{origin:options.origin||origin}),
      ...(options.protocol===null?{}:{"x-lumi-target-protocol":options.protocol||"1"}),
    },body:typeof body==="string"?body:JSON.stringify(body),
  }));
}
const patch=(body,cookie,options)=>send(PATCH,settingsUrl,body,cookie,options);
const post=(body,cookie,options)=>send(POST,targetsUrl,body,cookie,options);
const SETTINGS_KEYS=["attentionPush","dailyLimit","expectedNotificationEpoch",
  "expectedSettingsRevision","paused","quietEnd","quietStart","restoreGeneration",
  "targets","timeZone"];
async function settings(cookie=owner()){
  const response=await getSettings(cookie);
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.deepEqual(Object.keys(body).sort(),SETTINGS_KEYS);
  return body;
}
async function settingsCommand(cookie=owner(),patchValues={}){
  const s=await settings(cookie);
  return {commandId:randomUUID(),timeZone:"Europe/Prague",attentionPush:true,
    quietStart:"22:00",quietEnd:"07:00",dailyLimit:3,paused:false,
    expectedSettingsRevision:s.expectedSettingsRevision,
    expectedNotificationEpoch:s.expectedNotificationEpoch,
    restoreGeneration:s.restoreGeneration,...patchValues};
}
const endpoint=n=>"https://push.example.test/send/synthetic-subscription-token-"+n;
async function registerCommand(ep,cookie=owner()){
  const s=await settings(cookie);
  return {commandId:randomUUID(),action:"register",endpoint:ep,
    expectedNotificationEpoch:s.expectedNotificationEpoch,
    restoreGeneration:s.restoreGeneration};
}
async function revokeCommand(targetId,cookie=owner()){
  const s=await settings(cookie);
  return {commandId:randomUUID(),action:"revoke",targetId,
    expectedNotificationEpoch:s.expectedNotificationEpoch,
    restoreGeneration:s.restoreGeneration};
}
const read=(fx,sql,...params)=>{
  const db=new DatabaseSync(fx.stage.databasePath);
  try{return db.prepare(sql).get(...params);}
  finally{db.close();}
};
const all=(fx,sql,...params)=>{
  const db=new DatabaseSync(fx.stage.databasePath);
  try{return db.prepare(sql).all(...params);}
  finally{db.close();}
};
const mutable=fx=>JSON.stringify([
  all(fx,"SELECT * FROM personal_notification_settings ORDER BY user_id"),
  all(fx,"SELECT * FROM personal_notification_epochs ORDER BY user_id"),
  all(fx,"SELECT user_id,target_id,endpoint_hash,revoked_at_ms FROM personal_push_targets ORDER BY target_id"),
  read(fx,"SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ? OR key LIKE ?",
    SETTINGS_PREFIX+"%",TARGET_PREFIX+"%")]);
function wholeStore(fx){
  const chunks=[];
  const walk=dir=>{
    for(const name of readdirSync(dir)){
      const file=path.join(dir,name);
      if(statSync(file).isDirectory())walk(file);else chunks.push(readFileSync(file));
    }
  };
  walk(fx.stage.directory);
  return Buffer.concat(chunks);
}
const sha=value=>createHash("sha256").update(value).digest("hex");

test("all four flags default off per method; identity, protocol and selectors fail closed",async()=>{
  fixture();
  for(const flag of flagNames){
    process.env[flag]="false";
    try {
      // GET needs only the generic and the notifications read flag.
      const readOn=flag===flagNames[1]||flag===flagNames[3];
      assert.equal((await getSettings()).status,readOn?200:404,"GET "+flag);
      assert.equal((await patch({})).status,404,"PATCH "+flag);
      assert.equal((await post({})).status,404,"POST "+flag);
    } finally { process.env[flag]="true"; }
  }
  assert.equal((await GET(new Request(settingsUrl))).status,401);
  assert.equal((await PATCH(new Request(settingsUrl,{method:"PATCH",body:"{}"}))).status,401);
  assert.equal((await POST(new Request(targetsUrl,{method:"POST",body:"{}"}))).status,401);
  assert.equal((await getSettings(owner(),"?actor=bob")).status,400);
  assert.equal((await getSettings(owner(),"?x=1")).status,400);
  assert.equal((await getSettings("session=forged")).status,401);
});

test("GET returns exactly the actor's own settings and live target IDs, never hashes or others",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const first=await settings();
  assert.deepEqual(first,{
    timeZone:"UTC",attentionPush:false,quietStart:first.quietStart,quietEnd:first.quietEnd,
    dailyLimit:first.dailyLimit,paused:false,expectedSettingsRevision:0,
    expectedNotificationEpoch:0,restoreGeneration:fx.stage.restoreGeneration,targets:[],
  });
  assert.match(first.quietStart,/^\d\d:\d\d$/);
  const a=await post(await registerCommand(endpoint("alice")));
  const aliceTarget=(await a.json()).targetId;
  const b=await post(await registerCommand(endpoint("bob"),bob),bob);
  const bobTarget=(await b.json()).targetId;
  const raw=await getSettings();
  const text=await raw.text();
  const body=JSON.parse(text);
  assert.deepEqual(body.targets,[aliceTarget]);
  assert.equal(body.expectedNotificationEpoch,1);
  assert.equal((await settings(bob)).targets.length,1);
  assert.deepEqual((await settings(bob)).targets,[bobTarget]);
  for(const secret of ["alice","bob",sha(endpoint("alice")),sha(endpoint("bob")),
    "synthetic-subscription-token",bobTarget])
    assert.equal(text.includes(secret),false,secret);
  assert.equal(text.includes(fx.stage.restoreGeneration),true);
  // A revoked target disappears from the list.
  assert.equal((await post(await revokeCommand(aliceTarget))).status,200);
  assert.deepEqual((await settings()).targets,[]);
});

test("PATCH happy path, replay, unchanged, stale, conflict and validation map to content-free statuses",async()=>{
  const fx=fixture();
  const c=await settingsCommand();
  const ok=await patch(c);
  const okText=await ok.text();
  assert.equal(ok.status,200,okText);
  assert.deepEqual(JSON.parse(okText),{ok:true});
  const row=read(fx,"SELECT time_zone AS z,attention_push AS p,quiet_start AS qs,quiet_end AS qe,daily_limit AS l,paused,revision FROM personal_notification_settings WHERE user_id='alice'");
  assert.deepEqual({...row},{z:"Europe/Prague",p:1,qs:"22:00",qe:"07:00",l:3,paused:0,revision:1});
  assert.equal(read(fx,"SELECT revision FROM personal_notification_epochs WHERE user_id='alice'").revision,1);
  assert.equal(read(fx,"SELECT COUNT(*) AS n FROM personal_notification_settings WHERE user_id<>'alice' AND (attention_push=1 OR revision<>0)").n,0);
  const after=await settings();
  assert.equal(after.attentionPush,true);
  assert.equal(after.expectedSettingsRevision,1);
  assert.deepEqual(await (await patch(c)).json(),{ok:true,replayed:true});
  assert.equal(read(fx,"SELECT revision FROM personal_notification_epochs WHERE user_id='alice'").revision,1);
  // Same values, new command id: unchanged -> 409.
  const same=await settingsCommand();
  const unchanged=await patch(same);
  assert.equal(unchanged.status,409);
  assert.deepEqual(await unchanged.json(),{error:"Revision conflict"});
  // Stale CAS.
  const stale=await settingsCommand(owner(),{dailyLimit:5});
  assert.equal((await patch({...stale,expectedNotificationEpoch:0})).status,409);
  assert.equal((await patch({...stale,expectedSettingsRevision:0})).status,409);
  // Idempotency conflict: same command id, different payload.
  assert.equal((await patch({...c,dailyLimit:9})).status,409);
  // Validation.
  const before=mutable(fx);
  for(const broken of [
    {...stale,dailyLimit:11},{...stale,dailyLimit:1.5},{...stale,quietStart:"24:00"},
    {...stale,timeZone:"Not/AZone"},{...stale,attentionPush:"yes"},
    {...stale,commandId:"not-a-uuid"},{...stale,expectedNotificationEpoch:-1},
    {...stale,actorUserId:"bob"},{...stale,extra:1},
  ])assert.equal((await patch(broken)).status,400,JSON.stringify(broken));
  const {paused,...missing}=stale;
  assert.equal((await patch(missing)).status,400);
  assert.equal(mutable(fx),before);
  assert.equal((await patch({...stale,restoreGeneration:randomUUID()})).status,409);
  assert.equal(mutable(fx),before);
  assert.equal((await patch(stale)).status,200);
});

test("turning push off drops the actor's baseline marker; pause keeps it",async()=>{
  const fx=fixture();
  assert.equal((await patch(await settingsCommand())).status,200);
  const key="r2:push-baseline:"+sha("alice");
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run(key,sha(JSON.stringify(["push-baseline-v1","alice"])));
  db.close();
  const marker=()=>read(fx,"SELECT COUNT(*) AS n FROM metadata WHERE key=?",key).n;
  assert.equal(marker(),1);
  assert.equal((await patch(await settingsCommand(owner(),{paused:true}))).status,200);
  assert.equal((await settings()).paused,true);
  assert.equal(marker(),1,"pause keeps the baseline");
  assert.equal((await patch(await settingsCommand(owner(),{attentionPush:false}))).status,200);
  assert.equal((await settings()).attentionPush,false);
  assert.equal(marker(),0,"disable forgets the baseline");
});

test("POST register hashes the endpoint; the raw endpoint exists nowhere; replay and re-register are idempotent",async()=>{
  const fx=fixture();
  const ep=endpoint("one");
  const c=await registerCommand(ep);
  logs.length=0;
  const res=await post(c);
  const text=await res.text();
  assert.equal(res.status,200,text);
  assert.equal(res.headers.get("cache-control"),"no-store");
  const body=JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(),["ok","targetId"]);
  assert.match(body.targetId,/^pt_[0-9a-f]{32}$/);
  const rows=all(fx,"SELECT user_id,target_id,endpoint_hash,revoked_at_ms FROM personal_push_targets");
  assert.equal(rows.length,1);
  assert.equal(rows[0].user_id,"alice");
  assert.equal(rows[0].endpoint_hash,sha(ep));
  assert.equal(rows[0].endpoint_hash,pushEndpointHash(ep));
  assert.equal(rows[0].target_id,body.targetId);
  assert.equal(text.includes(ep),false);
  assert.equal(text.includes(sha(ep)),false);
  const store=wholeStore(fx);
  assert.equal(store.includes(Buffer.from(ep)),false,"raw endpoint absent from DB, WAL and journal");
  assert.equal(store.includes(Buffer.from("synthetic-subscription-token")),false);
  assert.equal(store.includes(Buffer.from(ep).toString("base64")),false);
  assert.equal(logs.some(l=>l.includes("synthetic-subscription-token")),false);
  assert.equal(read(fx,"SELECT revision FROM personal_notification_epochs WHERE user_id='alice'").revision,1);
  // Same command: replay returns the same own ID.
  const replay=await post(c);
  assert.deepEqual(await replay.json(),{ok:true,replayed:true,targetId:body.targetId});
  assert.equal(all(fx,"SELECT 1 FROM personal_push_targets").length,1);
  // New command, same endpoint: unchanged and the same ID, no new row, no epoch move.
  const again=await post(await registerCommand(ep));
  assert.equal(again.status,200);
  assert.deepEqual(await again.json(),{ok:true,unchanged:true,targetId:body.targetId});
  assert.equal(all(fx,"SELECT 1 FROM personal_push_targets").length,1);
  assert.equal(read(fx,"SELECT revision FROM personal_notification_epochs WHERE user_id='alice'").revision,1);
  // Idempotency conflict: same command id for another endpoint.
  assert.equal((await post({...c,endpoint:endpoint("two")})).status,409);
  assert.equal(logs.some(l=>l.includes("synthetic-subscription-token")),false);
});

test("a foreign-owned endpoint is an indistinguishable 404 and transfers nothing",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const ep=endpoint("shared");
  const first=await post(await registerCommand(ep,bob),bob);
  assert.equal(first.status,200);
  const bobId=(await first.json()).targetId;
  const before=mutable(fx);
  const foreign=await post(await registerCommand(ep));
  assert.equal(foreign.status,404);
  const unknownRevoke=await post(await revokeCommand("pt_"+"0".repeat(32)));
  assert.equal(unknownRevoke.status,404);
  assert.deepEqual(await foreign.json(),await unknownRevoke.json());
  assert.equal(mutable(fx),before);
  // Bob's revoked endpoint still cannot be registered by another identity.
  assert.equal((await post(await revokeCommand(bobId,bob),bob)).status,200);
  const afterRevoke=mutable(fx);
  assert.equal((await post(await registerCommand(ep))).status,404);
  assert.equal(mutable(fx),afterRevoke);
  // Bob cannot register his own revoked endpoint again either.
  assert.equal((await post(await registerCommand(ep,bob),bob)).status,404);
});

test("revoke: own target, replay, foreign target, unknown and already revoked",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const a=(await (await post(await registerCommand(endpoint("a")))).json()).targetId;
  const b=(await (await post(await registerCommand(endpoint("b"),bob),bob)).json()).targetId;
  const before=mutable(fx);
  assert.equal((await post(await revokeCommand(b))).status,404,"alice cannot revoke bob's");
  assert.equal((await post(await revokeCommand(a,bob),bob)).status,404,"bob cannot revoke alice's");
  assert.equal((await post(await revokeCommand("pt_"+"f".repeat(32)))).status,404);
  assert.equal(mutable(fx),before);
  const rc=await revokeCommand(a);
  const res=await post(rc);
  assert.equal(res.status,200);
  assert.deepEqual(await res.json(),{ok:true});
  assert.notEqual(read(fx,"SELECT revoked_at_ms AS r FROM personal_push_targets WHERE target_id=?",a).r,null);
  assert.equal(read(fx,"SELECT revoked_at_ms AS r FROM personal_push_targets WHERE target_id=?",b).r,null);
  assert.deepEqual(await (await post(rc)).json(),{ok:true,replayed:true});
  assert.equal((await post(await revokeCommand(a))).status,404,"already revoked");
  // Stale epoch.
  const staleRevoke=await revokeCommand(b,bob);
  assert.equal((await post({...staleRevoke,expectedNotificationEpoch:0},bob)).status,409);
  assert.equal(read(fx,"SELECT revoked_at_ms AS r FROM personal_push_targets WHERE target_id=?",b).r,null);
});

test("invalid endpoints, malformed bodies, CSRF, protocol, size and query are refused without mutation",async()=>{
  const fx=fixture();
  const c=await registerCommand(endpoint("valid"));
  const before=mutable(fx);
  const longPath="https://push.example.test/"+"a".repeat(2048);
  for(const bad of [
    "http://push.example.test/x","javascript:alert(1)","ftp://push.example.test/x",
    "https://user:pass@push.example.test/x","https://user@push.example.test/x",
    "https://push.example.test/x#frag","https://push.example.test/x#",longPath,
    "","not a url","https://","HTTPS://Push.Example.Test/x","https://push.example.test",
    "https://push.example.test/a b","https://push.example.test/\u0000",
    "https://push.example.test/\\x",
    42,null,{},["https://push.example.test/x"],true,
  ])assert.equal((await post({...c,endpoint:bad})).status,400,JSON.stringify(bad)?.slice(0,60));
  assert.equal(validPushEndpoint("https://push.example.test/x?y=1"),true);
  assert.equal(validPushEndpoint("https://push.example.test/"+"a".repeat(2000)),true);
  for(const body of [
    {...c,endpointHash:sha("x")},{...c,actorUserId:"alice"},
    {...c,targetId:"pt_"+"0".repeat(32)},
    {commandId:c.commandId,action:"register",expectedNotificationEpoch:0,
      restoreGeneration:c.restoreGeneration},
    {...c,action:"other"},{...c,action:undefined},{...c,commandId:"x"},
    {...c,expectedNotificationEpoch:-1},{...c,restoreGeneration:"x"},
    {commandId:c.commandId,action:"revoke",endpoint:endpoint("x"),
      expectedNotificationEpoch:0,restoreGeneration:c.restoreGeneration},
    {commandId:c.commandId,action:"revoke",targetId:"nope",
      expectedNotificationEpoch:0,restoreGeneration:c.restoreGeneration},
    [],"[]","{not json",
  ])assert.equal((await post(body)).status,400,JSON.stringify(body)?.slice(0,80));
  assert.equal((await post(c,owner(),{origin:"https://evil.test"})).status,403);
  assert.equal((await post(c,owner(),{origin:null})).status,403);
  assert.equal((await post(c,owner(),{protocol:null})).status,400);
  assert.equal((await post(c,owner(),{query:"?x=1"})).status,400);
  assert.equal((await post({...c,commandId:"x".repeat(40*1024)})).status,413);
  assert.equal((await post({...c,restoreGeneration:randomUUID()})).status,409);
  const sc=await settingsCommand();
  assert.equal((await patch(sc,owner(),{origin:"https://evil.test"})).status,403);
  assert.equal((await patch(sc,owner(),{origin:null})).status,403);
  assert.equal((await patch(sc,owner(),{protocol:null})).status,400);
  assert.equal((await patch(sc,owner(),{query:"?x=1"})).status,400);
  assert.equal((await patch({...sc,commandId:"x".repeat(40*1024)})).status,413);
  assert.equal((await patch("{not json")).status,400);
  assert.equal(mutable(fx),before,"no refusal mutates anything");
  assert.equal(wholeStore(fx).includes(Buffer.from("push.example.test")),false);
  assert.equal(logs.some(l=>l.includes("push.example.test")),false);
});

test("revoked durable session: nothing is written and every method answers 401",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const s=await settingsCommand(bob);
  const t=await registerCommand(endpoint("bob-session"),bob);
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  const before=mutable(fx);
  assert.equal((await patch(s,bob)).status,401);
  assert.equal((await post(t,bob)).status,401);
  assert.equal((await getSettings(bob)).status,401);
  assert.equal(mutable(fx),before);
  assert.equal(all(fx,"SELECT 1 FROM personal_push_targets").length,0);
});

test("live guard: a settings or target write after the snapshot makes the release stale; another actor does not",async()=>{
  const fx=fixture(),bob=login(fx,"bob");
  const config={...fx.store,ownerUserId:"alice"};
  const request=new Request(settingsUrl,{headers:{cookie:owner()}});
  const identity={kind:"owner"};
  const snapshot=await readStagingNotificationSettingsInChild(config);
  assert.equal(snapshot?.ok,true,JSON.stringify(snapshot));
  const live=()=>verifyNotificationSettingsLive(request,identity,config,
    snapshot.settings.actorUserId,snapshot.settings.notificationEpoch);
  assert.equal(live(),"ok");
  assert.equal((await patch(await settingsCommand(bob),bob)).status,200);
  assert.equal((await post(await registerCommand(endpoint("bob-live"),bob),bob)).status,200);
  assert.equal(live(),"ok","bob's writes do not move alice's epoch");
  assert.equal((await patch(await settingsCommand())).status,200);
  assert.equal(live(),"stale");
  const second=await readStagingNotificationSettingsInChild(config);
  const liveSecond=()=>verifyNotificationSettingsLive(request,identity,config,
    second.settings.actorUserId,second.settings.notificationEpoch);
  assert.equal(liveSecond(),"ok");
  assert.equal((await post(await registerCommand(endpoint("alice-live")))).status,200);
  assert.equal(liveSecond(),"stale");
  assert.equal((await getSettings()).status,200,"a fresh GET reads the new epoch");
});

test("route answers read_stale_reload (409) when the epoch moves between child read and release",async()=>{
  fixture();
  // A raced writer: commit a change while the GET child is running.
  const racing=getSettings();
  const c=await settingsCommand();
  const [read1,write]=await Promise.all([racing,patch(c)]);
  assert.ok([200,409].includes(read1.status),String(read1.status));
  assert.equal(write.status,200);
  if(read1.status===409)
    assert.deepEqual(await read1.json(),{error:"read_stale_reload"});
  assert.equal((await settings()).expectedNotificationEpoch,1);
});

test("child and DTO parsers reject injected data and invalid shapes",async()=>{
  const fx=fixture();
  const config={...fx.store,ownerUserId:"alice"};
  const sample=await readStagingNotificationSettingsInChild(config);
  assert.equal(sample?.ok,true,JSON.stringify(sample));
  assert.equal(sample.settings.actorUserId,"alice");
  const base={ok:true,actorUserId:"alice",timeZone:"UTC",attentionPush:false,
    quietStart:"22:00",quietEnd:"07:00",dailyLimit:3,paused:false,
    settingsRevision:0,notificationEpoch:0,targetIds:["pt_"+"a".repeat(32)]};
  assert.equal(parseStagingNotificationSettings(base)?.ok,true);
  assert.deepEqual(parseStagingNotificationSettings({ok:false,reason:"inaccessible"}),
    {ok:false,reason:"inaccessible"});
  for(const broken of [
    {...base,endpointHash:"a".repeat(64)},{...base,dailyLimit:11},{...base,timeZone:"x/y"},
    {...base,quietStart:"7:00"},{...base,notificationEpoch:-1},{...base,paused:1},
    {...base,targetIds:["not-an-id"]},
    {...base,targetIds:["pt_"+"a".repeat(32),"pt_"+"a".repeat(32)]},
    {...base,actorUserId:"a b"},
    {ok:false,reason:"other"},[],null,"x",
  ])assert.equal(parseStagingNotificationSettings(broken),null);
  assert.deepEqual(parseNotificationSettingsWriteReply({ok:true}),{ok:true});
  assert.deepEqual(parseNotificationSettingsWriteReply({ok:false,reason:"unchanged"}),
    {ok:false,reason:"unchanged"});
  assert.equal(parseNotificationSettingsWriteReply({ok:false,reason:"unauthorized"}),null);
  assert.equal(parseNotificationSettingsWriteReply({ok:true,actor:"a"}),null);
  const id="pt_"+"b".repeat(32);
  assert.deepEqual(parseNotificationTargetWriteReply({ok:true,targetId:id}),{ok:true,targetId:id});
  assert.deepEqual(parseNotificationTargetWriteReply({ok:false,reason:"unchanged",targetId:id}),
    {ok:false,reason:"unchanged",targetId:id});
  assert.equal(parseNotificationTargetWriteReply({ok:false,reason:"unchanged"}),null);
  assert.equal(parseNotificationTargetWriteReply({ok:true,targetId:"x"}),null);
  assert.equal(parseNotificationTargetWriteReply({ok:true,targetId:id,endpointHash:"a"}),null);
});

test("restore fence lists the new mutating routes and the legacy sentinel stays untouched",()=>{
  const source=readFileSync(new URL("./restore-fence.test.mjs",import.meta.url),"utf8");
  assert.match(source,/"PATCH \/api\/target-staging\/notifications\/settings"/);
  assert.match(source,/"POST \/api\/target-staging\/notifications\/targets"/);
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
});

test("rate limits answer 429 with retry-after before any write",async()=>{
  const fx=fixture();
  const ip="10.99.0.1";
  const c=await settingsCommand();
  const before=mutable(fx);
  let last;
  for(let i=0;i<31;i++)last=await patch({...c,dailyLimit:11},owner(),{ip});
  assert.equal(last.status,429);
  assert.ok(Number(last.headers.get("retry-after"))>0);
  let limited;
  for(let i=0;i<61;i++)limited=await getSettings(owner(),"",{ip:"10.99.0.2"});
  assert.equal(limited.status,429);
  assert.equal(mutable(fx),before);
});

test("spoofed X-Forwarded-For prefixes cannot escape the per-client PATCH limit",async()=>{
  const fx=fixture();
  const c=await settingsCommand();
  const before=mutable(fx);
  const statuses=[];
  for(let i=0;i<40;i++){
    statuses.push((await patch({...c,dailyLimit:11},owner(),
      {ip:"198.18.7."+i+", 10.99.0.3"})).status);
  }
  assert.ok(statuses.slice(30).every(s=>s===429),statuses.join(","));
  assert.equal(statuses.filter(s=>s===429).length,10);
  // A different proxied client is still served independently.
  assert.notEqual((await getSettings(owner(),"",{ip:"10.99.0.4"})).status,429);
  assert.equal(mutable(fx),before);
});
