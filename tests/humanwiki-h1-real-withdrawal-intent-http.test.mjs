import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createSessionToken, sessionCookieName } from "../lib/auth.ts";
import { bootstrapIsolatedTargetStore } from "../lib/target-store-bootstrap.ts";
import { GET, POST } from "../app/api/humanwiki/withdrawal-intent/route.ts";
import { POST as importPost } from "../app/api/humanwiki/import/route.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-h1-real4-withdrawal-"));
const store = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "isolated-stage"), ownerUserId: "owner-alice",
});
const ledger = mkdtempSync(path.join(root, "intent-ledger-"));
const ledgerFilename = path.join(ledger, "humanwiki-consent-intents.sqlite");
const KEY = Buffer.alloc(32, 0x45).toString("base64url");
const sessionSecret = "H1-real4-test-session-key-32-characters-only";
const hash = "scrypt:" + Buffer.alloc(16, 3).toString("base64url") +
  ":" + Buffer.alloc(64, 9).toString("base64url");
const envNames = [
  "NODE_ENV", "AI_EXECUTIVE_AUTH_ENABLED", "AI_EXECUTIVE_PASSWORD_HASH",
  "AI_EXECUTIVE_SESSION_SECRET", "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID",
  "AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED",
  "AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY",
  "AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY",
  "AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED",
];
const savedEnv = new Map(envNames.map(k=>[k,process.env[k]]));
after(() => {
  for(const [k,v] of savedEnv) {
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  rmSync(root,{recursive:true,force:true});
});
const endpoint = "https://lumi.invalid/api/humanwiki/withdrawal-intent";
const allowedOrigin = "https://lumi.invalid";
const config = () => {
  process.env.NODE_ENV="production";
  process.env.AI_EXECUTIVE_AUTH_ENABLED="true";
  process.env.AI_EXECUTIVE_PASSWORD_HASH=hash;
  process.env.AI_EXECUTIVE_SESSION_SECRET=sessionSecret;
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=store.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID=store.ownerUserId;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=store.restoreGeneration;
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID=store.unassignedAreaId;
  process.env.AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED="true";
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY=ledger;
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY=KEY;
  delete process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED;
};
const command = (extra={}) => ({
  commandId:randomUUID(), decision:"withdrawal_requested",
  sourceType:"chatgpt_user_export", purpose:"humanwiki_context_bootstrap",
  retentionDays:null, expectedRevision:0, explicitConfirmation:true, ...extra,
});
const ownerRequest = (method, token, data, headers={}) =>
  new Request(endpoint,{method,headers:{
    ...(token?{cookie:sessionCookieName+"="+token}:{}),
    ...(method==="POST"?{"content-type":"application/json",origin:allowedOrigin}:{}),
    ...headers,
  },...(method==="POST"?{body:typeof data==="string"?data:JSON.stringify(data)}:{})});
const failure = async response=>{
  assert.equal(response.status,404);
  assert.deepEqual(await response.json(),{error:"Not found"});
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(response.headers.get("set-cookie"),null);
};

test("owner-private withdrawal request persists, is source-specific and never authorizes import",async()=>{
  config();
  const token=createSessionToken();
  await failure(await GET(ownerRequest("GET",token)));
  const request=command();
  const response=await POST(ownerRequest("POST",token,request));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{
    result:"withdrawal_intent_recorded_not_completed",
    replayed:false,revision:1,importAuthorized:false,
    consentVerified:false,withdrawalComplete:false,independentWitnessVerified:false,
  });
  assert.equal(lstatSync(ledgerFilename).mode & 0o177,0);
  const status=await GET(ownerRequest("GET",token));
  assert.equal(status.status,200);
  assert.deepEqual(await status.json(),{
    result:"owner_private_source_intent_revisions_only",
    sourceRevisions:{chatgpt_user_export:1,claude_user_export:0},
    importAuthorized:false,consentVerified:false,
    withdrawalComplete:false,independentWitnessVerified:false,
  });
  const retry=await POST(ownerRequest("POST",token,request));
  assert.equal((await retry.json()).replayed,true);
  assert.equal((await GET(ownerRequest("GET",token))).status,200);
  const claude=await POST(ownerRequest("POST",token,command({sourceType:"claude_user_export"})));
  assert.equal(claude.status,200);
  assert.equal((await claude.json()).revision,1);
  assert.equal((await (await GET(ownerRequest("GET",token))).json()).sourceRevisions.chatgpt_user_export,1);
  process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED="true";
  const upload=new Request("https://lumi.invalid/api/humanwiki/import",{
    method:"POST",headers:{"content-type":"application/json",
    cookie:sessionCookieName+"="+token},body:"private user export bytes",
  });
  await failure(await importPost(upload));
  assert.equal(upload.bodyUsed,false);
});

test("all grants, non-metadata fields, forged area, invalid CAS and CSRF are refused",async()=>{
  config();
  const token=createSessionToken();
  for(const payload of [
    command({decision:"grant_requested",retentionDays:90,expectedRevision:1}),
    command({sourceType:"gmail"}),
    command({sourceType:"claude_user_export",conversationText:"private content"}),
    command({ownerUserId:"other-user"}),
    command({retentionDays:90}),
    command({expectedRevision:500}),
  ])await failure(await POST(ownerRequest("POST",token,payload)));
  await failure(await POST(ownerRequest("POST",token,command(),{origin:"https://evil.invalid"})));
  await failure(await POST(ownerRequest("POST",token,command(),{"content-type":"text/plain"})));
  await failure(await POST(ownerRequest("POST",token,"{broken json")));
  await failure(await POST(ownerRequest("POST",token,"x".repeat(2000))));
  assert.equal((await (await GET(ownerRequest("GET",token))).json()).sourceRevisions.chatgpt_user_export,1);
});

test("auth, flags, owner/Area and key are mandatory before any body or ledger access",async()=>{
  config();
  const token=createSessionToken();
  for(const invalid of [undefined,"forged",createSessionToken(-1),token+".tampered"]){
    const request=ownerRequest("POST",invalid,command());
    await failure(await POST(request));
    assert.equal(request.bodyUsed,false);
  }
  for(const flag of [undefined,"false","1","TRUE"]){
    if(flag===undefined)delete process.env.AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED;
    else process.env.AI_EXECUTIVE_HUMANWIKI_WITHDRAWAL_INTENT_HTTP_ENABLED=flag;
    const request=ownerRequest("POST",token,command());
    await failure(await POST(request));
    assert.equal(request.bodyUsed,false);
  }
  config();
  process.env.NODE_ENV="test";
  process.env.AI_EXECUTIVE_AUTH_ENABLED="false";
  await failure(await POST(ownerRequest("POST",token,command())));
  config();
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID="attacker";
  await failure(await POST(ownerRequest("POST",token,command())));
  config();
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID="shared:family";
  await failure(await POST(ownerRequest("POST",token,command())));
  config();
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=randomUUID();
  await failure(await POST(ownerRequest("POST",token,command())));
  config();
  delete process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY;
  await failure(await GET(ownerRequest("GET",token)));
  await failure(await POST(ownerRequest("POST",token,command())));
  config();
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_HMAC_KEY=Buffer.alloc(32,7).toString("base64url");
  await failure(await GET(ownerRequest("GET",token)));
  config();
});

test("owner-only GET rejects queries, and ledger symlinks or loose filesystem modes fail closed",async()=>{
  config();
  const token=createSessionToken();
  await failure(await GET(new Request(endpoint+"?owner=someone",{
    headers:{cookie:sessionCookieName+"="+token},
  })));
  const forbidden=mkdtempSync(path.join(root,"insecure-"));
  chmodSync(forbidden,0o755);
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY=forbidden;
  await failure(await POST(ownerRequest("POST",token,command({expectedRevision:1}))));
  config();
  const isolated=mkdtempSync(path.join(root,"symlink-"));
  const target=path.join(root,"external.sqlite");
  writeFileSync(target,"not a SQLite ledger",{mode:0o600});
  symlinkSync(target,path.join(isolated,"humanwiki-consent-intents.sqlite"));
  process.env.AI_EXECUTIVE_HUMANWIKI_CONSENT_LEDGER_DIRECTORY=isolated;
  await failure(await POST(ownerRequest("POST",token,command({expectedRevision:1}))));
  config();
});
