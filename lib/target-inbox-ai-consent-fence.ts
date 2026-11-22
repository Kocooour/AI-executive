/**
 * C-3b durable, cross-process AI dispatch/revocation fence primitive.
 *
 * The caller MUST use a separate, explicitly provisioned SQLite database
 * OUTSIDE the target store's backup/restore domain. Never create/open a new
 * fence file as an HTTP side effect: missing/invalid fence means AI OFF.
 *
 * This module is NOT the target-store consent record, HTTP settings route,
 * production activation, an authenticated session, or an OpenAI caller.
 * Both the target-store grant and this independent monotonic fence MUST agree.
 *
 * A pending dispatch is registered before fetch and removed only after its
 * provider promise settles or is aborted. Revoke marks the grant inactive
 * immediately and is "confirmed" only when every earlier pending ticket is
 * drained. Crash/orphaned tickets fail closed until operator reconciliation;
 * do not expire them to claim revocation while a worker might still dispatch.
 */
import {randomBytes} from "node:crypto";
import {lstatSync,realpathSync} from "node:fs";
import path from "node:path";
import type {DatabaseSync} from "node:sqlite";

const ACTOR=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TICKET=/^[a-f0-9]{48}$/;
const VERSION=1;
const GLOBAL_IN_FLIGHT=4;
const ACTOR_IN_FLIGHT=1;
const GLOBAL_PER_MINUTE=12;
const ACTOR_PER_MINUTE=3;
const MAX_TS=9007199254740000;

export type InboxAIFenceGrant={
  actorUserId:string;restoreGeneration:string;dataScopeVersion:string;
  epoch:number;active:boolean;
};
export type InboxAIFenceTicket={
  id:string;actorUserId:string;epoch:number;
  restoreGeneration:string;dataScopeVersion:string;
};
const validEpoch=(x:unknown):x is number=>typeof x==="number"&&
  Number.isSafeInteger(x)&&x>=0;
const validTime=(x:unknown):x is number=>typeof x==="number"&&
  Number.isSafeInteger(x)&&x>0&&x<MAX_TS;
const validScope=(x:unknown):x is string=>typeof x==="string"&&
  /^[A-Za-z0-9_.:-]{1,64}$/.test(x);
const validRequest=(actor:string,gen:string,scope:string,now:number)=>
  typeof actor==="string"&&ACTOR.test(actor)&&typeof gen==="string"&&UUID.test(gen)&&
  validScope(scope)&&validTime(now);

/**
 * Resolve the physical external fence DB path without following a symlink.
 * The caller opens DatabaseSync ONLY when this returns a path; a missing file
 * MUST NOT be auto-created on a server request or after target-store restore.
 */
export function verifiedInboxAIFencePath(
  fencePath:string,targetStagingDirectory:string,
):string|null{
  if(typeof fencePath!=="string"||!path.isAbsolute(fencePath)||
     typeof targetStagingDirectory!=="string"||
     !path.isAbsolute(targetStagingDirectory))return null;
  try{
    const lst=lstatSync(fencePath);
    if(!lst.isFile()||lst.isSymbolicLink()||(lst.mode&0o077)!==0)return null;
    const actual=realpathSync(fencePath);
    const target=realpathSync(targetStagingDirectory);
    if(actual===target||actual.startsWith(target+path.sep))return null;
    return actual;
  }catch{return null;}
}

/** Explicit provisioning/migration only (never in an HTTP read/fetch path). */
export function provisionInboxAIFenceSchema(db:DatabaseSync):boolean{
  try{
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS inbox_ai_fence_meta (
        k TEXT PRIMARY KEY,v INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS inbox_ai_fence_grants (
        actor TEXT PRIMARY KEY,epoch INTEGER NOT NULL CHECK(epoch>0),
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        restore_generation TEXT NOT NULL,scope_version TEXT NOT NULL,
        owner_decision TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS inbox_ai_fence_decisions (
        actor TEXT NOT NULL,decision TEXT NOT NULL,
        epoch INTEGER NOT NULL,PRIMARY KEY(actor,decision)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS inbox_ai_fence_pending (
        ticket TEXT PRIMARY KEY,actor TEXT NOT NULL,
        epoch INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,
        FOREIGN KEY(actor) REFERENCES inbox_ai_fence_grants(actor)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS inbox_ai_pending_by_actor
        ON inbox_ai_fence_pending(actor);
      CREATE TABLE IF NOT EXISTS inbox_ai_fence_budgets (
        bucket_key TEXT PRIMARY KEY,minute INTEGER NOT NULL,
        hits INTEGER NOT NULL CHECK(hits>=0)
      ) WITHOUT ROWID;
      INSERT OR IGNORE INTO inbox_ai_fence_meta(k,v) VALUES('schema_version',1);
      COMMIT;`);
    return db.prepare("SELECT v FROM inbox_ai_fence_meta WHERE k='schema_version'")
      .get()?.v===VERSION;
  }catch{
    try{if(db.isTransaction)db.exec("ROLLBACK");}catch{}
    return false;
  }
}

const healthy=(db:DatabaseSync):boolean=>{
  try{return db.prepare("SELECT v FROM inbox_ai_fence_meta WHERE k='schema_version'")
    .get()?.v===VERSION;}catch{return false;}
};
function immediate<T>(db:DatabaseSync,body:()=>T):T|null{
  if(!healthy(db))return null;
  try{
    db.exec("BEGIN IMMEDIATE");
    const out=body();
    db.exec("COMMIT");
    return out;
  }catch{
    try{if(db.isTransaction)db.exec("ROLLBACK");}catch{}
    return null;
  }
}
type GrantRow={
  actor:string;epoch:number;active:number;restore_generation:string;
  scope_version:string;owner_decision:string;
};
const grantRow=(db:DatabaseSync,actor:string)=>
  db.prepare("SELECT actor,epoch,active,restore_generation,scope_version,owner_decision FROM inbox_ai_fence_grants WHERE actor=?")
    .get(actor) as GrantRow|undefined;

/**
 * Requires a separate, explicit verified target-store grant/owner decision
 * before calling this privileged method. No auto-grants on restart/restore.
 */
export function recordExplicitInboxAIGrant(
  db:DatabaseSync,actorUserId:string,ownerUserId:string,
  restoreGeneration:string,dataScopeVersion:string,
  decisionId:string,
):InboxAIFenceGrant|null{
  if(!validRequest(actorUserId,restoreGeneration,dataScopeVersion,Date.now())||
     actorUserId!==ownerUserId||!validScope(decisionId))return null;
  return immediate(db,()=>{
    const existing=grantRow(db,actorUserId);
    if(existing?.active===1){
      if(existing.restore_generation!==restoreGeneration.toLowerCase()||
         existing.scope_version!==dataScopeVersion||
         existing.owner_decision!==decisionId)return null;
      return {actorUserId,epoch:existing.epoch,active:true,
        restoreGeneration:existing.restore_generation,
        dataScopeVersion:existing.scope_version};
    }
    // A revoked principal must ONLY be re-granted after a DISTINCT new
    // explicit owner decision. All prior decisions are immutable and
    // never reusable (including decision v1 after grant/revoke v2/v3).
    if(existing?.owner_decision===decisionId||
      db.prepare("SELECT 1 FROM inbox_ai_fence_decisions WHERE actor=? AND decision=?")
        .get(actorUserId,decisionId))return null;
    // Do not re-enable while previous workers are still draining: the old
    // pending tickets must remain a permanent revocation barrier on crash.
    const pending=db.prepare("SELECT COUNT(*) AS n FROM inbox_ai_fence_pending WHERE actor=?")
      .get(actorUserId) as {n:number};
    if(pending.n!==0)return null;
    const epoch=existing?existing.epoch+1:1;
    if(!Number.isSafeInteger(epoch))return null;
    db.prepare(`INSERT INTO inbox_ai_fence_grants
      (actor,epoch,active,restore_generation,scope_version,owner_decision)
      VALUES(?,?,1,?,?,?)
      ON CONFLICT(actor) DO UPDATE SET epoch=excluded.epoch,active=1,
        restore_generation=excluded.restore_generation,
        scope_version=excluded.scope_version,
        owner_decision=excluded.owner_decision`)
      .run(actorUserId,epoch,restoreGeneration.toLowerCase(),
        dataScopeVersion,decisionId);
    db.prepare("INSERT INTO inbox_ai_fence_decisions(actor,decision,epoch) VALUES(?,?,?)")
      .run(actorUserId,decisionId,epoch);
    return {actorUserId,epoch,active:true,
      restoreGeneration:restoreGeneration.toLowerCase(),dataScopeVersion};
  });
}
export function readInboxAIFenceGrant(
  db:DatabaseSync,actorUserId:string,
):InboxAIFenceGrant|null{
  if(!ACTOR.test(actorUserId)||!healthy(db))return null;
  try{
    const r=grantRow(db,actorUserId);
    return r&&validEpoch(r.epoch)&&r.epoch>0&&(r.active===0||r.active===1)&&
      UUID.test(r.restore_generation)&&validScope(r.scope_version)
      ?{actorUserId,epoch:r.epoch,active:r.active===1,
        restoreGeneration:r.restore_generation,dataScopeVersion:r.scope_version}
      :null;
  }catch{return null;}
}

/** Revoke takes effect immediately but returns drained=false until safe. */
export function revokeInboxAIConsent(
  db:DatabaseSync,actorUserId:string,
):{epoch:number;drained:boolean}|null{
  if(!ACTOR.test(actorUserId))return null;
  return immediate(db,()=>{
    const r=grantRow(db,actorUserId);
    if(!r||!validEpoch(r.epoch))return null;
    const epoch=r.active===1?r.epoch+1:r.epoch;
    if(!Number.isSafeInteger(epoch))return null;
    db.prepare("UPDATE inbox_ai_fence_grants SET active=0,epoch=? WHERE actor=?")
      .run(epoch,actorUserId);
    const pending=db.prepare("SELECT COUNT(*) AS n FROM inbox_ai_fence_pending WHERE actor=?")
      .get(actorUserId) as {n:number};
    return {epoch,drained:pending.n===0};
  });
}
/** A confirmed revoke requires drained=true. NEVER delete orphaned tickets. */
export function inboxAIRevokeDrained(
  db:DatabaseSync,actorUserId:string,expectedEpoch:number,
):boolean{
  if(!ACTOR.test(actorUserId)||!validEpoch(expectedEpoch)||!healthy(db))return false;
  try{
    const r=grantRow(db,actorUserId);
    const pending=db.prepare("SELECT COUNT(*) AS n FROM inbox_ai_fence_pending WHERE actor=?")
      .get(actorUserId) as {n:number};
    return Boolean(r&&r.active===0&&r.epoch===expectedEpoch&&pending.n===0);
  }catch{return false;}
}

export function beginInboxAIDispatch(
  db:DatabaseSync,actorUserId:string,restoreGeneration:string,
  dataScopeVersion:string,nowMs=Date.now(),
):InboxAIFenceTicket|null{
  if(!validRequest(actorUserId,restoreGeneration,dataScopeVersion,nowMs))return null;
  return immediate(db,()=>{
    const r=grantRow(db,actorUserId);
    if(!r||r.active!==1||r.epoch<=0||
       r.restore_generation!==restoreGeneration.toLowerCase()||
       r.scope_version!==dataScopeVersion)return null;
    const count=db.prepare("SELECT COUNT(*) AS n FROM inbox_ai_fence_pending")
      .get() as {n:number};
    const actorCount=db.prepare("SELECT COUNT(*) AS n FROM inbox_ai_fence_pending WHERE actor=?")
      .get(actorUserId) as {n:number};
    if(count.n>=GLOBAL_IN_FLIGHT||actorCount.n>=ACTOR_IN_FLIGHT)return null;
    const minute=Math.floor(nowMs/60000);
    // All calls use the same separate DB transaction, so the fixed budgets
    // work across processes and are not bypassed by concurrent workers.
    for(const [budgetKey,cap] of [["g",GLOBAL_PER_MINUTE],
      ["a:"+actorUserId,ACTOR_PER_MINUTE]] as const){
      const hit=db.prepare("SELECT minute,hits FROM inbox_ai_fence_budgets WHERE bucket_key=?")
        .get(budgetKey) as {minute:number;hits:number}|undefined;
      if(hit&&hit.minute===minute&&hit.hits>=cap)return null;
    }
    for(const budgetKey of ["g","a:"+actorUserId]){
      const hit=db.prepare("SELECT minute,hits FROM inbox_ai_fence_budgets WHERE bucket_key=?")
        .get(budgetKey) as {minute:number;hits:number}|undefined;
      db.prepare(`INSERT INTO inbox_ai_fence_budgets(bucket_key,minute,hits)
        VALUES(?,?,?) ON CONFLICT(bucket_key) DO UPDATE SET
        minute=excluded.minute,hits=excluded.hits`)
        .run(budgetKey,minute,hit&&hit.minute===minute?hit.hits+1:1);
    }
    const id=randomBytes(24).toString("hex");
    db.prepare("INSERT INTO inbox_ai_fence_pending(ticket,actor,epoch,created_at_ms) VALUES(?,?,?,?)")
      .run(id,actorUserId,r.epoch,nowMs);
    return {id,actorUserId,epoch:r.epoch,
      restoreGeneration:r.restore_generation,dataScopeVersion:r.scope_version};
  });
}
/**
 * Recheck immediately before fetch (after pending registration). Revoke may
 * happen after this check, but cannot be CONFIRMED while this ticket remains.
 * The external HTTP caller must release this ticket on promise settlement.
 */
export function inboxAIDispatchStillAllowed(
  db:DatabaseSync,ticket:InboxAIFenceTicket,
):boolean{
  if(!ticket||!TICKET.test(ticket.id)||!ACTOR.test(ticket.actorUserId)||
     !validEpoch(ticket.epoch)||!healthy(db))return false;
  try{
    const r=grantRow(db,ticket.actorUserId);
    const pending=db.prepare("SELECT 1 AS ok FROM inbox_ai_fence_pending WHERE ticket=? AND actor=? AND epoch=?")
      .get(ticket.id,ticket.actorUserId,ticket.epoch);
    return Boolean(pending&&r&&r.active===1&&r.epoch===ticket.epoch&&
      r.restore_generation===ticket.restoreGeneration&&
      r.scope_version===ticket.dataScopeVersion);
  }catch{return false;}
}
/** Remove pending and report whether the late result is still allowed. */
export function endInboxAIDispatch(
  db:DatabaseSync,ticket:InboxAIFenceTicket,
):boolean{
  if(!ticket||!TICKET.test(ticket.id)||!ACTOR.test(ticket.actorUserId))return false;
  const outcome=immediate(db,()=>{
    const permitted=inboxAIDispatchStillAllowed(db,ticket);
    const result=db.prepare("DELETE FROM inbox_ai_fence_pending WHERE ticket=? AND actor=? AND epoch=?")
      .run(ticket.id,ticket.actorUserId,ticket.epoch);
    return result.changes===1&&permitted;
  });
  return outcome===true;
}
