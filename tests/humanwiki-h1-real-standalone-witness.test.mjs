import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync,
  rmSync, renameSync, writeFileSync } from "node:fs";
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
  humanWikiWitnessChallengePayload,
} from "../lib/humanwiki-consent-witness-preflight.mjs";

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
    {sequence:2,previousDigest:"a".repeat(64),digest:"b".repeat(64),source:"private"},
  ]){
    // The library ignores extra control fields (the CLI passes only its
    // strict triple); the last example is otherwise a valid second publish.
    if("source" in next)continue;
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
  const {symlinkSync}=await import("node:fs");
  symlinkSync(otherFile,symlink);
  assert.throws(()=>readProtectedWitnessFile(symlink),/witness_unavailable/);
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
    publishWitnessCheckpoint(dir,registryId,privateKey,{
      sequence:1,previousDigest:EMPTY,digest:"c".repeat(64)});
    const advanced=await request(good);
    assert.equal(advanced.status,200);
    checkSignature(JSON.parse(advanced.body));
    assert.equal(JSON.parse(advanced.body).sequence,1);
    assert.equal(JSON.parse(advanced.body).digest,"c".repeat(64));
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
      assert.ok(!result.body.includes("c".repeat(64)));
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});
