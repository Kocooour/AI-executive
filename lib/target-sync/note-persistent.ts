/**
 * R2d note-only, default-unused IndexedDB checkpoint client.
 * Dedicated DB; NEVER reuse the task/project sync namespace, drafts or queue.
 * The caller supplies trusted server-authenticated identity and generation.
 * No background I/O, note contents, credentials, UI or automatic publishing.
 */
import { IndexedDbTargetSyncStorage } from "./indexeddb";
import { createStagingNoteHttpClient, type NoteHttpScope, type NoteHttpTransport,
  type NoteHttpPullResult } from "./note-http";
import type { NoteMetadata } from "./note-pages";
import type { TargetSyncNamespace, TargetSyncStorage } from "./storage";

const PREFIX = "lumi-note-metadata-v1|";
const KEY = "checkpoint";
type Checkpoint = { version: 1; scope: NoteHttpScope; state: unknown };
type Active = { name: string; handle: TargetSyncNamespace };
export type PersistentNotePullResult = NoteHttpPullResult | { kind: "storage_error" };

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
  options: { storage?: TargetSyncStorage; transport?: NoteHttpTransport } = {},
) {
  const storage = options.storage ?? new IndexedDbTargetSyncStorage("lumi-note-metadata-v1");
  const http = createStagingNoteHttpClient(options.transport);
  let token = 0;
  let active: Active | null = null;
  let visible = false;
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
    visible = false;
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
        visible = false;
        http.clear();
      }
      throw new Error("note_cache_unavailable");
    }
  };
  const clear = async (): Promise<void> => {
    ++token;
    visible = false;
    active = null;
    http.clear(); // immediately abort and fence already-dispatched responses
    await serial(() => purge());
  };
  const read = (): NoteMetadata[] => active && visible ? http.read() : [];
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
        visible = true;
      } else if (result.kind === "locked") {
        // The HTTP client already removed the scope on 401/404.
        visible = false;
        active = null;
        ++token;
        await serial(() => purge());
      } else if (result.kind === "resync_required") {
        visible = false;
        // The next call starts without a cursor, including after app restart.
        await serial(async () => {
          if (ticket === token) await selected.handle.transaction([{ kind: "delete", key: KEY }]);
        });
      }
      return result;
    } catch {
      if (ticket === token) {
        ++token;
        visible = false;
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
