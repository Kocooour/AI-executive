import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  appendHumanWikiConsentIntent, createHumanWikiConsentIntentSchema,
  humanWikiConsentIntentLocalHead,
} from "../lib/humanwiki-consent-intents.mjs";
import {
  HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA,
  humanWikiWitnessChallengePayload, verifyHumanWikiFreshWitnessPreflight,
} from "../lib/humanwiki-consent-witness-preflight.mjs";
import { denyHumanWikiH1RealImport, HumanWikiH1RealEntryBlockedError }
  from "../lib/humanwiki-h1-real-entry.mjs";

const ledgerKey = Buffer.alloc(32, 42);
const registryId = randomUUID();
const otherRegistryId = randomUUID();
const privateScope = {ownerUserId:"owner-one",privateAreaId:"personal-unassigned"};
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const makeCommand = (changes = {}) => ({
  commandId: randomUUID(), sourceType:"chatgpt_user_export",
  decision:"grant_requested", purpose:"humanwiki_context_bootstrap",
  retentionDays:90, expectedRevision:0, explicitConfirmation:true, ...changes,
});

async function fixture(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lumi-h1-witness-"));
  const file = path.join(dir, "intents.sqlite");
  let db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
    createHumanWikiConsentIntentSchema(db);
    return await fn({
      get db() {return db;}, file, dir,
      reopen() {if (db.isOpen) db.close();db = new DatabaseSync(file);return db;},
    });
  } finally {
    if (db.isOpen) db.close();
    rmSync(dir, {recursive:true,force:true});
  }
}
const head = db => {
  const h = humanWikiConsentIntentLocalHead(db, ledgerKey);
  assert.equal(h.ok,true);
  assert.equal(h.importAuthorized,false);
  assert.equal(h.independentWitnessVerified,false);
  return { sequence:h.sequence, digest:h.digest };
};
const receipt = (identity, challenge, witnessHead, signingKey = privateKey) => {
  const {sequence,digest} = witnessHead;
  const signature = sign(null,
    humanWikiWitnessChallengePayload(identity,challenge,sequence,digest),
    signingKey).toString("base64url");
  return {
    version:HUMANWIKI_WITNESS_PREFLIGHT_SCHEMA,
    registryId:identity,nonce:challenge,sequence,digest,signature,
  };
};
const options = (db, provider) => ({
  db,ledgerKey,registryId,witnessPublicKey:publicKey,getFreshReceipt:provider,
});
const denied = result => {
  assert.deepEqual(result,{
    ok:false,reason:"not_verified_blocked",
    importAuthorized:false,independentWitnessVerified:false,
    withdrawalComplete:false,
  });
};

test("signed fresh external checkpoint matches a content-free local head, never grants import", async () => {
  await fixture(async ({db}) => {
    assert.equal(appendHumanWikiConsentIntent(db,ledgerKey,privateScope,makeCommand()).ok,true);
    const anchored = head(db);
    const seen = [];
    const result = await verifyHumanWikiFreshWitnessPreflight(options(db, params => {
      seen.push(params);
      return receipt(params.registryId, params.nonce, anchored);
    }));
    assert.equal(result.ok,true);
    assert.equal(result.result,"fresh_signed_high_water_matches_local_head_for_preflight_only");
    assert.equal(result.importAuthorized,false);
    assert.equal(result.independentWitnessVerified,false);
    assert.equal(result.withdrawalComplete,false);
    assert.equal(result.claimsCreated,0);
    assert.equal(seen.length,1);
    assert.deepEqual(Object.keys(seen[0]).sort(),["nonce","registryId"]);
    assert.equal(seen[0].registryId,registryId);
    assert.match(seen[0].nonce,/^[a-zA-Z0-9_-]{43}$/);
    assert.equal(JSON.stringify(result).includes(privateScope.ownerUserId),false);
    assert.equal(JSON.stringify(result).includes(privateScope.privateAreaId),false);
    assert.throws(()=>denyHumanWikiH1RealImport({},{}),HumanWikiH1RealEntryBlockedError);
  });
});

test("missing, untrusted or stale external provider fails closed without importing", async () => {
  await fixture(async ({db}) => {
    assert.equal(appendHumanWikiConsentIntent(db,ledgerKey,privateScope,makeCommand()).ok,true);
    const anchored=head(db);
    const { publicKey:wrongPublic }=generateKeyPairSync("ed25519");
    const bad=[
      undefined, null, () => null, () => {throw Error("network down");},
      ({nonce})=>receipt(otherRegistryId,nonce,anchored),
      ({registryId})=>receipt(registryId,"A".repeat(43),anchored),
      ({nonce})=>receipt(registryId,nonce,{sequence:anchored.sequence+1,digest:anchored.digest}),
      ({nonce})=>receipt(registryId,nonce,{sequence:anchored.sequence,digest:"f".repeat(64)}),
      ({nonce})=>({...receipt(registryId,nonce,anchored),extraField:true}),
      ({nonce})=>({...receipt(registryId,nonce,anchored),signature:"A".repeat(86)}),
    ];
    for(const provider of bad)denied(await verifyHumanWikiFreshWitnessPreflight(
      options(db,provider)));
    denied(await verifyHumanWikiFreshWitnessPreflight({
      ...options(db,({nonce})=>receipt(registryId,nonce,anchored)),
      witnessPublicKey:wrongPublic,
    }));
    denied(await verifyHumanWikiFreshWitnessPreflight({
      ...options(db,({nonce})=>receipt(registryId,nonce,anchored)),
      registryId:"invalid-id",
    }));
  });
});

test("coherently restored older SQLite ledger is refused by newer signed high-water checkpoint", async () => {
  await fixture(async (fx) => {
    const { db, file, dir }=fx;
    const first=makeCommand();
    assert.equal(appendHumanWikiConsentIntent(db,ledgerKey,privateScope,first).ok,true);
    const backup=path.join(dir,"older.sqlite");
    copyFileSync(file,backup);
    assert.equal(appendHumanWikiConsentIntent(db,ledgerKey,privateScope,makeCommand({
      decision:"withdrawal_requested",retentionDays:null,expectedRevision:1,
    })).ok,true);
    const anchored=head(db);
    db.close();
    copyFileSync(backup,file);
    const restored=fx.reopen();
    assert.equal(head(restored).sequence,1);
    denied(await verifyHumanWikiFreshWitnessPreflight(
      options(restored,({registryId,nonce})=>receipt(registryId,nonce,anchored))));
  });
});

test("changes during remote lookup invalidate the preflight even when old receipt is signed", async () => {
  await fixture(async ({db}) => {
    const before=head(db);
    denied(await verifyHumanWikiFreshWitnessPreflight(options(db,({registryId,nonce})=>{
      assert.equal(appendHumanWikiConsentIntent(db,ledgerKey,privateScope,makeCommand()).ok,true);
      return receipt(registryId,nonce,before);
    })));
    // Even the newly correct witness state can never authorize import.
    const after=head(db);
    const result=await verifyHumanWikiFreshWitnessPreflight(
      options(db,({registryId,nonce})=>receipt(registryId,nonce,after)));
    assert.equal(result.ok,true);
    assert.equal(result.importAuthorized,false);
  });
});

test("a bad HMAC key, corrupt history or unsupported journal aborts before external I/O", async () => {
  await fixture(async ({db})=>{
    assert.equal(appendHumanWikiConsentIntent(db,ledgerKey,privateScope,makeCommand()).ok,true);
    let called=0;
    const callback=()=>{called++;throw Error("must not be called");};
    denied(await verifyHumanWikiFreshWitnessPreflight({
      ...options(db,callback),ledgerKey:Buffer.alloc(32,9),
    }));
    db.exec("PRAGMA journal_mode=MEMORY");
    denied(await verifyHumanWikiFreshWitnessPreflight(options(db,callback)));
    assert.equal(called,0);
  });
});

test("empty ledger can be attested but still has no import or independent witness authority", async()=>{
  await fixture(async ({db})=>{
    const current=head(db);
    assert.deepEqual(current,{sequence:0,digest:"0".repeat(64)});
    const result=await verifyHumanWikiFreshWitnessPreflight(
      options(db,({registryId,nonce})=>receipt(registryId,nonce,current)));
    assert.equal(result.ok,true);
    assert.equal(result.importAuthorized,false);
    assert.equal(result.independentWitnessVerified,false);
  });
});
