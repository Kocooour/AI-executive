/**
 * R2c.5a abstract local storage for the target sync client (proposal for owner approval, see
 * docs/ARCHITECTURE.md "Klientské sync jádro (R2c.5a)"). No DOM, no React: adapters (memory here,
 * IndexedDB in R2c.5b) implement this interface.
 *
 * Contract every adapter must keep:
 *  - A namespace is an opaque name derived from (userId, restoreGeneration). The client only ever holds a
 *    handle bound to ONE namespace, so an active session object cannot read another namespace.
 *  - `transaction(ops)` is atomic: either every op is applied or none (no half-applied feed page).
 *  - `deleteNamespaces(names)` is atomic and removes the data completely.
 *  - A handle of a deleted namespace rejects every read and write and never recreates the namespace.
 *  - Values are JSON-serializable and returned as independent copies; `list` is ordered by key (UTF-16 code units).
 */
export type StorageOp =
  | { kind: "put"; key: string; value: unknown }
  | { kind: "delete"; key: string }
  | { kind: "deletePrefix"; prefix: string };

export interface TargetSyncNamespace {
  readonly name: string;
  get<T = unknown>(key: string): Promise<T | undefined>;
  list<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  transaction(ops: readonly StorageOp[]): Promise<void>;
}

export interface TargetSyncStorage {
  listNamespaces(): Promise<string[]>;
  /** Opens (creating when missing) one namespace. */
  openNamespace(name: string): Promise<TargetSyncNamespace>;
  deleteNamespaces(names: readonly string[]): Promise<void>;
}

const NAMESPACE_PREFIX = "lumi-sync-v1";
export const SYNC_USER_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;

/** Namespace name for one identity and one restore generation (`|` cannot occur in a user id). */
export function namespaceName(userId: string, generation: string): string {
  if (!SYNC_USER_ID.test(userId)) throw new Error("invalid_user_id");
  if (typeof generation !== "string" || generation.length === 0 || generation.includes("|")) {
    throw new Error("invalid_generation");
  }
  return `${NAMESPACE_PREFIX}|${userId}|${generation}`;
}

export function parseNamespaceName(name: string): { userId: string; generation: string } | null {
  const parts = name.split("|");
  if (parts.length !== 3 || parts[0] !== NAMESPACE_PREFIX || !SYNC_USER_ID.test(parts[1]) || !parts[2]) return null;
  return { userId: parts[1], generation: parts[2] };
}
