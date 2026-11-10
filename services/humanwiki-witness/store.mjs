/**
 * Standalone H1-real.5 witness reference store. This module MUST be deployed
 * to a separately administered recovery domain, never on the Lumi VPS.
 *
 * An offline operator publishes opaque, strictly increasing checkpoints.
 * The network listener is read-only and signs ONLY its current durable head.
 * This does not implement the app-side write-before-ack protocol or hardware-
 * protected antirollback. A restored witness database must never be trusted
 * without independent reconciliation.
 */
import { KeyObject, createPublicKey, sign, verify } from "node:crypto";
import {
  constants, closeSync, fsyncSync, lstatSync, openSync, realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  humanWikiWitnessChallengePayload,
} from "../../lib/humanwiki-consent-witness-preflight.mjs";

const FILENAME = "witness-high-water.sqlite";
const EMPTY = "0".repeat(64);
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENTS = 10000;
const DEFINITIONS = [
  { name:"witness_high_water_events",type:"table",sql:`CREATE TABLE IF NOT EXISTS witness_high_water_events (
    sequence INTEGER PRIMARY KEY CHECK(sequence >= 0),
    registry_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    previous_digest TEXT NOT NULL,
    signature TEXT NOT NULL
  )` },
  { name:"witness_high_water_no_update",type:"trigger",sql:`CREATE TRIGGER IF NOT EXISTS witness_high_water_no_update
    BEFORE UPDATE ON witness_high_water_events
    BEGIN SELECT RAISE(ABORT,'append_only'); END` },
  { name:"witness_high_water_no_delete",type:"trigger",sql:`CREATE TRIGGER IF NOT EXISTS witness_high_water_no_delete
    BEFORE DELETE ON witness_high_water_events
    BEGIN SELECT RAISE(ABORT,'append_only'); END` },
];
const uid = () => typeof process.getuid === "function" ? process.getuid() : null;
const safeDirectory = dir => {
  if (typeof dir !== "string" || !path.isAbsolute(dir) ||
      path.normalize(dir) !== dir || uid() === null) return false;
  const st = lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid() &&
    (st.mode & 0o077) === 0 && realpathSync(dir) === dir;
};
const identity = file => {
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
      st.uid !== uid() || (st.mode & 0o177) !== 0 ||
      realpathSync(file) !== file) throw Error("witness_unavailable");
  return { dev: st.dev, ino: st.ino };
};
const sidecarsAbsent = file => {
  for (const tail of ["-wal","-shm"]) {
    try { lstatSync(file+tail); return false; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return true;
};
const publicKeyOf = privateKey => {
  if (!(privateKey instanceof KeyObject) ||
      !KeyObject.prototype.equals.call(privateKey,privateKey) ||
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519") throw Error("witness_unavailable");
  return createPublicKey(privateKey);
};
const validRegistry = id => typeof id === "string" && UUID.test(id);
const rowPayload = (registryId,sequence,previousDigest,digest) =>
  Buffer.from(["humanwiki_witness_monotonic_event_v1",registryId,
    String(sequence),previousDigest,digest,""].join("\n"),"utf8");
const validSignature = signature =>
  typeof signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(signature) &&
  Buffer.from(signature,"base64url").toString("base64url") === signature;

const schemaCheck = db => {
  const rows = db.prepare(`SELECT name,type,sql FROM sqlite_master
    WHERE name IN ('witness_high_water_events','witness_high_water_no_update',
      'witness_high_water_no_delete')`).all();
  if (rows.length !== DEFINITIONS.length) throw Error("witness_unavailable");
  const byName = new Map(rows.map(row => [row.name,row]));
  for (const definition of DEFINITIONS) {
    const row = byName.get(definition.name);
    if (!row || row.type !== definition.type ||
        row.sql !== definition.sql.replace(" IF NOT EXISTS "," "))
      throw Error("witness_unavailable");
  }
};
const createSchema = db => {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const d of DEFINITIONS) db.exec(d.sql+";");
    schemaCheck(db);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* fail closed */ }
    throw error;
  }
};
const checkDatabase = db => {
  if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete" ||
      Object.values(db.prepare("PRAGMA quick_check").get() ?? {})[0] !== "ok")
    throw Error("witness_unavailable");
  schemaCheck(db);
};
function verifyRows(db, registryId, publicKey) {
  checkDatabase(db);
  const rows = db.prepare(`SELECT sequence,registry_id,digest,previous_digest,signature
    FROM witness_high_water_events ORDER BY sequence LIMIT ?`).all(MAX_EVENTS+1);
  if (!rows.length || rows.length > MAX_EVENTS) throw Error("witness_unavailable");
  let previous = EMPTY;
  for (let i=0;i<rows.length;i++) {
    const row=rows[i];
    if (row.sequence !== i || row.registry_id !== registryId ||
        typeof row.digest !== "string" || !HEX.test(row.digest) ||
        row.previous_digest !== previous || !validSignature(row.signature) ||
        (i === 0 && row.digest !== EMPTY) ||
        !verify(null,rowPayload(registryId,i,previous,row.digest),publicKey,
          Buffer.from(row.signature,"base64url")))
      throw Error("witness_unavailable");
    previous=row.digest;
  }
  const tail=rows[rows.length-1];
  return { sequence:tail.sequence,digest:tail.digest };
}
function openExisting(directory,mode,fn) {
  if (!safeDirectory(directory) || !sidecarsAbsent(path.join(directory,FILENAME)))
    throw Error("witness_unavailable");
  const file=path.join(directory,FILENAME),before=identity(file);
  const db=new DatabaseSync(file,{readOnly:mode==="read"});
  try {
    if (mode==="write")db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000");
    const result=fn(db);
    const after=identity(file);
    if (!safeDirectory(directory) || !sidecarsAbsent(file) ||
        before.dev!==after.dev || before.ino!==after.ino)
      throw Error("witness_unavailable");
    return result;
  } finally { db.close(); }
}
export function bootstrapWitnessStore(directory,registryId,privateKey) {
  const pub=publicKeyOf(privateKey);
  if (!validRegistry(registryId) || !safeDirectory(directory))throw Error("witness_unavailable");
  const file=path.join(directory,FILENAME);
  if (!sidecarsAbsent(file))throw Error("witness_unavailable");
  const fd=openSync(file,
    constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_RDWR,0o600);
  closeSync(fd);
  const before=identity(file);
  const db=new DatabaseSync(file);
  try {
    db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000");
    checkInitialJournal(db);
    createSchema(db);
    const signature=sign(null,rowPayload(registryId,0,EMPTY,EMPTY),privateKey).toString("base64url");
    db.prepare(`INSERT INTO witness_high_water_events
      (sequence,registry_id,digest,previous_digest,signature) VALUES (0,?,?,?,?)`)
      .run(registryId,EMPTY,EMPTY,signature);
    verifyRows(db,registryId,pub);
  } finally {db.close();}
  const dirfd=openSync(directory,
    constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {fsyncSync(dirfd);}finally{closeSync(dirfd);}
  const after=identity(file);
  if(before.dev!==after.dev||before.ino!==after.ino||
      !sidecarsAbsent(file)||!safeDirectory(directory))throw Error("witness_unavailable");
  return {ok:true,sequence:0,importAuthorized:false,withdrawalComplete:false};
}
function checkInitialJournal(db) {
  if(db.prepare("PRAGMA journal_mode").get()?.journal_mode!=="delete")
    throw Error("witness_unavailable");
}
export function witnessCurrentHead(directory,registryId,privateKey) {
  const pub=publicKeyOf(privateKey);
  if(!validRegistry(registryId))throw Error("witness_unavailable");
  return openExisting(directory,"read",db=>verifyRows(db,registryId,pub));
}
/**
 * Operator-only local publish, NEVER exposed as an HTTP write route.
 * Requires the *next* sequence and exact previous digest, and commits the
 * witness-signed event under a SQLite immediate write lock.
 * It does not prove the source event has committed: app-side durable ack and
 * an external antirestore anchor are separately required.
 */
export function publishWitnessCheckpoint(directory,registryId,privateKey,
  {sequence,previousDigest,digest}={}) {
  const pub=publicKeyOf(privateKey);
  if(!validRegistry(registryId)||!Number.isSafeInteger(sequence)||
      sequence<1||sequence>=MAX_EVENTS||!HEX.test(previousDigest)||
      !HEX.test(digest))throw Error("witness_unavailable");
  return openExisting(directory,"write",db=>{
    db.exec("BEGIN IMMEDIATE");
    try{
      const current=verifyRows(db,registryId,pub);
      if(sequence!==current.sequence+1||previousDigest!==current.digest)
        throw Error("witness_unavailable");
      const signature=sign(null,
        rowPayload(registryId,sequence,previousDigest,digest),
        privateKey).toString("base64url");
      db.prepare(`INSERT INTO witness_high_water_events
        (sequence,registry_id,digest,previous_digest,signature)
        VALUES (?,?,?,?,?)`).run(sequence,registryId,digest,previousDigest,signature);
      verifyRows(db,registryId,pub);
      db.exec("COMMIT");
      return {ok:true,sequence,digest,importAuthorized:false,
        independentWitnessVerified:false,withdrawalComplete:false};
    }catch(error){
      try{db.exec("ROLLBACK");}catch{/* fail closed */}
      throw error;
    }
  });
}
export function witnessChallengeReceipt(directory,registryId,privateKey,nonce) {
  const pub=publicKeyOf(privateKey);
  if(!validRegistry(registryId)||typeof nonce!=="string"||
      !/^[A-Za-z0-9_-]{43}$/.test(nonce)||
      Buffer.from(nonce,"base64url").toString("base64url")!==nonce)
    throw Error("witness_unavailable");
  const head=witnessCurrentHead(directory,registryId,privateKey);
  return {
    version:"humanwiki_h1_real_fresh_high_water_preflight_v1",
    registryId,nonce,sequence:head.sequence,digest:head.digest,
    signature:sign(null,humanWikiWitnessChallengePayload(
      registryId,nonce,head.sequence,head.digest),privateKey).toString("base64url"),
  };
}
