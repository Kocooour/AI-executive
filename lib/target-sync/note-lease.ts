/**
 * R2d note-only cross-tab write-fencing primitive.
 *
 * This does NOT activate the persistent note client or grant authorization.
 * A lease is per entire note metadata database, not per Area, because an actor
 * switch purges all other note partitions. A future client must route ALL
 * activate/purge/checkpoint writes through one guarded transaction protocol.
 *
 * Claim, renewal and checkpoint commit are serialized in the SAME IndexedDB
 * object store, so a slow former owner cannot overwrite a newer owner's data.
 * The lease is global to the database, not to this JavaScript instance.
 */
import { decodeNoteSyncCheckpoint } from "./note-pages";

const DB_VERSION = 1;
const MARKERS = "namespaces";
const RECORDS = "records";
const LEASE_KEY = ["\u0000lumi-note-metadata-lease-v1", "owner"];
const PREFIX = "lumi-note-metadata-v1|";
const CHECKPOINT_KEY = "checkpoint";
const TTL_MS = 30_000;

type LeaseRow = { version: 1; owner: string | null; epoch: number; expiresAt: number };
export type NoteLeaseToken = Readonly<{ owner: string; epoch: number }>;
export type NoteLeaseClaim =
  | { kind: "acquired"; lease: NoteLeaseToken }
  | { kind: "busy" };

function exactKeys(value: Record<string, unknown>, names: string): boolean {
  return Object.keys(value).sort().join(",") === names;
}
function row(value: unknown): LeaseRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  return exactKeys(r, "epoch,expiresAt,owner,version") &&
    r.version === 1 && (r.owner === null ||
      (typeof r.owner === "string" && /^[a-f0-9-]{36}$/.test(r.owner))) &&
    Number.isSafeInteger(r.epoch) && (r.epoch as number) >= 1 &&
    Number.isSafeInteger(r.expiresAt) && (r.expiresAt as number) >= 0
    ? r as LeaseRow : null;
}
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("note_lease_request_failed"));
  });
}
function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("note_lease_transaction_aborted"));
    tx.onerror = () => { /* abort delivers terminal result */ };
  });
}
async function transact<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  action: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  const done = finished(tx);
  try {
    const value = await action(tx);
    await done;
    return value;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted or completed */ }
    await done.catch(() => undefined);
    throw error;
  }
}
function scopeNamespace(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const scope = value as Record<string, unknown>;
  if (!exactKeys(scope, "areaId,restoreGeneration,userId") ||
      typeof scope.userId !== "string" || typeof scope.areaId !== "string" ||
      typeof scope.restoreGeneration !== "string" ||
      !/^[A-Za-z0-9_.:@-]{1,120}$/.test(scope.userId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scope.restoreGeneration) ||
      !scope.areaId || scope.areaId.trim() !== scope.areaId ||
      scope.areaId === "." || scope.areaId === ".." ||
      !scope.areaId.isWellFormed() ||
      new TextEncoder().encode(scope.areaId).length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(scope.areaId)) return null;
  return PREFIX + [scope.userId, scope.restoreGeneration, scope.areaId]
    .map(encodeURIComponent).join("|");
}
function validCheckpoint(value: unknown, namespace: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return exactKeys(v, "scope,state,version") && v.version === 1 &&
    scopeNamespace(v.scope) === namespace &&
    decodeNoteSyncCheckpoint(v.state) !== null;
}
function validToken(lease: NoteLeaseToken): boolean {
  return !!lease && typeof lease.owner === "string" &&
    /^[a-f0-9-]{36}$/.test(lease.owner) &&
    Number.isSafeInteger(lease.epoch) && lease.epoch > 0;
}

/** Uses the SAME existing v1 records + namespaces stores as the isolated note
 * cache. No IndexedDB schema migration and no task sync database access. */
export class IndexedDbNoteMetadataLease {
  private readonly owner = crypto.randomUUID();
  private readonly dbPromise: Promise<IDBDatabase>;
  private readonly now: () => number;

  // Ordinary fields remain executable under Node 22's strip-only TS loader.
  constructor(name = "lumi-note-metadata-v1", now: () => number = Date.now) {
    if (typeof indexedDB === "undefined") throw new Error("indexeddb_unavailable");
    this.now = now;
    this.dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(name, DB_VERSION);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(MARKERS)) r.result.createObjectStore(MARKERS);
        if (!r.result.objectStoreNames.contains(RECORDS)) r.result.createObjectStore(RECORDS);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("note_lease_open_failed"));
      r.onblocked = () => reject(new Error("note_lease_open_blocked"));
    });
  }
  private async db(): Promise<IDBDatabase> { return this.dbPromise; }
  private clock(): number {
    const n = this.now();
    if (!Number.isSafeInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER - TTL_MS)
      throw new Error("note_lease_bad_clock");
    return n;
  }

  /** Only one owner at a time. Expiration increments a durable epoch rather
   * than recycling a stale generation. Acquisition never overwrites a live
   * lease, including one held by another tab with the same authenticated user. */
  async claim(): Promise<NoteLeaseClaim> {
    const db = await this.db();
    return transact(db, [RECORDS], "readwrite", async tx => {
      const store = tx.objectStore(RECORDS);
      const raw = await request(store.get(LEASE_KEY));
      if (raw !== undefined && row(raw) === null) throw new Error("note_lease_corrupt");
      const old = raw === undefined ? null : row(raw)!;
      const now = this.clock();
      if (old?.owner !== null && old !== null && old.expiresAt > now)
        return { kind: "busy" };
      if (old && old.epoch >= Number.MAX_SAFE_INTEGER) throw new Error("note_lease_epoch_exhausted");
      const next: LeaseRow = { version: 1, owner: this.owner,
        epoch: (old?.epoch ?? 0) + 1, expiresAt: now + TTL_MS };
      store.put(next, LEASE_KEY);
      return { kind: "acquired", lease: { owner: this.owner, epoch: next.epoch } };
    });
  }

  /** A paused tab's renewal cannot extend a successor's lease. */
  async renew(lease: NoteLeaseToken): Promise<boolean> {
    if (!validToken(lease) || lease.owner !== this.owner) return false;
    const db = await this.db();
    return transact(db, [RECORDS], "readwrite", async tx => {
      const store = tx.objectStore(RECORDS);
      const raw = await request(store.get(LEASE_KEY));
      const current = row(raw);
      if (!current || current.owner !== lease.owner || current.epoch !== lease.epoch)
        return false;
      const now = this.clock();
      if (current.expiresAt <= now) return false;
      store.put({ ...current, expiresAt: now + TTL_MS } satisfies LeaseRow, LEASE_KEY);
      return true;
    });
  }

  /** Release preserves the epoch; a previous owner cannot release its successor. */
  async release(lease: NoteLeaseToken): Promise<boolean> {
    if (!validToken(lease) || lease.owner !== this.owner) return false;
    const db = await this.db();
    return transact(db, [RECORDS], "readwrite", async tx => {
      const store = tx.objectStore(RECORDS);
      const current = row(await request(store.get(LEASE_KEY)));
      if (!current || current.owner !== lease.owner || current.epoch !== lease.epoch)
        return false;
      store.put({ ...current, owner: null, expiresAt: 0 } satisfies LeaseRow, LEASE_KEY);
      return true;
    });
  }

  /** Only note-cache namespaces may be touched; the sentinel lease row and
   * other database records are never part of a namespace purge. */
  private namespace(name: string): void {
    if (typeof name !== "string" || !name.startsWith(PREFIX) ||
        name.length <= PREFIX.length)
      throw new Error("invalid_note_namespace");
  }

  private async owned(records: IDBObjectStore, ticket: NoteLeaseToken): Promise<void> {
    if (!validToken(ticket) || ticket.owner !== this.owner)
      throw new Error("note_lease_lost");
    const current = row(await request(records.get(LEASE_KEY)));
    if (!current || current.owner !== ticket.owner ||
        current.epoch !== ticket.epoch || current.expiresAt <= this.clock())
      throw new Error("note_lease_lost");
  }

  /** A live fenced read is serialized with all competing claims and purges. */
  async listNamespaces(ticket: NoteLeaseToken): Promise<string[]> {
    const db = await this.db();
    return transact(db, [MARKERS, RECORDS], "readonly", async tx => {
      await this.owned(tx.objectStore(RECORDS), ticket);
      const keys = await request(tx.objectStore(MARKERS).getAllKeys());
      return keys.filter((key): key is string =>
        typeof key === "string" && key.startsWith(PREFIX)).sort();
    });
  }

  /** Create/reuse a marker under the *same* transaction as the live fence.
   * A stale tab cannot recreate a namespace even if the last marker vanished. */
  async openNamespace(ticket: NoteLeaseToken, name: string): Promise<string> {
    this.namespace(name);
    const db = await this.db();
    return transact(db, [MARKERS, RECORDS], "readwrite", async tx => {
      await this.owned(tx.objectStore(RECORDS), ticket);
      const markers = tx.objectStore(MARKERS);
      const raw = await request(markers.get(name));
      if (raw !== undefined && (typeof raw !== "string" || !raw))
        throw new Error("note_lease_namespace_replaced");
      const marker = raw === undefined ? crypto.randomUUID() : raw as string;
      if (raw === undefined) markers.put(marker, name);
      return marker;
    });
  }

  /** Namespace deletion is atomic with the lease fence, not guarded only by
   * a separate preceding check. Any successor owner blocks stale purges. */
  async deleteNamespaces(ticket: NoteLeaseToken, names: readonly string[]): Promise<void> {
    // Capture and validate the exact deletion set before the first await:
    // a caller must not replace checked names with another partition later.
    const targets = [...new Set(names)];
    for (const name of targets) this.namespace(name);
    const db = await this.db();
    await transact(db, [MARKERS, RECORDS], "readwrite", async tx => {
      const records = tx.objectStore(RECORDS);
      await this.owned(records, ticket);
      const markers = tx.objectStore(MARKERS);
      for (const name of targets) {
        markers.delete(name);
        records.delete(IDBKeyRange.bound([name], [name, []], false, true));
      }
    });
  }

  /** Even a read of unverified persisted data must obey the current lease
   * and marker; the higher-level client remains responsible for HTTP auth. */
  async readCheckpoint(ticket: NoteLeaseToken, name: string, marker: string): Promise<unknown> {
    this.namespace(name);
    if (!marker) throw new Error("note_lease_namespace_replaced");
    const db = await this.db();
    return transact(db, [MARKERS, RECORDS], "readonly", async tx => {
      const records = tx.objectStore(RECORDS);
      await this.owned(records, ticket);
      if (await request(tx.objectStore(MARKERS).get(name)) !== marker)
        throw new Error("note_lease_namespace_replaced");
      return request(records.get([name, CHECKPOINT_KEY]));
    });
  }

  /** Read-only marker receipt. Callers open the namespace through the existing
   * storage adapter first. The marker token prevents a deleted/recreated
   * namespace handle from writing into the replacement's partition. */
  async marker(namespace: string): Promise<string | null> {
    if (!namespace.startsWith(PREFIX)) throw new Error("invalid_note_namespace");
    const db = await this.db();
    return transact(db, [MARKERS], "readonly", async tx => {
      const value = await request(tx.objectStore(MARKERS).get(namespace));
      return typeof value === "string" && value ? value : null;
    });
  }

  /** Atomic fencing + marker CAS + checkpoint commit. This is the primitive
   * required by the future leased persistent client, NOT currently wired to
   * the existing default-unused client. Null deletes the checkpoint.
   *
   * No await, timer, or network request may run BETWEEN owner check and PUT
   * outside the single IndexedDB transaction. Even if a lease expires and
   * another tab claims it mid-flight, transactions serialize on RECORDS. */
  async checkpoint(
    lease: NoteLeaseToken,
    namespace: string,
    expectedMarker: string,
    value: unknown | null,
  ): Promise<void> {
    if (!validToken(lease) || lease.owner !== this.owner ||
        !namespace.startsWith(PREFIX) || !expectedMarker)
      throw new Error("note_lease_invalid_checkpoint");
    // Snapshot both caller-controlled objects before the first await. Checking
    // the original value and cloning it only after IndexedDB I/O would allow
    // the caller to mutate a previously valid metadata-only checkpoint.
    const ticket: NoteLeaseToken = { owner: lease.owner, epoch: lease.epoch };
    let snapshot: unknown | null;
    try {
      snapshot = value === null ? null : structuredClone(value);
    } catch {
      throw new Error("note_lease_invalid_checkpoint");
    }
    if (snapshot !== null && !validCheckpoint(snapshot, namespace))
      throw new Error("note_lease_invalid_checkpoint");
    const db = await this.db();
    await transact(db, [MARKERS, RECORDS], "readwrite", async tx => {
      const records = tx.objectStore(RECORDS);
      const current = row(await request(records.get(LEASE_KEY)));
      if (!current || current.owner !== ticket.owner ||
          current.epoch !== ticket.epoch || current.expiresAt <= this.clock())
        throw new Error("note_lease_lost");
      if (await request(tx.objectStore(MARKERS).get(namespace)) !== expectedMarker)
        throw new Error("note_lease_namespace_replaced");
      if (snapshot === null) records.delete([namespace, CHECKPOINT_KEY]);
      else records.put(snapshot, [namespace, CHECKPOINT_KEY]);
    });
  }
}
