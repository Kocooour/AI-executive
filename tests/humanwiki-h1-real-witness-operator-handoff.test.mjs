import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import {
  bootstrapHumanWikiConsentPrivateLedger, withHumanWikiConsentPrivateLedger,
  withHumanWikiConsentPrivateLedgerAsync,
} from "../lib/humanwiki-consent-private-store.mjs";
import {
  appendHumanWikiConsentIntent, humanWikiConsentIntentLocalHead,
} from "../lib/humanwiki-consent-intents.mjs";
import {
  humanWikiWitnessChallengePayload, verifyHumanWikiFreshWitnessPreflight,
} from "../lib/humanwiki-consent-witness-preflight.mjs";
import { createWitnessHttpsServer } from "../services/humanwiki-witness/server.mjs";
import {
  witnessCurrentHead, witnessChallengeReceipt, publishWitnessCheckpoint,
} from "../services/humanwiki-witness/store.mjs";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-witness-handoff-"));
after(()=>rmSync(root,{recursive:true,force:true}));
const newDirectory=()=>mkdtempSync(path.join(root,"private-"));
const {privateKey,publicKey}=generateKeyPairSync("ed25519");
const registryId=randomUUID();
const EMPTY="0".repeat(64);
const operatorFile=fileURLToPath(new URL("../services/humanwiki-witness/operator.mjs",import.meta.url));
const provision=()=>{
  const directory=newDirectory();
  const keys=newDirectory();
  const signerFile=path.join(keys,"witness.pem");
  writeFileSync(signerFile,privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});
  return {directory,env:{
    ...process.env,HUMANWIKI_WITNESS_STORAGE_DIRECTORY:directory,
    HUMANWIKI_WITNESS_REGISTRY_ID:registryId,
    HUMANWIKI_WITNESS_SIGNING_KEY_FILE:signerFile,
  }};
};
const run=(env,...args)=>execFileSync(process.execPath,[operatorFile,...args],{
  env,encoding:"utf8",stdio:["ignore","pipe","pipe"],
}).trim();
const ack=(env,sequence,previousDigest,digest)=>JSON.parse(
  run(env,"publish",String(sequence),previousDigest,digest));
const current=(dir)=>witnessCurrentHead(dir,registryId,privateKey);
const validReceipt=(receipt)=>{
  assert.deepEqual(Object.keys(receipt).sort(),
    ["version","registryId","nonce","sequence","digest","signature"].sort());
  assert.equal(receipt.registryId,registryId);
  assert.match(receipt.nonce,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(verify(null,humanWikiWitnessChallengePayload(
    receipt.registryId,receipt.nonce,receipt.sequence,receipt.digest),
    publicKey,Buffer.from(receipt.signature,"base64url")),true);
};
const assertCount=(directory,n)=>{
  const db=new DatabaseSync(path.join(directory,"witness-high-water.sqlite"),{
    readOnly:true,
  });
  try{assert.equal(db.prepare(
    "SELECT COUNT(*) AS n FROM witness_high_water_events").get().n,n);}
  finally{db.close();}
};

test("lost operator stdout is recovered by exact latest-tuple replay with signed receipt",()=>{
  const {directory,env}=provision();
  run(env,"bootstrap");
  const digest="a".repeat(64);
  // The first operator process commits durably but its stdout is discarded,
  // representing the caller losing the response after COMMIT.
  run(env,"publish","1",EMPTY,digest);
  assertCount(directory,2);
  const retry=ack(env,1,EMPTY,digest);
  assert.deepEqual(Object.keys(retry).sort(),[
    "schema","replayed","receipt","importAuthorized",
    "independentWitnessVerified","withdrawalComplete","consentVerified",
  ].sort());
  assert.equal(retry.schema,"humanwiki_witness_operator_handoff_v1");
  assert.equal(retry.replayed,true);
  assert.equal(retry.importAuthorized,false);
  assert.equal(retry.independentWitnessVerified,false);
  assert.equal(retry.withdrawalComplete,false);
  assert.equal(retry.consentVerified,false);
  assert.equal(retry.receipt.sequence,1);
  assert.equal(retry.receipt.digest,digest);
  validReceipt(retry.receipt);
  assertCount(directory,2);
  assert.deepEqual(current(directory),{sequence:1,digest});

  // The digest, predecessor, or historical sequence cannot be substituted.
  assert.throws(()=>ack(env,1,EMPTY,"b".repeat(64)));
  assert.throws(()=>ack(env,1,"f".repeat(64),digest));
  assert.throws(()=>ack(env,3,digest,"c".repeat(64)));
  assertCount(directory,2);

  const next=ack(env,2,digest,"c".repeat(64));
  assert.equal(next.replayed,false);
  validReceipt(next.receipt);
  assert.equal(next.receipt.sequence,2);
  assertCount(directory,3);
  assert.throws(()=>ack(env,1,EMPTY,digest),
    "cannot acknowledge a stale, no longer latest checkpoint");
  assertCount(directory,3);
});

test("same checkpoint replays only after a full, untampered historical audit",()=>{
  const {directory,env}=provision();
  run(env,"bootstrap");
  const digests=["1".repeat(64),"2".repeat(64),"3".repeat(64)];
  let previous=EMPTY;
  for(let i=0;i<digests.length;i++){
    assert.equal(ack(env,i+1,previous,digests[i]).replayed,false);
    previous=digests[i];
  }
  const file=path.join(directory,"witness-high-water.sqlite");
  const db=new DatabaseSync(file);
  try{
    const schema=db.prepare(`SELECT sql FROM sqlite_master
      WHERE name='witness_high_water_no_update'`).get().sql;
    db.exec("DROP TRIGGER witness_high_water_no_update");
    db.prepare(`UPDATE witness_high_water_events SET digest=?
      WHERE sequence=1`).run("f".repeat(64));
    db.exec(schema+";");
  }finally{db.close();}
  assert.throws(()=>ack(env,3,digests[1],digests[2]),
    "retry must not mask historical corruption even with valid last signature");
  assert.throws(()=>ack(env,4,digests[2],"4".repeat(64)));
  assert.throws(()=>witnessChallengeReceipt(directory,registryId,privateKey,
    Buffer.alloc(32,7).toString("base64url")));
  assertCount(directory,4);
});

test("actual TLS witness reports the same durable checkpoint after lost operator response",async()=>{
  const {directory,env}=provision();
  run(env,"bootstrap");
  const local=newDirectory();
  bootstrapHumanWikiConsentPrivateLedger(local);
  const ledgerKey=Buffer.alloc(32,0x48);
  const certDir=newDirectory(),cert=path.join(certDir,"cert.pem"),
    tlsKey=path.join(certDir,"tls-key.pem");
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes",
    "-keyout",tlsKey,"-out",cert,"-days","1",
    "-subj","/CN=localhost",
    "-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"],{stdio:"ignore"});
  chmodSync(tlsKey,0o600);
  const server=createWitnessHttpsServer({
    directory,registryId,privateKey,
    tlsKey:readFileSync(tlsKey),tlsCert:readFileSync(cert),
  });
  const port=await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      server.off("error",reject);resolve(server.address().port);
    });
  });
  const provider=async({registryId:id,nonce,signal})=>new Promise((resolve,reject)=>{
    const request=https.request({
      hostname:"127.0.0.1",servername:"localhost",port,
      method:"POST",path:"/v1/humanwiki/high-water/challenge",
      ca:readFileSync(cert),signal,
      headers:{"content-type":"application/json"},
    },response=>{
      const chunks=[];response.on("data",chunk=>chunks.push(chunk));
      response.on("end",()=>{
        if(response.statusCode!==200)return reject(Error("not_found"));
        try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}
        catch(error){reject(error);}
      });
      response.on("error",reject);
    });
    request.on("error",reject);
    request.end(JSON.stringify({registryId:id,nonce}));
  });
  const preflight=()=>withHumanWikiConsentPrivateLedgerAsync(local,db=>
    verifyHumanWikiFreshWitnessPreflight({
      db,ledgerKey,registryId,witnessPublicKey:publicKey,
      getFreshReceipt:provider,
    }));
  try {
    assert.equal((await preflight()).ok,true);
    const head=withHumanWikiConsentPrivateLedger(local,"write",db=>{
      const appended=appendHumanWikiConsentIntent(db,ledgerKey,{
        ownerUserId:"alice",privateAreaId:"private-area",
      },{
        commandId:randomUUID(),sourceType:"chatgpt_user_export",
        decision:"withdrawal_requested",purpose:"humanwiki_context_bootstrap",
        retentionDays:null,expectedRevision:0,explicitConfirmation:true,
      });
      assert.equal(appended.ok,true);
      const result=humanWikiConsentIntentLocalHead(db,ledgerKey);
      assert.equal(result.ok,true);
      return result;
    });
    // Local HMAC head is ahead: a live signed remote witness must refuse.
    assert.equal((await preflight()).ok,false);
    run(env,"publish",String(head.sequence),EMPTY,head.digest);
    const recovered=ack(env,head.sequence,EMPTY,head.digest);
    assert.equal(recovered.replayed,true);
    validReceipt(recovered.receipt);
    assert.equal(recovered.receipt.sequence,head.sequence);
    assert.equal(recovered.receipt.digest,head.digest);
    assert.equal((await preflight()).ok,true);
    const result=await preflight();
    assert.equal(result.importAuthorized,false);
    assert.equal(result.independentWitnessVerified,false);
    assert.equal(result.withdrawalComplete,false);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
