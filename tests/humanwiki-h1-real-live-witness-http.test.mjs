import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createSessionToken, sessionCookieName } from "./support/owner-session-test-cookie.mjs";
import { bootstrapIsolatedTargetStore } from "../lib/target-store-bootstrap.ts";
import {
  bootstrapHumanWikiConsentPrivateLedger, withHumanWikiConsentPrivateLedger,
} from "../lib/humanwiki-consent-private-store.mjs";
import {
  appendHumanWikiConsentIntent, humanWikiConsentIntentLocalHead,
} from "../lib/humanwiki-consent-intents.mjs";
import {
  humanWikiWitnessChallengePayload, HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA,
} from "../lib/humanwiki-consent-witness-preflight.mjs";
import {
  HUMANWIKI_WITNESS_CHALLENGE_PATH,
  humanWikiWitnessHttpsOrigin,
  createHumanWikiWitnessHttpsReceiptProvider,
} from "../lib/humanwiki-witness-https-client.mjs";
import { GET } from "../app/api/humanwiki/witness-preflight/route.ts";
import { POST as importPost } from "../app/api/humanwiki/import/route.ts";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-real-witness-http-"));
const stage=bootstrapIsolatedTargetStore({
  stagingDirectory:path.join(root,"stage"),ownerUserId:"owner-test",
});
const directory=mkdtempSync(path.join(root,"private-ledger-"));
bootstrapHumanWikiConsentPrivateLedger(directory);
const key=Buffer.alloc(32,0x41);
const {publicKey,privateKey}=generateKeyPairSync("ed25519");
const {publicKey:otherKey,privateKey:otherPrivate}=generateKeyPairSync("ed25519");
const registryId=randomUUID();
const remoteOrigin="https://witness.example.org";
const hmacEncoded=key.toString("base64url");
const pubEncoded=publicKey.export({format:"der",type:"spki"}).toString("base64url");
const sessionSecret="humanwiki-witness-owner-cookie-strong-secret-32chars";
const passwordHash="scrypt:"+Buffer.alloc(16,2).toString("base64url")+
  ":"+Buffer.alloc(64,3).toString("base64url");
const envNames=[
  "NODE_ENV","AI_EXECUTIVE_AUTH_ENABLED","AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET","AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID","AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID",
  "AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY",
  "AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY",
  "AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTP_PREFLIGHT_ENABLED",
  "AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID",
  "AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN",
  "AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL",
  "AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED",
];
const saved=new Map(envNames.map(k=>[k,process.env[k]]));
const nativeFetch=globalThis.fetch;
after(()=>{
  globalThis.fetch=nativeFetch;
  for(const [k,v] of saved){
    if(v===undefined)delete process.env[k];
    else process.env[k]=v;
  }
  rmSync(root,{recursive:true,force:true});
});
let sourceIp=20;
const config=()=>{
  sourceIp++;
  process.env.NODE_ENV="production";
  process.env.AI_EXECUTIVE_AUTH_ENABLED="true";
  process.env.AI_EXECUTIVE_PASSWORD_HASH=passwordHash;
  process.env.AI_EXECUTIVE_SESSION_SECRET=sessionSecret;
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID=stage.ownerUserId;
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID=stage.unassignedAreaId;
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY=directory;
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY=hmacEncoded;
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTP_PREFLIGHT_ENABLED="true";
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_REGISTRY_ID=registryId;
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN=remoteOrigin;
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL=pubEncoded;
  delete process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED;
};
const endpoint="https://lumi.invalid/api/humanwiki/witness-preflight";
const request=(token,uri=endpoint)=>new Request(uri,{headers:{
  ...(token?{cookie:sessionCookieName+"="+token}:{}),
  "x-forwarded-for":"198.51.100."+sourceIp,
}});
const blocked=async r=>{
  assert.equal(r.status,404);
  assert.deepEqual(await r.json(),{error:"Not found"});
  assert.equal(r.headers.get("cache-control"),"no-store");
  assert.equal(r.headers.get("set-cookie"),null);
};
const head=()=>withHumanWikiConsentPrivateLedger(directory,"read",db=>{
  const h=humanWikiConsentIntentLocalHead(db,key);
  assert.equal(h.ok,true);
  return {sequence:h.sequence,digest:h.digest};
});
const receipt=(identity,nonce,checkpoint,signer=privateKey)=>({
  version:HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA,registryId:identity,nonce,
  sequence:checkpoint.sequence,digest:checkpoint.digest,
  signature:sign(null,humanWikiWitnessChallengePayload(
    identity,nonce,checkpoint.sequence,checkpoint.digest),
  signer).toString("base64url"),
});
const remote=(checkpoint,overrides={})=>{
  const seen=[];
  globalThis.fetch=async(url,options)=>{
    seen.push({url,options});
    assert.equal(url,remoteOrigin+HUMANWIKI_WITNESS_CHALLENGE_PATH);
    assert.equal(options.method,"POST");
    assert.equal(options.redirect,"error");
    assert.equal(options.credentials,"omit");
    assert.equal(options.cache,"no-store");
    assert.equal(options.referrerPolicy,"no-referrer");
    assert.equal(options.headers["content-type"],"application/json");
    assert.deepEqual(Object.keys(options.headers).sort(),["accept","content-type"]);
    assert.ok(options.signal instanceof AbortSignal);
    const params=JSON.parse(options.body);
    assert.deepEqual(Object.keys(params).sort(),["nonce","registryId"]);
    assert.equal(params.registryId,registryId);
    assert.match(params.nonce,/^[A-Za-z0-9_-]{43}$/);
    if(overrides.throw)throw Error("unavailable");
    const body=overrides.reply?.(params)??receipt(params.registryId,params.nonce,checkpoint,
      overrides.signer??privateKey);
    return new Response(JSON.stringify(body),{
      status:overrides.status??200,
      headers:{"content-type":overrides.contentType??"application/json"},
    });
  };
  return seen;
};

test("real owner-only HTTP handler checks a signed remote checkpoint, never grants import",async()=>{
  config();
  const checkpoint=head();
  const calls=remote(checkpoint);
  const token=createSessionToken();
  const result=await GET(request(token));
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{
    result:"remote_signed_high_water_matches_for_preflight_only",
    importAuthorized:false,independentWitnessVerified:false,
    withdrawalComplete:false,consentVerified:false,
    realImportEnabled:false,claimsCreated:0,
  });
  assert.equal(calls.length,1);
  assert.equal(result.headers.get("cache-control"),"no-store");
  for(const value of [stage.ownerUserId,stage.unassignedAreaId,directory,
    registryId,checkpoint.digest,sessionSecret]){
    assert.equal(JSON.stringify(await (await GET(request(token))).json()).includes(value),
      false);
  }
  process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED="true";
  const data="never parse this private export";
  const upload=new Request("https://lumi.invalid/api/humanwiki/import",{
    method:"POST",headers:{"content-type":"application/json"},
    body:data,
  });
  await blocked(await importPost(upload));
  assert.equal(upload.bodyUsed,false);
  assert.equal(await upload.text(),data);
  config();
});

test("remote stale checkpoint, wrong signature and malformed receipt all fail closed",async()=>{
  config();
  const token=createSessionToken();
  const old=head();
  withHumanWikiConsentPrivateLedger(directory,"write",db=>{
    const r=appendHumanWikiConsentIntent(db,key,{
      ownerUserId:stage.ownerUserId,privateAreaId:stage.unassignedAreaId,
    },{
      commandId:randomUUID(),sourceType:"chatgpt_user_export",
      decision:"withdrawal_requested",purpose:"humanwiki_context_bootstrap",
      retentionDays:null,expectedRevision:0,explicitConfirmation:true,
    });
    assert.equal(r.ok,true);
  });
  const current=head();
  remote(old);
  await blocked(await GET(request(token)));
  remote(current,{signer:otherPrivate});
  await blocked(await GET(request(token)));
  remote(current,{reply:({registryId,nonce})=>({
    ...receipt(registryId,nonce,current),extra:true,
  })});
  await blocked(await GET(request(token)));
  remote(current,{reply:({registryId,nonce})=>
    receipt(registryId,nonce,{sequence:current.sequence+1,digest:current.digest})});
  await blocked(await GET(request(token)));
  remote(current,{throw:true});
  await blocked(await GET(request(token)));
  remote(current);
  assert.equal((await GET(request(token))).status,200);
});

test("missing auth, wrong owner/Area, flags or pins prevent remote I/O",async()=>{
  config();
  const token=createSessionToken();
  let fetchCalls=0;
  globalThis.fetch=async()=>{fetchCalls++;throw Error("should not fetch");};
  for(const invalid of [undefined,"forged",createSessionToken(-1),token+".wrong"]){
    await blocked(await GET(request(invalid)));
  }
  delete process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTP_PREFLIGHT_ENABLED;
  await blocked(await GET(request(token)));
  config();
  process.env.NODE_ENV="test";
  process.env.AI_EXECUTIVE_AUTH_ENABLED="false";
  await blocked(await GET(request(token)));
  config();
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID="shared:family";
  await blocked(await GET(request(token)));
  config();
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID="other-owner";
  await blocked(await GET(request(token)));
  config();
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL=
    otherKey.export({format:"der",type:"spki"}).toString("base64url");
  // Pin is well-formed but wrong signer; calls can happen only with an owner.
  // Below malformed pin must be rejected before any network I/O.
  process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_PUBLIC_KEY_SPKI_B64URL="wrong";
  await blocked(await GET(request(token)));
  config();
  await blocked(await GET(request(token,endpoint+"?registryId="+registryId)));
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY="wrong";
  await blocked(await GET(request(token)));
  config();
  assert.equal(fetchCalls,0);
});

test("HTTPS endpoint is strictly server-pinned and denies unsafe origins",async()=>{
  const bad=[
    "http://witness.example.org","https://127.0.0.1",
    "https://localhost","https://127.0.0.1:443","https://witness.internal",
    "https://witness.local","https://witness.example.org/path",
    "https://witness.example.org?secret=1",
    "https://user:password@witness.example.org",
    "https://witness.example.org/","https://witness.example.org:8443",
    "https://witness.example.org#fragment",
  ];
  assert.equal(humanWikiWitnessHttpsOrigin(remoteOrigin),remoteOrigin);
  for(const origin of bad){
    assert.equal(humanWikiWitnessHttpsOrigin(origin),null,origin);
    assert.throws(()=>createHumanWikiWitnessHttpsReceiptProvider(origin),/unavailable/);
  }
  config();
  const token=createSessionToken();
  let fetched=0;
  globalThis.fetch=async()=>{fetched++;throw Error("unavailable");};
  for(const origin of bad){
    process.env.AI_EXECUTIVE_HUMANWIKI_WITNESS_HTTPS_ORIGIN=origin;
    await blocked(await GET(request(token)));
  }
  assert.equal(fetched,0);
});

test("external reply is size bounded, strict JSON and never follows redirects",async()=>{
  const signal=new AbortController().signal;
  const get=body=>createHumanWikiWitnessHttpsReceiptProvider(remoteOrigin,
    async()=>new Response(body,{status:200,headers:{"content-type":"application/json"}}));
  await assert.rejects(()=>get("x".repeat(1025))({
    registryId,nonce:"A".repeat(43),signal,
  }),/unavailable/);
  await assert.rejects(()=>get("{broken")({
    registryId,nonce:"A".repeat(43),signal,
  }));
  const wrongType=createHumanWikiWitnessHttpsReceiptProvider(remoteOrigin,
    async()=>new Response("{}",{status:200,headers:{"content-type":"text/plain"}}));
  await assert.rejects(()=>wrongType({registryId,nonce:"A".repeat(43),signal}));
  const redirect=createHumanWikiWitnessHttpsReceiptProvider(remoteOrigin,
    async()=>new Response("",{status:302,headers:{
      "content-type":"application/json",location:"http://127.0.0.1/"}}));
  await assert.rejects(()=>redirect({registryId,nonce:"A".repeat(43),signal}));
});

test("remote HTTPS client observes the verifier's abortable deadline",async()=>{
  config();
  const token=createSessionToken();
  let aborted=false;
  globalThis.fetch=async(_url,{signal})=>new Promise((_,reject)=>{
    signal.addEventListener("abort",()=>{
      aborted=true;
      reject(signal.reason);
    },{once:true});
  });
  await blocked(await GET(request(token)));
  assert.equal(aborted,true);
});
