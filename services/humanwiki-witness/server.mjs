/**
 * Independent-host, read-only HTTPS endpoint for live Lumi challenge responses.
 * No HTTP endpoint publishes a checkpoint or initializes storage.
 * Bind this service to 127.0.0.1 on a DIFFERENT host/recovery domain and put
 * a separately administered TLS reverse proxy/egress policy in front of it.
 */
import https from "node:https";
import { createPrivateKey } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { witnessChallengeReceipt } from "./store.mjs";

const CHALLENGE_PATH = "/v1/humanwiki/high-water/challenge";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE=/^[A-Za-z0-9_-]{43}$/;
const MAX_BYTES=256;
const headers={
  "cache-control":"no-store",
  "x-content-type-options":"nosniff",
  "content-type":"application/json; charset=utf-8",
};
const refusal= res => {
  if (!res.headersSent)res.writeHead(404,headers);
  res.end('{"error":"Not found"}');
};
const isPlainRecord=x=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
  Object.getPrototypeOf(x)===Object.prototype;
const validChallenge=(x,registryId)=>isPlainRecord(x)&&
  Object.keys(x).sort().join(",")==="nonce,registryId"&&
  x.registryId===registryId&&typeof x.nonce==="string"&&
  NONCE.test(x.nonce)&&
  Buffer.from(x.nonce,"base64url").toString("base64url")===x.nonce;
async function readBoundedJson(req) {
  const declared=req.headers["content-length"];
  if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BYTES))
    throw Error("invalid");
  const chunks=[];
  let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>MAX_BYTES)throw Error("invalid");
    chunks.push(chunk);
  }
  if(!size)throw Error("invalid");
  return JSON.parse(new TextDecoder("utf-8",{fatal:true})
    .decode(Buffer.concat(chunks,size)));
}

/**
 * Read-only anonymous challenge: returns only signed global sequence/digest,
 * never user IDs, scopes, content or private key bytes.
 * Server-level bounded request and rate limits limit signing oracle abuse.
 */
export function createWitnessRequestHandler({directory,registryId,privateKey}) {
  if(typeof registryId!=="string"||!UUID.test(registryId)||
      typeof directory!=="string"||!privateKey)throw Error("witness_unavailable");
  let resetAt=0,count=0;
  return async(req,res)=>{
    try {
      const now=Date.now();
      if(now>=resetAt){resetAt=now+60_000;count=0;}
      if(++count>60||req.method!=="POST"||req.url!==CHALLENGE_PATH||
          req.headers["content-type"]!=="application/json"||
          (req.headers.origin!==undefined)||
          req.headers.authorization!==undefined||
          req.headers.cookie!==undefined) return refusal(res);
      const parsed=await readBoundedJson(req);
      if(!validChallenge(parsed,registryId))return refusal(res);
      const receipt=witnessChallengeReceipt(directory,registryId,privateKey,
        parsed.nonce);
      const bytes=Buffer.from(JSON.stringify(receipt),"utf8");
      if(bytes.length>1024)return refusal(res);
      res.writeHead(200,{...headers,"content-length":String(bytes.length)});
      res.end(bytes);
    } catch { refusal(res); }
  };
}
export function createWitnessHttpsServer({directory,registryId,privateKey,tlsKey,tlsCert}) {
  const handler=createWitnessRequestHandler({directory,registryId,privateKey});
  if(!tlsKey||!tlsCert)throw Error("witness_unavailable");
  const server=https.createServer({
    key:tlsKey,cert:tlsCert,
    minVersion:"TLSv1.2",
    requestCert:false,
  },handler);
  server.requestTimeout=2_000;
  server.headersTimeout=2_000;
  server.keepAliveTimeout=1_000;
  server.maxRequestsPerSocket=64;
  return server;
}
export function readProtectedWitnessFile(file) {
  if(typeof file!=="string"||!path.isAbsolute(file)||
      path.normalize(file)!==file||
      typeof process.getuid!=="function")throw Error("witness_unavailable");
  const st=lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||
      st.uid!==process.getuid()||(st.mode&0o177)!==0||
      realpathSync(file)!==file)throw Error("witness_unavailable");
  return readFileSync(file);
}
export function loadWitnessSigningKey(file) {
  return createPrivateKey(readProtectedWitnessFile(file));
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
  const directory=process.env.HUMANWIKI_WITNESS_STORAGE_DIRECTORY;
  const registryId=process.env.HUMANWIKI_WITNESS_REGISTRY_ID;
  const ip=process.env.HUMANWIKI_WITNESS_LISTEN_IP;
  const port=Number(process.env.HUMANWIKI_WITNESS_LISTEN_PORT);
  if(ip!=="127.0.0.1"||!Number.isSafeInteger(port)||
      port<1024||port>65535)throw Error("witness must bind a privileged-host loopback");
  const privateKey=loadWitnessSigningKey(
    process.env.HUMANWIKI_WITNESS_SIGNING_KEY_FILE);
  const tlsKey=readProtectedWitnessFile(
    process.env.HUMANWIKI_WITNESS_TLS_KEY_FILE);
  const tlsCert=readProtectedWitnessFile(
    process.env.HUMANWIKI_WITNESS_TLS_CERT_FILE);
  const server=createWitnessHttpsServer({
    directory,registryId,privateKey,tlsKey,tlsCert,
  });
  server.listen(port,ip);
}
