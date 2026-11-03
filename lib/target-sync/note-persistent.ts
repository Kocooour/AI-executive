/**
 * R2d note-only, default-unused IndexedDB checkpoint client.
 * Dedicated DB; NEVER reuse the task/project sync namespace, drafts or queue.
 * The caller supplies trusted server-authenticated identity and generation.
 * No background I/O, note contents, credentials, UI or automatic publishing.
 */
import { IndexedDbLeasedNoteStorage } from "./note-leased";
import { createStagingNoteHttpClient, type NoteHttpScope, type NoteHttpTransport,
  type NoteHttpPullResult } from "./note-http";
import { readableNoteMetadata, type NoteMetadata } from "./note-pages";
import type { TargetSyncNamespace, TargetSyncStorage } from "./storage";

const PREFIX = "lumi-note-metadata-v1|";
const KEY = "checkpoint";
type Checkpoint = { version: 1; scope: NoteHttpScope; state: unknown };
type Active = { name: string; handle: TargetSyncNamespace };
export type PersistentNotePullResult = NoteHttpPullResult | { kind: "storage_error" };
export type PersistentNoteClient = {
  activate(next: NoteHttpScope): Promise<"fresh" | "restored_unverified">;
  clear(): Promise<void>;
  pull(): Promise<PersistentNotePullResult>;
  read(): NoteMetadata[];
  currentScope(): NoteHttpScope | null;
};

/** encodeURIComponent escapes the separator even inside arbitrary Area IDs. */
export function noteMetadataNamespace(scope: NoteHttpScope): string {
  return PREFIX + [scope.userId, scope.restoreGeneration, scope.areaId]
    .map(encodeURIComponent).join("|");
}

function verifiedCheckpoint(value: unknown, scope: NoteHttpScope): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "scope,state,version" || record.version !== 1)
    return null;
  const bound = record.scope;
  if (!bound || typeof bound !== "object" || Array.isArray(bound)) return null;
  const saved = bound as Record<string, unknown>;
  if (Object.keys(saved).sort().join(",") !== "areaId,restoreGeneration,userId" ||
      saved.userId !== scope.userId ||
      saved.areaId !== scope.areaId ||
      saved.restoreGeneration !== scope.restoreGeneration) return null;
  return record.state;
}

/**
 * Pages are stored as ONE JSON value (cursor + manifest + pending bootstrap).
 * The existing IndexedDB adapter commits that value in one readwrite transaction.
 *
 * A restored checkpoint is kept hidden until a new authenticated server GET
 * validates access to the same actor, Area, generation and cursor. Offline
 * restart therefore reads nothing, even when the cache contains old metadata.
 * This module has deliberately no offline note edit/write API.
 */
export function createStagingNotePersistentClient(
  options: { storage?: TargetSyncStorage; transport?: NoteHttpTransport; dbName?: string } = {},
): PersistentNoteClient {
  // The browser default MUST use the global lease. Custom storage injection
  // is retained only for isolated memory/IndexedDB unit harnesses.
  if (!options.storage) return createStagingNoteLeasedClient({
    dbName: options.dbName, transport: options.transport,
  });
  const storage = options.storage;
  const http = createStagingNoteHttpClient(options.transport);
  let token = 0;
  let active: Active | null = null;
  // The HTTP client advances its volatile state before IndexedDB commits.
  // Readers may inspect ONLY this detached, last-committed manifest.
  let committed: NoteMetadata[] | null = null;
  let busyToken: number | null = null;
  let tail: Promise<void> = Promise.resolve();

  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const purge = async (except?: string): Promise<void> => {
    const names = (await storage.listNamespaces())
      .filter(name => name.startsWith(PREFIX) && name !== except);
    if (names.length) await storage.deleteNamespaces(names);
  };
  const activate = async (next: NoteHttpScope): Promise<"fresh" | "restored_unverified"> => {
    // A malformed untrusted scope must never erase a previously active scope.
    http.activate(next);
    const ticket = ++token;
    const scope = http.currentScope()!;
    const name = noteMetadataNamespace(scope);
    committed = null;
    active = null;
    try {
      return await serial(async () => {
        // Old partitions are erased, including those from a different actor,
        // Area or restore generation. No other subsystem uses this database.
        await purge(name);
        if (ticket !== token) return "fresh";
        let handle = await storage.openNamespace(name);
        const raw = await handle.get<unknown>(KEY);
        if (ticket !== token) return "fresh";
        let restored = false;
        if (raw !== undefined) {
          const state = verifiedCheckpoint(raw, scope);
          restored = state !== null && http.resumeUnverified(state);
          if (!restored) {
            // Fail closed on stale/poisoned checkpoints: discard the marker and
            // every record, then start from an empty page/cursor.
            await storage.deleteNamespaces([name]);
            handle = await storage.openNamespace(name);
          }
        }
        if (ticket === token) active = { name, handle };
        return restored ? "restored_unverified" : "fresh";
      });
    } catch {
      if (ticket === token) {
        token++;
        active = null;
        committed = null;
        http.clear();
      }
      throw new Error("note_cache_unavailable");
    }
  };
  const clear = async (): Promise<void> => {
    ++token;
    committed = null;
    active = null;
    http.clear(); // immediately abort and fence already-dispatched responses
    await serial(() => purge());
  };
  const read = (): NoteMetadata[] => active && committed !== null
    ? committed.map(note => ({ ...note })) : [];
  const currentScope = (): NoteHttpScope | null => active ? http.currentScope() : null;

  const pull = async (): Promise<PersistentNotePullResult> => {
    const ticket = token;
    const selected = active;
    if (!selected) return { kind: "inactive" };
    if (busyToken === ticket) return { kind: "busy" };
    busyToken = ticket;
    try {
      const result = await http.pull();
      if (ticket !== token || active !== selected) return { kind: "superseded" };
      if (result.kind === "applied") {
        const snapshot = http.checkpoint();
        if (!snapshot) throw new Error("checkpoint_unavailable");
        // Do not publish anything until cursor AND data are committed together.
        await serial(async () => {
          if (ticket !== token) return;
          const scope = http.currentScope();
          if (!scope) throw new Error("scope_changed");
          const checkpoint: Checkpoint = { version: 1, scope, state: snapshot };
          await selected.handle.transaction([{ kind: "put", key: KEY, value: checkpoint }]);
        });
        if (ticket !== token) return { kind: "superseded" };
        // Publish only the exact manifest whose cursor has been committed.
        committed = readableNoteMetadata(snapshot);
      } else if (result.kind === "locked") {
        // The HTTP client already removed the scope on 401/404.
        committed = null;
        active = null;
        ++token;
        await serial(() => purge());
      } else if (result.kind === "resync_required") {
        committed = null;
        // The next call starts without a cursor, including after app restart.
        await serial(async () => {
          if (ticket === token) await selected.handle.transaction([{ kind: "delete", key: KEY }]);
        });
      }
      return result;
    } catch {
      if (ticket === token) {
        ++token;
        committed = null;
        active = null;
        http.clear();
      }
      // A failed write/delete never permits reads from uncommitted metadata.
      // Next activate must successfully purge old partitions before use.
      return { kind: "storage_error" };
    } finally {
      if (busyToken === ticket) busyToken = null;
    }
  };
  return { activate, clear, pull, read, currentScope };
}


/**
 * Browser default-off note metadata client. Reuses the existing authenticated
 * HTTP reconciler, but NEVER its unguarded IndexedDB adapter: every metadata
 * read, namespace creation/purge and checkpoint commit is lease-checked inside
 * the same IndexedDB transaction. An incoming cross-tab invalidation also
 * fences the local HTTP client immediately; UI activation remains separate.
 *
 * Actor/generation/Area inputs must still come from the verified session
 * controller; BroadcastChannel is only a cache-revocation hint, not auth.
 */
export function createStagingNoteLeasedClient(
  options: { transport?: NoteHttpTransport; dbName?: string } = {},
): PersistentNoteClient & { dispose(): Promise<void> } {
  const dbName = options.dbName ?? "lumi-note-metadata-v1";
  const storage = new IndexedDbLeasedNoteStorage(dbName);
  if (typeof BroadcastChannel === "undefined")
    throw new Error("note_lease_broadcast_unavailable");
  const channel = new BroadcastChannel("lumi-note-metadata-lease-revoke|" + dbName);
  const clientId = crypto.randomUUID();
  const core = createStagingNotePersistentClient({ storage, transport: options.transport });
  let generation = 0;
  let tail: Promise<void> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = tail.then(work);
    tail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const broadcast = () => channel.postMessage({ kind: "note-cache-revoke-v1", sender: clientId });

  /** Clear the public snapshot before any asynchronous I/O. An expired tab
   * cannot purge data now owned by a different tab. */
  const revoke = (): Promise<void> => {
    ++generation;
    storage.blockReads();
    const owned = storage.ownsTicket();
    const clearing = core.clear();
    return serial(async () => {
      try {
        await clearing;
      } catch (error) {
        if (owned) throw error;
        // A non-owner cannot erase another tab's cache; its broadcast makes
        // the actual owner revoke and securely purge its own partition.
      } finally {
        await storage.release();
      }
    });
  };
  channel.onmessage = event => {
    const msg: unknown = event.data;
    if (!msg || typeof msg !== "object") return;
    const payload = msg as Record<string, unknown>;
    if (payload.kind !== "note-cache-revoke-v1" || payload.sender === clientId) return;
    void revoke().catch(() => undefined); // memory already hidden synchronously
  };

  const activate = (next: NoteHttpScope): Promise<"fresh" | "restored_unverified"> => {
    // Do not touch the lease or cached actor on malformed scope.
    const probe = createStagingNoteHttpClient();
    probe.activate(next);
    const scope = probe.currentScope()!;
    const requested = ++generation;
    storage.blockReads();
    return serial(async () => {
      if (requested !== generation) return "fresh";
      try {
        if (!await storage.acquire()) throw new Error("note_lease_busy");
        if (requested !== generation) return "fresh";
        // If a prior owner was suspended, its synchronous read projection
        // becomes invisible when it receives this notification.
        broadcast();
        const result = await core.activate(scope);
        if (requested !== generation) return "fresh";
        storage.allowReads();
        return result;
      } catch {
        storage.blockReads();
        await core.clear().catch(() => undefined);
        await storage.release().catch(() => undefined);
        throw new Error("note_cache_unavailable");
      }
    });
  };

  const clear = async (): Promise<void> => {
    // Sign-out/Area revocation from even a read-only/losing tab must notify
    // the actual writer. Never try to delete another live owner's records.
    broadcast();
    await revoke();
  };
  const pull = async (): Promise<PersistentNotePullResult> => {
    if (!storage.isReadable() || !await storage.renew()) {
      void revoke().catch(() => undefined);
      return { kind: "storage_error" };
    }
    const result = await core.pull();
    if (result.kind === "locked" || result.kind === "storage_error") {
      storage.blockReads();
      broadcast();
      await storage.release().catch(() => undefined);
    }
    return result;
  };
  return {
    activate, clear, pull,
    read: (): NoteMetadata[] => storage.isReadable() ? core.read() : [],
    currentScope: (): NoteHttpScope | null => storage.isReadable() ? core.currentScope() : null,
    /** Release a no-longer-used client and its BroadcastChannel listener. */
    dispose: async (): Promise<void> => {
      channel.close();
      await revoke();
    },
  };
}
