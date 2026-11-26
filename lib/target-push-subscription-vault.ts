/** E-2: the target push device secrets (endpoint, p256dh, auth) in the app SQLite.
 *
 * The canonical target store keeps only the SHA-256 of a device endpoint and its
 * owner; ownership is decided there. This vault only holds the secrets needed to
 * actually deliver, keyed by that hash. A row is written only after the target
 * store accepted (or already held) the actor's own live device, and rows whose hash
 * is no longer a live target are pruned by the push scheduler. The table is
 * excluded from every backup and export (lib/backup-scope.ts) and never logged. */
import type {DatabaseSync} from "node:sqlite";
import {targetPushEndpointHash,targetPushSubscription} from "./target-push-endpoint";
import type {TargetPushSubscription} from "./target-push-endpoint";

const HASH=/^[0-9a-f]{64}$/;
/** Matches the target store's global device capacity. */
export const TARGET_PUSH_VAULT_MAX_ROWS=4096;
/** A freshly written row is never pruned before the canonical write can be observed. */
export const TARGET_PUSH_VAULT_PRUNE_GRACE_MS=10*60_000;

export interface TargetPushVaultRow extends TargetPushSubscription {readonly endpointHash:string}

export function upsertTargetPushSubscription(
  db:DatabaseSync,endpointHash:string,subscription:TargetPushSubscription,nowMs=Date.now(),
):boolean {
  // Only a valid secret whose endpoint really has this hash is ever stored.
  const valid=targetPushSubscription({endpoint:subscription.endpoint,
    keys:{p256dh:subscription.p256dh,auth:subscription.auth}});
  if(!HASH.test(endpointHash)||!valid||targetPushEndpointHash(valid.endpoint)!==endpointHash)return false;
  const existing=db.prepare("SELECT 1 FROM target_push_subscriptions WHERE endpoint_hash=?").get(endpointHash);
  if(!existing){
    const count=(db.prepare("SELECT COUNT(*) AS n FROM target_push_subscriptions").get() as {n:number}).n;
    if(count>=TARGET_PUSH_VAULT_MAX_ROWS)return false;
  }
  return db.prepare(
    "INSERT INTO target_push_subscriptions(endpoint_hash,endpoint,p256dh,auth,updated_at) VALUES (?,?,?,?,?) "+
    "ON CONFLICT(endpoint_hash) DO UPDATE SET endpoint=excluded.endpoint,p256dh=excluded.p256dh,"+
    "auth=excluded.auth,updated_at=excluded.updated_at",
  ).run(endpointHash,subscription.endpoint,subscription.p256dh,subscription.auth,nowMs).changes===1;
}

export function readTargetPushSubscription(db:DatabaseSync,endpointHash:string):TargetPushVaultRow|null {
  if(!HASH.test(endpointHash))return null;
  const row=db.prepare(
    "SELECT endpoint_hash AS endpointHash,endpoint,p256dh,auth FROM target_push_subscriptions WHERE endpoint_hash=?",
  ).get(endpointHash) as unknown as TargetPushVaultRow|undefined;
  return row??null;
}

export function listTargetPushSubscriptions(db:DatabaseSync):TargetPushVaultRow[] {
  return db.prepare(
    "SELECT endpoint_hash AS endpointHash,endpoint,p256dh,auth FROM target_push_subscriptions "+
    "ORDER BY endpoint_hash LIMIT ?",
  ).all(TARGET_PUSH_VAULT_MAX_ROWS) as unknown as TargetPushVaultRow[];
}

/** Forget secrets whose device is no longer live in the target store. Rows touched
 * within the grace period are kept, so a registration that is just being committed
 * cannot lose its secret. Returns the number of removed rows. */
export function pruneTargetPushSubscriptions(
  db:DatabaseSync,liveHashes:ReadonlySet<string>,nowMs=Date.now(),
):number {
  const rows=db.prepare("SELECT endpoint_hash AS h,updated_at AS t FROM target_push_subscriptions")
    .all() as {h:string;t:number}[];
  const remove=db.prepare("DELETE FROM target_push_subscriptions WHERE endpoint_hash=? AND updated_at=?");
  let removed=0;
  for(const row of rows){
    if(liveHashes.has(row.h)||row.t>nowMs-TARGET_PUSH_VAULT_PRUNE_GRACE_MS)continue;
    removed+=Number(remove.run(row.h,row.t).changes);
  }
  return removed;
}

export function deleteTargetPushSubscription(db:DatabaseSync,endpointHash:string):void {
  if(HASH.test(endpointHash))
    db.prepare("DELETE FROM target_push_subscriptions WHERE endpoint_hash=?").run(endpointHash);
}
