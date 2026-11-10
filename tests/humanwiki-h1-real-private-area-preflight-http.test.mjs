import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { createSessionToken, sessionCookieName } from "../lib/auth.ts";
import { bootstrapIsolatedTargetStore } from "../lib/target-store-bootstrap.ts";
import { verifyHumanWikiOwnerPrivateAreaLive } from "../lib/target-staging-durable-session.ts";
import { GET } from "../app/api/humanwiki/private-area-preflight/route.ts";
import { POST } from "../app/api/humanwiki/import/route.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "lumi-h1-real-private-live-"));
const legacy = path.join(root, "legacy");
mkdirSync(legacy);
writeFileSync(path.join(legacy, "untouched-sentinel"), "do not read or change");
const env = [
  "NODE_ENV", "AI_EXECUTIVE_AUTH_ENABLED", "AI_EXECUTIVE_DATA_DIR",
  "AI_EXECUTIVE_PASSWORD_HASH", "AI_EXECUTIVE_SESSION_SECRET",
  "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY",
  "AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION",
  "AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID",
  "AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID",
  "AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_PREFLIGHT_ENABLED",
  "AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED",
];
const original = env.map(key => process.env[key]);
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
const store = bootstrapIsolatedTargetStore({
  stagingDirectory: path.join(root, "stage"), ownerUserId: "owner-alice",
});
after(() => {
  env.forEach((key, i) => {
    if (original[i] === undefined) delete process.env[key];
    else process.env[key] = original[i];
  });
  rmSync(root, { recursive: true, force: true });
});

const passwordHash = "scrypt:" + Buffer.alloc(16, 3).toString("base64url") +
  ":" + Buffer.alloc(64, 9).toString("base64url");
const secret = "H1-real-2-owner-session-test-only-secret-32chars";
const url = "https://lumi.invalid/api/humanwiki/private-area-preflight";
const liveStore = {
  stagingDirectory: store.directory,
  expectedRestoreGeneration: store.restoreGeneration,
};

const setup = () => {
  process.env.NODE_ENV = "production";
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "true";
  process.env.AI_EXECUTIVE_PASSWORD_HASH = passwordHash;
  process.env.AI_EXECUTIVE_SESSION_SECRET = secret;
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = store.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = store.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = store.ownerUserId;
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID = store.unassignedAreaId;
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_PREFLIGHT_ENABLED = "true";
  delete process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED;
};
const ownerRequest = (token, location = url, headers = {}) =>
  new Request(location, {
    headers: {
      ...(token ? {cookie: sessionCookieName + "=" + token} : {}),
      ...headers,
    },
  });
const assertHidden = async response => {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {error:"Not found"});
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
};

test("H1-real.2 authentic owner can preflight only a LIVE private Area, never an import", async () => {
  setup();
  const token = createSessionToken();
  assert.equal(verifyHumanWikiOwnerPrivateAreaLive(
    liveStore, store.ownerUserId, store.unassignedAreaId), true);
  const reply = await GET(ownerRequest(token));
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("cache-control"), "no-store");
  assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
  const result = await reply.json();
  assert.deepEqual(result, {
    result: "owner_private_area_read_verified_for_preflight_only",
    actual_import_authorized: false,
    real_source_consent_verified: false,
    independent_revocation_witness_verified: false,
    h1_real_ready: false,
    claims_created: 0,
  });
  const raw = JSON.stringify(result);
  for (const privateValue of [store.ownerUserId,store.unassignedAreaId,
    store.restoreGeneration,store.directory,secret]) {
    assert.equal(raw.includes(privateValue), false, "preflight response must contain no private IDs");
  }
  const bytes = '{"real_personal_export":"never read"}';
  process.env.AI_EXECUTIVE_HUMANWIKI_REAL_IMPORT_ENABLED = "true";
  const upload = new Request("https://lumi.invalid/api/humanwiki/import", {
    method:"POST", headers: {cookie: sessionCookieName+"="+token,
      "content-type":"application/json"}, body:bytes,
  });
  await assertHidden(await POST(upload));
  assert.equal(upload.bodyUsed,false);
  assert.equal(await upload.text(),bytes);
});

test("H1-real.2 denies without a real signed owner session or enabled feature flag", async () => {
  setup();
  const token = createSessionToken();
  delete process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_PREFLIGHT_ENABLED;
  await assertHidden(await GET(ownerRequest(token)));
  for (const value of ["false","1","TRUE","enabled",""]) {
    process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_PREFLIGHT_ENABLED=value;
    await assertHidden(await GET(ownerRequest(token)));
  }
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_PREFLIGHT_ENABLED="true";
  for (const suspect of [undefined, "forged", createSessionToken(-1), token+".tampered"]) {
    await assertHidden(await GET(ownerRequest(suspect)));
  }
  await assertHidden(await GET(ownerRequest(undefined,url,{
    authorization:"Bearer claimed-owner","x-area-id":store.unassignedAreaId,
    "x-area-role":"owner","x-h1-consent-verified":"true",
  })));
  process.env.NODE_ENV="test";
  process.env.AI_EXECUTIVE_AUTH_ENABLED="false";
  await assertHidden(await GET(ownerRequest(token)));
  process.env.NODE_ENV="production";
  process.env.AI_EXECUTIVE_AUTH_ENABLED="true";
});

test("H1-real.2 Area ID comes only from server config; wrong owner/Area and query fail closed", async () => {
  setup();
  const token=createSessionToken();
  assert.equal(verifyHumanWikiOwnerPrivateAreaLive(liveStore,"other-user",store.unassignedAreaId),false);
  assert.equal(verifyHumanWikiOwnerPrivateAreaLive(liveStore,store.ownerUserId,"missing-area"),false);
  for(const id of ["shared:family","private:other-user","all","my-plan","",
    " "+store.unassignedAreaId, "x".repeat(260)]) {
    process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID=id;
    await assertHidden(await GET(ownerRequest(token)));
  }
  process.env.AI_EXECUTIVE_HUMANWIKI_PRIVATE_AREA_ID=store.unassignedAreaId;
  await assertHidden(await GET(ownerRequest(token,url+"?areaId="+encodeURIComponent(store.unassignedAreaId))));
  await assertHidden(await GET(ownerRequest(token,url+"?")));
  assert.equal((await GET(ownerRequest(token,url,{
    "x-humanwiki-area-id":"attacker-private-area",
    "x-humanwiki-actor-id":"other-user","x-consent-verified":"true",
  }))).status,200,"untrusted headers cannot select a different Area");
});

test("H1-real.2 LIVE verified staging anchor, restore generation and owner config fail closed", async () => {
  setup();
  const token=createSessionToken();
  const good=await GET(ownerRequest(token));
  assert.equal(good.status,200);

  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=
    "123e4567-e89b-42d3-a456-426614174999";
  await assertHidden(await GET(ownerRequest(token)));
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=store.restoreGeneration;

  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID="other-user";
  await assertHidden(await GET(ownerRequest(token)));
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID=store.ownerUserId;

  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=path.join(root,"absent");
  await assertHidden(await GET(ownerRequest(token)));
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=store.directory;

  delete process.env.AI_EXECUTIVE_PASSWORD_HASH;
  await assertHidden(await GET(ownerRequest(token)));
  process.env.AI_EXECUTIVE_PASSWORD_HASH=passwordHash;
  process.env.AI_EXECUTIVE_SESSION_SECRET="rotated-H1-real-2-owner-session-key-32characters";
  await assertHidden(await GET(ownerRequest(token)));
  process.env.AI_EXECUTIVE_SESSION_SECRET=secret;
  assert.equal((await GET(ownerRequest(token))).status,200);
});

test("H1-real.2 unauthorized or malformed request never reveals Area or owner configuration", async () => {
  setup();
  let accesses=0;
  const hostile=new Proxy({},{
    get(){accesses++;throw Error("cannot inspect malformed HTTP request");},
    getPrototypeOf(){accesses++;throw Error("cannot inspect request prototype");},
  });
  await assertHidden(await GET(hostile));
  assert.ok(accesses>0,"handler must try real cookie authentication");
  await assertHidden(await GET(ownerRequest(undefined)));
  assert.equal(verifyHumanWikiOwnerPrivateAreaLive(
    {stagingDirectory:path.join(root,"missing"),expectedRestoreGeneration:store.restoreGeneration},
    store.ownerUserId,store.unassignedAreaId),false);
  // No owner, Area, source, or private token in rejection response.
});
