import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync,
  rmSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  bootstrapWitnessStore, publishWitnessCheckpoint, witnessChallengeReceipt,
  witnessCurrentHead,
} from "../services/humanwiki-witness/store.mjs";
import {
  createWitnessHttpsServer, readProtectedWitnessFile,
} from "../services/humanwiki-witness/server.mjs";
import {
  humanWikiWitnessChallengePayload, verifyHumanWikiFreshWitnessPreflight,
} from "../lib/humanwiki-consent-witness-preflight.mjs";
import {
  bootstrapHumanWikiConsentPrivateLedger,
  withHumanWikiConsentPrivateLedger,
  withHumanWikiConsentPrivateLedgerAsync,
} from "../lib/humanwiki-consent-private-store.mjs";
import {
  appendHumanWikiConsentIntent, humanWikiConsentIntentLocalHead,
} from "../lib/humanwiki-consent-intents.mjs";

const EMPTY="0".repeat(64);
const registryId=randomUUID();
const {publicKey,privateKey}=generateKeyPairSync("ed25519");
const root=mkdtempSync(path.join(os.tmpdir(),"lumi-witness-real-service-"));
const fixture=()=>mkdtempSync(path.join(root,"separate-"));
const nonce=()=>Buffer.alloc(32,0x77).toString("base64url");
const checkSignature=receipt=>assert.equal(verify(null,
  humanWikiWitnessChallengePayload(receipt.registryId,receipt.nonce,
    receipt.sequence,receipt.digest),publicKey,
  Buffer.from(receipt.signature,"base64url")),true);
test.after(()=>rmSync(root,{recursive:true,force:true}));

test("operator-only bootstrap seals installation identity and durable genesis",()=>{
  const dir=fixture();
  const result=bootstrapWitnessStore(dir,registryId,privateKey);
  assert.deepEqual(result,{
    ok:true,sequence:0,importAuthorized:false,withdrawalComplete:false,
  });
  assert.deepEqual(witnessCurrentHead(dir,registryId,privateKey),
    {sequence:0,digest:EMPTY});
  assert.equal(lstatSync(path.join(dir,"witness-high-water.sqlite")).mode&0o177,0);
  assert.equal(lstatSync(path.join(dir,"witness-installation.lock")).mode&0o177,0);
  assert.throws(()=>bootstrapWitnessStore(dir,registryId,privateKey));
  const other=generateKeyPairSync("ed25519").privateKey;
  assert.throws(()=>witnessCurrentHead(dir,registryId,other),
    /witness_unavailable/);
  assert.throws(()=>witnessCurrentHead(dir,randomUUID(),privateKey),
    /witness_unavailable/);
});
test("offline publish requires exactly the next checkpoint and correct predecessor",()=>{
  const dir=fixture();
  bootstrapWitnessStore(dir,registryId,privateKey);
  assert.throws(()=>publishWitnessCheckpoint(dir,registryId,privateKey,{
    sequence:2,previousDigest:EMPTY,digest:"a".repeat(64)}));
  const result=publishWitnessCheckpoint(dir,registryId,privateKey,{
    sequence:1,previousDigest:EMPTY,digest:"a".repeat(64)});
  assert.equal(result.ok,true);
  assert.equal(result.importAuthorized,false);
  assert.equal(result.withdrawalComplete,false);
  assert.deepEqual(witnessCurrentHead(dir,registryId,privateKey),
    {sequence:1,digest:"a".repeat(64)});
  for(const next of [
    {sequence:1,previousDigest:EMPTY,digest:"b".repeat(64)},
    {sequence:2,previousDigest:EMPTY,digest:"b".repeat(64)},
    {sequence:3,previousDigest:"a".repeat(64),digest:"b".repeat(64)},
    {sequence:2,previousDigest:"a".repeat(64),digest:"BAD"},
  ]){
    assert.throws(()=>publishWitnessCheckpoint(dir,registryId,privateKey,next));
  }
  assert.equal(publishWitnessCheckpoint(dir,registryId,privateKey,{
    sequence:2,previousDigest:"a".repeat(64),digest:"b".repeat(64)}).sequence,2);
  const receipt=witnessChallengeReceipt(dir,registryId,privateKey,nonce());
  assert.equal(receipt.sequence,2);
  assert.equal(receipt.digest,"b".repeat(64));
  assert.deepEqual(Object.keys(receipt).sort(),
    ["version","registryId","nonce","sequence","digest","signature"].sort());
  checkSignature(receipt);
});
test("missing or partly tampered ledger fails closed and cannot auto bootstrap",()=>{
  const dir=fixture();
  bootstrapWitnessStore(dir,registryId,privateKey);
  publishWitnessCheckpoint(dir,registryId,privateKey,{
    sequence:1,previousDigest:EMPTY,digest:"a".repeat(64)});
  const dbfile=path.join(dir,"witness-high-water.sqlite");
  const marker=path.join(dir,"witness-installation.lock");
  renameSync(dbfile,path.join(dir,"witness-high-water.lost"));
  assert.equal(existsSync(dbfile),false);
  assert.throws(()=>witnessChallengeReceipt(dir,registryId,privateKey,nonce()));
  assert.throws(()=>bootstrapWitnessStore(dir,registryId,privateKey));
  assert.equal(existsSync(dbfile),false);
  assert.equal(existsSync(marker),true);

  const partial=fixture();
  bootstrapWitnessStore(partial,registryId,privateKey);
  const file=path.join(partial,"witness-high-water.sqlite");
  const db=new DatabaseSync(file);
  db.exec("DROP TRIGGER witness_high_water_no_delete");
  db.close();
  assert.throws(()=>witnessCurrentHead(partial,registryId,privateKey));
  assert.throws(()=>publishWitnessCheckpoint(partial,registryId,privateKey,{
    sequence:1,previousDigest:EMPTY,digest:"a".repeat(64)}));

  const rogue=fixture();
  bootstrapWitnessStore(rogue,registryId,privateKey);
  const modified=new DatabaseSync(path.join(rogue,"witness-high-water.sqlite"));
  modified.exec("CREATE TABLE unrelated_backdoor(data TEXT)");
  modified.close();
  assert.throws(()=>witnessCurrentHead(rogue,registryId,privateKey),
    "unexpected SQLite object must block witness signatures");

  // SQLite LIKE treats '_' as a wildcard. Reject names that only LOOK like
  // its reserved 'sqlite_' internal prefix but are user-defined triggers.
  const masquerade=fixture();
  bootstrapWitnessStore(masquerade,registryId,privateKey);
  const fake=new DatabaseSync(path.join(masquerade,"witness-high-water.sqlite"));
  fake.exec(`CREATE TRIGGER sqliteX_hidden_writer
    AFTER INSERT ON witness_high_water_events BEGIN SELECT 1; END`);
  fake.close();
  assert.throws(()=>witnessCurrentHead(masquerade,registryId,privateKey),
    "a sqliteX_ named trigger must not bypass the exact schema allowlist");
  assert.throws(()=>publishWitnessCheckpoint(masquerade,registryId,privateKey,{
    sequence:1,previousDigest:EMPTY,digest:"b".repeat(64)}));
});

test("checkpoint 10001 can publish after 10k signed records, and old corruption forbids the next append",()=>{
  const dir=fixture();
  bootstrapWitnessStore(dir,registryId,privateKey);
  const file=path.join(dir,"witness-high-water.sqlite");
  // The fixture seeds 10,000 genuinely Ed25519-signed SQLite records directly
  // in one transaction to avoid O(n^2) full-chain audits in the test setup.
  // The production publication API must audit ALL 10k rows and then append
  // checkpoint 10001 normally, proving continuity beyond the old limit.
  let previous=EMPTY;
  const db=new DatabaseSync(file);
  try{
    const genesis=db.prepare(`SELECT chain_hash,signature FROM witness_high_water_events
      WHERE sequence=0`).get();
    let priorHash=genesis.chain_hash,priorSig=genesis.signature;
    const insert=db.prepare(`INSERT INTO witness_high_water_events
      (sequence,registry_id,digest,previous_digest,chain_hash,signature)
      VALUES (?,?,?,?,?,?)`);
    db.exec("BEGIN IMMEDIATE");
    try {
      for(let sequence=1;sequence<=10000;sequence++){
        const digest=sequence.toString(16).padStart(64,"0");
        const hash=createHash("sha256").update([
          "humanwiki_witness_accumulator_v2",registryId,String(sequence),
          previous,digest,priorHash,priorSig,"",
        ].join("\n"),"utf8").digest("hex");
        const signature=sign(null,Buffer.from([
          "humanwiki_witness_monotonic_event_v2",registryId,String(sequence),
          previous,digest,hash,"",
        ].join("\n"),"utf8"),privateKey).toString("base64url");
        insert.run(sequence,registryId,digest,previous,hash,signature);
        priorHash=hash;priorSig=signature;previous=digest;
      }
      db.exec("COMMIT");
    }catch(error){
      try{db.exec("ROLLBACK");}catch{/* fail closed */}
      throw error;
    }
  }finally{db.close();}

  assert.deepEqual(witnessCurrentHead(dir,registryId,privateKey),{
    sequence:10000,digest:previous,
  });
  const finalDigest="a".repeat(64);
  const appended=publishWitnessCheckpoint(dir,registryId,privateKey,{
    sequence:10001,previousDigest:previous,digest:finalDigest,
  });
  assert.equal(appended.ok,true);
  assert.equal(appended.sequence,10001);
  assert.deepEqual(witnessCurrentHead(dir,registryId,privateKey),{
    sequence:10001,digest:finalDigest,
  });
  const receipt=witnessChallengeReceipt(dir,registryId,privateKey,nonce());
  checkSignature(receipt);
  assert.equal(receipt.sequence,10001);
  assert.equal(receipt.digest,finalDigest);

  // A local tamperer can DROP the no-update trigger, change an older digest,
  // then recreate the exact original trigger. The tail signature stays valid
  // but the history is corrupt; BOTH future signatures and HTTP challenges
  // must refuse. The attempted append must leave row count unchanged.
  const changed=new DatabaseSync(file);
  try{
    const original=changed.prepare(`SELECT sql FROM sqlite_master
      WHERE name='witness_high_water_no_update'`).get().sql;
    changed.exec("DROP TRIGGER witness_high_water_no_update");
    changed.prepare(`UPDATE witness_high_water_events SET digest=?
      WHERE sequence=5000`).run("f".repeat(64));
    changed.exec(original+";");
  }finally{changed.close();}
  assert.throws(()=>witnessCurrentHead(dir,registryId,privateKey));
  assert.throws(()=>witnessChallengeReceipt(dir,registryId,privateKey,nonce()));
  assert.throws(()=>publishWitnessCheckpoint(dir,registryId,privateKey,{
    sequence:10002,previousDigest:finalDigest,digest:"b".repeat(64),
  }),"corrupt older row must prevent a signed operator acknowledgement");
  const check=new DatabaseSync(file,{readOnly:true});
  try{
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM witness_high_water_events").get().n,10002);
    assert.equal(check.prepare(
      "SELECT COUNT(*) AS n FROM witness_high_water_events WHERE sequence=10002").get().n,0);
  }finally{check.close();}
});

test("short corrupt historical chain refuses publishing next signed head",()=>{
  const dir=fixture();
  bootstrapWitnessStore(dir,registryId,privateKey);
  let previous=EMPTY;
  for(let seq=1;seq<=4;seq++){
    const digest=seq.toString(16).padStart(64,"0");
    assert.equal(publishWitnessCheckpoint(dir,registryId,privateKey,{
      sequence:seq,previousDigest:previous,digest,
    }).ok,true);
    previous=digest;
  }
  const file=path.join(dir,"witness-high-water.sqlite");
  const db=new DatabaseSync(file);
  try{
    const trigger=db.prepare(`SELECT sql FROM sqlite_master
      WHERE name='witness_high_water_no_update'`).get().sql;
    db.exec("DROP TRIGGER witness_high_water_no_update");
    db.prepare(`UPDATE witness_high_water_events SET digest=?
      WHERE sequence=1`).run("f".repeat(64));
    db.exec(trigger+";");
  }finally{db.close();}
  assert.throws(()=>publishWitnessCheckpoint(dir,registryId,privateKey,{
    sequence:5,previousDigest:previous,digest:"a".repeat(64),
  }));
  const read=new DatabaseSync(file,{readOnly:true});
  try{
    assert.equal(read.prepare("SELECT MAX(sequence) AS head FROM witness_high_water_events").get().head,4);
  }finally{read.close();}
});

test("protected private files reject symlinks and group-readable key material",()=>{
  const dir=fixture();
  const keyFile=path.join(dir,"key.pem");
  const otherFile=path.join(dir,"other.pem");
  writeFileSync(keyFile,"fake private key",{mode:0o600});
  assert.equal(readProtectedWitnessFile(keyFile).toString(),"fake private key");
  chmodSync(keyFile,0o644);
  assert.throws(()=>readProtectedWitnessFile(keyFile),/witness_unavailable/);
  writeFileSync(otherFile,"public",{mode:0o600});
  const symlink=path.join(dir,"shortcut.pem");
  symlinkSync(otherFile,symlink);
  assert.throws(()=>readProtectedWitnessFile(symlink),/witness_unavailable/);
  chmodSync(dir,0o755);
  assert.throws(()=>readProtectedWitnessFile(otherFile),/witness_unavailable/,
    "group-readable key directory cannot hold trusted signing material");
  chmodSync(dir,0o700);
});

test("real HTTPS server signs only its latest head, refuses all uploads and malformed challenges",async()=>{
  const dir=fixture();
  bootstrapWitnessStore(dir,registryId,privateKey);
  const tlsDir=fixture();
  const cert=path.join(tlsDir,"cert.pem"),keyFile=path.join(tlsDir,"tls-key.pem");
  // Local test-only self-signed TLS key; generated afresh and never committed.
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes",
    "-keyout",keyFile,"-out",cert,"-days","1",
    "-subj","/CN=localhost",
    "-addext","subjectAltName=DNS:localhost,IP:127.0.0.1"],{stdio:"ignore"});
  const server=createWitnessHttpsServer({
    directory:dir,registryId,privateKey,
    tlsKey:readFileSync(keyFile),tlsCert:readFileSync(cert),
  });
  const port=await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      server.off("error",reject);
      resolve(server.address().port);
    });
  });
  const request=(data,opts={})=>new Promise((resolve,reject)=>{
    const body=typeof data==="string"?data:JSON.stringify(data);
    const req=https.request({
      hostname:"127.0.0.1",servername:"localhost",port,
      path:opts.path??"/v1/humanwiki/high-water/challenge",
      method:opts.method??"POST",ca:readFileSync(cert),
      ...(opts.signal?{signal:opts.signal}:{}),
      headers:{
        "content-type":opts.contentType??"application/json",
        "content-length":Buffer.byteLength(body),
        ...(opts.headers??{}),
      },
      timeout:2500,
    },res=>{
      const chunks=[];
      res.on("data",c=>chunks.push(c));
      res.on("end",()=>resolve({
        status:res.statusCode,headers:res.headers,
        body:Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("error",reject);
    req.end(body);
  });
  try{
    const good={registryId,nonce:nonce()};
    const initial=await request(good);
    assert.equal(initial.status,200);
    assert.equal(initial.headers["cache-control"],"no-store");
    checkSignature(JSON.parse(initial.body));
    assert.equal(JSON.parse(initial.body).sequence,0);

    // Real TLS round-trip from the *actual Lumi HMAC ledger verifier* to
    // this separately provisioned witness store. The two databases have
    // independent roots/keys. A stale remote witness must remain default-deny.
    const localLedger=fixture();
    const ledgerKey=Buffer.alloc(32,0x38);
    bootstrapHumanWikiConsentPrivateLedger(localLedger);
    const remoteProvider=async({registryId:id,nonce:challenge,signal})=>{
      const response=await request({registryId:id,nonce:challenge},{signal});
      if(response.status!==200)throw Error("witness_unavailable");
      return JSON.parse(response.body);
    };
    const verifyLocal=()=>withHumanWikiConsentPrivateLedgerAsync(localLedger,
      db=>verifyHumanWikiFreshWitnessPreflight({
        db,ledgerKey,registryId,witnessPublicKey:publicKey,
        getFreshReceipt:remoteProvider,
      }));
    const genesis=await verifyLocal();
    assert.equal(genesis.ok,true);
    assert.equal(genesis.importAuthorized,false);
    assert.equal(genesis.independentWitnessVerified,false);
    assert.equal(genesis.withdrawalComplete,false);

    const current=withHumanWikiConsentPrivateLedger(localLedger,"write",db=>{
      const appended=appendHumanWikiConsentIntent(db,ledgerKey,{
        ownerUserId:"owner-test",privateAreaId:"personal-unassigned",
      },{
        commandId:randomUUID(),sourceType:"chatgpt_user_export",
        decision:"withdrawal_requested",purpose:"humanwiki_context_bootstrap",
        retentionDays:null,expectedRevision:0,explicitConfirmation:true,
      });
      assert.equal(appended.ok,true);
      const head=humanWikiConsentIntentLocalHead(db,ledgerKey);
      assert.equal(head.ok,true);
      return head;
    });
    const stale=await verifyLocal();
    assert.equal(stale.ok,false);
    assert.equal(stale.importAuthorized,false);
    publishWitnessCheckpoint(dir,registryId,privateKey,{
      sequence:current.sequence,previousDigest:EMPTY,digest:current.digest});
    const restored=await verifyLocal();
    assert.equal(restored.ok,true);
    assert.equal(restored.importAuthorized,false);
    assert.equal(restored.independentWitnessVerified,false);
    assert.equal(restored.withdrawalComplete,false);
    const advanced=await request(good);
    assert.equal(advanced.status,200);
    checkSignature(JSON.parse(advanced.body));
    assert.equal(JSON.parse(advanced.body).sequence,1);
    assert.equal(JSON.parse(advanced.body).digest,current.digest);
    for(const [payload,options] of [
      [{...good,sourceContents:"private"}],
      [{...good,registryId:randomUUID()}],
      [{...good,nonce:"invalid"}],
      [good,{path:"/v1/humanwiki/high-water/challenge?raw=yes"}],
      [good,{method:"GET"}],
      [good,{contentType:"text/plain"}],
      [good,{headers:{authorization:"Bearer forged"}}],
      [good,{headers:{cookie:"owner=token"}}],
      ["x".repeat(300)],
      ["{invalid"],
    ]){
      const result=await request(payload,options);
      assert.equal(result.status,404);
      assert.equal(result.headers["cache-control"],"no-store");
      assert.ok(!result.body.includes(current.digest));
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});
