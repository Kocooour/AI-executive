import assert from "node:assert/strict";
import {createHmac,createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const flagNames=[
  "AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED","AI_EXECUTIVE_TARGET_UI_ENABLED",
];
const vars=["NODE_ENV","AI_EXECUTIVE_DATA_DIR","AI_EXECUTIVE_AUTH_ENABLED",
  "AI_EXECUTIVE_PASSWORD_HASH","AI_EXECUTIVE_SESSION_SECRET",
  ...flagNames,"AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID"];
const old=Object.fromEntries(vars.map(k=>[k,process.env[k]]));
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r3fe1-session-generation-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const SECRET="synthetic-session-generation-secret-32+";
Object.assign(process.env,{
  NODE_ENV:"production",AI_EXECUTIVE_DATA_DIR:legacy,AI_EXECUTIVE_AUTH_ENABLED:"true",
  AI_EXECUTIVE_PASSWORD_HASH:"scrypt:"+Buffer.alloc(16,1).toString("base64url")+
    ":"+Buffer.alloc(64,2).toString("base64url"),
  AI_EXECUTIVE_SESSION_SECRET:SECRET,
  ...Object.fromEntries(flagNames.map(k=>[k,"true"])),
});
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const durable=await import("../lib/target-staging-durable-session.ts");
const {createSessionToken,sessionCookieName}=await import("./support/owner-session-test-cookie.mjs");
const {GET}=await import("../app/api/target-staging/session/route.ts");
const {targetUiEnabled}=await import("../lib/target-staging-session-generation.ts");

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
let ipCounter=0;
const nextIp=()=>{ipCounter++;return "10.77."+(ipCounter>>8&255)+"."+(ipCounter&255);};
const url="http://localhost:3001/api/target-staging/session";
const ownerCookie=(maxAge)=>sessionCookieName+"="+createSessionToken(maxAge);
const call=(cookie,options={})=>GET(new Request(url+(options.query??""),{
  headers:{...(cookie?{cookie}:{}),"x-forwarded-for":options.ip??nextIp()}}));
function login(fx,who){
  const issued=durable.issueDurableTargetStagingSession(fx.store,who,900);
  assert.equal(issued.ok,true,JSON.stringify(issued));
  return {cookie:durable.TARGET_STAGING_SESSION_COOKIE+"="+issued.sessionToken,
    token:issued.sessionToken,sessionId:issued.sessionId};
}
async function generation(cookie,options){
  const response=await call(cookie,options);
  const text=await response.text();
  assert.equal(response.status,200,text);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const body=JSON.parse(text);
  assert.deepEqual(Object.keys(body),["generation"]);
  assert.match(body.generation,/^[A-Za-z0-9_-]{43}$/);
  return {value:body.generation,text};
}

test("default-off: either missing flag answers 404 before any identity or store work",async()=>{
  const fx=fixture();
  for(const flag of flagNames){
    process.env[flag]="false";
    assert.equal(targetUiEnabled(),false);
    const response=await call(ownerCookie());
    assert.equal(response.status,404);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.equal((await call(undefined)).status,404);
    process.env[flag]="true";
    delete process.env[flag];
    assert.equal((await call(ownerCookie())).status,404);
    process.env[flag]="true";
  }
  assert.equal(targetUiEnabled(),true);
  assert.equal((await call(ownerCookie())).status,200);
  void fx;
});

test("unauthenticated, malformed, unknown and revoked credentials answer 401 without a generation",async()=>{
  const fx=fixture();
  const none=await call(undefined);
  assert.equal(none.status,401);
  assert.equal(none.headers.get("cache-control"),"no-store");
  assert.equal("generation" in await none.json(),false);
  assert.equal((await call(sessionCookieName+"=forged.value")).status,401);
  const malformed=await call(durable.TARGET_STAGING_SESSION_COOKIE+"=nope");
  assert.equal(malformed.status,401);
  assert.equal((await malformed.json()).code,"session_revoked");
  const unknown=await call(durable.TARGET_STAGING_SESSION_COOKIE+"="+"A".repeat(43));
  assert.equal(unknown.status,401);
  const bob=login(fx,"bob");
  assert.equal((await call(bob.cookie)).status,200);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store,bob.sessionId).ok,true);
  const revoked=await call(bob.cookie);
  assert.equal(revoked.status,401);
  const body=await revoked.json();
  assert.equal(body.code,"session_revoked");
  assert.equal("generation" in body,false);
  // A live session cookie never falls back to the owner cookie.
  assert.equal((await call(bob.cookie+"; "+ownerCookie())).status,401);
});

test("owner and durable-session generations differ; one identity is stable across requests",async()=>{
  const fx=fixture();
  const owner=ownerCookie();
  const bob=login(fx,"bob"),carol=login(fx,"carol"),bob2=login(fx,"bob");
  const a1=await generation(owner),a2=await generation(owner);
  assert.equal(a1.value,a2.value);
  const b1=await generation(bob.cookie),b2=await generation(bob.cookie);
  assert.equal(b1.value,b2.value);
  const all=[a1.value,b1.value,(await generation(carol.cookie)).value,
    (await generation(bob2.cookie)).value];
  assert.equal(new Set(all).size,4);
  // A different owner sign-in (new cookie) is a different generation.
  assert.notEqual((await generation(ownerCookie(60*60))).value,a1.value);
});

test("generation is HMAC(secret, binding, live epoch) and never reveals actor, token or cookie",async()=>{
  const fx=fixture();
  const bob=login(fx,"bob");
  const owner=ownerCookie();
  const expected=(binding,epoch)=>createHmac("sha256",SECRET)
    .update("lumi:r3:auth-generation:v1\0"+binding+"\0"+epoch).digest("base64url");
  const tokenHash=createHash("sha256").update(bob.token,"utf8").digest("hex");
  const session=await generation(bob.cookie);
  assert.equal(session.value,expected("session:"+tokenHash,0));
  const ownerToken=owner.slice(sessionCookieName.length+1);
  const ownerValue=await generation(owner);
  assert.equal(ownerValue.value,expected("owner:"+
    createHash("sha256").update(ownerToken).digest("base64url"),0));
  for(const {text} of [session,ownerValue]){
    for(const secret of [bob.token,tokenHash,bob.sessionId,"alice","bob","carol",
      ownerToken,owner,bob.cookie,SECRET,fx.stage.restoreGeneration,"epoch"]){
      assert.equal(text.includes(secret),false,secret);
    }
  }
  assert.equal(logs.some(line=>line.includes(bob.token)||line.includes(ownerToken)),false);
});

test("generation changes on sign-out-everywhere, session revocation and new sessions",async()=>{
  const fx=fixture();
  const owner=ownerCookie();
  const bob=login(fx,"bob");
  const ownerBefore=(await generation(owner)).value;
  const bobBefore=(await generation(bob.cookie)).value;
  // Revoking bob's sessions moves only bob's epoch.
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"bob").ok,true);
  assert.equal((await call(bob.cookie)).status,401);
  assert.equal((await generation(owner)).value,ownerBefore);
  const bob2=login(fx,"bob");
  const bobAfter=(await generation(bob2.cookie)).value;
  assert.notEqual(bobAfter,bobBefore);
  assert.equal((await generation(bob2.cookie)).value,bobAfter);
  // The owner identity's own epoch is read live: the same cookie, a new value.
  assert.equal(durable.revokeAllDurableTargetStagingSessionsForUser(fx.store,"alice").ok,true);
  const ownerAfter=(await generation(owner)).value;
  assert.notEqual(ownerAfter,ownerBefore);
  assert.equal((await generation(owner)).value,ownerAfter);
});

test("query strings are refused, the limiter answers 429, and misconfiguration is 503",async()=>{
  const fx=fixture();
  const owner=ownerCookie();
  assert.equal((await call(owner,{query:"?x=1"})).status,400);
  assert.equal((await call(owner,{query:"?"})).status,400,"a bare ? is a query too");
  const ip="10.99.0.1";
  let limited=null;
  for(let i=0;i<130&&!limited;i++){
    const response=await call(owner,{ip});
    if(response.status===429)limited=response;
  }
  assert.ok(limited,"expected a 429");
  assert.equal(limited.headers.get("cache-control"),"no-store");
  assert.ok(Number(limited.headers.get("retry-after"))>0);
  const saved=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  delete process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
  const missing=await call(owner);
  assert.equal(missing.status,503);
  assert.equal(missing.headers.get("cache-control"),"no-store");
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID=saved;
  const savedDir=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY="relative/path";
  assert.equal((await call(owner)).status,503);
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=savedDir;
  void fx;
});

test("the route is read-only: the legacy data directory and staging store are untouched",async()=>{
  const fx=fixture();
  const bob=login(fx,"bob");
  const db=()=>{
    const handle=new DatabaseSync(fx.stage.databasePath,{readOnly:true});
    try{
      return JSON.stringify([
        handle.prepare("SELECT id,revocation_epoch FROM identities ORDER BY id").all(),
        handle.prepare("SELECT token_hash,revoked_at_ms FROM staging_sessions ORDER BY id").all(),
      ]);
    }finally{handle.close();}
  };
  const before=db();
  for(let i=0;i<5;i++)await generation(bob.cookie);
  await generation(ownerCookie());
  assert.equal(db(),before);
});
