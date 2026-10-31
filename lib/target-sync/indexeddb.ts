import type { StorageOp, TargetSyncNamespace, TargetSyncStorage } from "./storage";

/**
 * R2c.5b browser adapter. One database, with namespace markers and data in the
 * same IndexedDB transaction. A deleted namespace handle can never recreate it.
 */
const DB_VERSION = 1;
const MARKERS = "namespaces";
const RECORDS = "records";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb_request_failed"));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb_aborted"));
    tx.onerror = () => { /* onabort supplies the terminal failure */ };
  });
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class IndexedDbTargetSyncStorage implements TargetSyncStorage {
  private readonly dbPromise: Promise<IDBDatabase>;

  constructor(name = "lumi-target-sync-v1") {
    if (typeof indexedDB === "undefined") throw new Error("indexeddb_unavailable");
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(MARKERS)) db.createObjectStore(MARKERS);
        if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb_open_failed"));
      req.onblocked = () => reject(new Error("indexeddb_blocked"));
    });
  }

  private async db(): Promise<IDBDatabase> { return this.dbPromise; }

  async listNamespaces(): Promise<string[]> {
    const db = await this.db();
    const tx = db.transaction(MARKERS, "readonly");
    const done = finished(tx);
    const keys = await request(tx.objectStore(MARKERS).getAllKeys());
    await done;
    return keys.map(String).sort();
  }

  async openNamespace(name: string): Promise<TargetSyncNamespace> {
    if (typeof name !== "string" || !name) throw new Error("invalid_namespace");
    const db = await this.db();
    const tx = db.transaction(MARKERS, "readwrite");
    const done = finished(tx);
    const markers = tx.objectStore(MARKERS);
    let token = await request(markers.get(name)) as string | undefined;
    if (!token) {
      token = crypto.randomUUID();
      markers.put(token, name);
    }
    await done;
    return new IndexedDbNamespace(db, name, token);
  }

  async deleteNamespaces(names: readonly string[]): Promise<void> {
    if (!names.length) return;
    const db = await this.db();
    const tx = db.transaction([MARKERS, RECORDS], "readwrite");
    const done = finished(tx);
    const markers = tx.objectStore(MARKERS);
    const records = tx.objectStore(RECORDS);
    for (const name of new Set(names)) {
      markers.delete(name);
      records.delete(IDBKeyRange.bound([name, ""], [name, "\uffff"], false, false));
    }
    await done;
  }
}

class IndexedDbNamespace implements TargetSyncNamespace {
  constructor(private readonly db: IDBDatabase, readonly name: string, private readonly token: string) {}

  private async run<T>(mode: IDBTransactionMode, action: (records: IDBObjectStore) => Promise<T>): Promise<T> {
    const tx = this.db.transaction([MARKERS, RECORDS], mode);
    const done = finished(tx);
    try {
      const marker = await request(tx.objectStore(MARKERS).get(this.name));
      if (marker !== this.token) throw new Error("namespace_deleted");
      const result = await action(tx.objectStore(RECORDS));
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* already complete */ }
      await done.catch(() => {});
      throw error;
    }
  }

  get<T = unknown>(key: string): Promise<T | undefined> {
    return this.run("readonly", async records => {
      const value = await request(records.get([this.name, key])) as T | undefined;
      return value === undefined ? undefined : copy(value);
    });
  }

  list<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>> {
    return this.run("readonly", async records => {
      const rows: Array<{ key: string; value: T }> = [];
      const range = IDBKeyRange.bound([this.name, prefix], [this.name, prefix + "\uffff"]);
      await new Promise<void>((resolve, reject) => {
        const cursor = records.openCursor(range);
        cursor.onerror = () => reject(cursor.error ?? new Error("indexeddb_cursor_failed"));
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) { resolve(); return; }
          const key = (row.key as string[])[1];
          if (key.startsWith(prefix)) rows.push({ key, value: copy(row.value as T) });
          row.continue();
        };
      });
      return rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
  }

  transaction(ops: readonly StorageOp[]): Promise<void> {
    return this.run("readwrite", async records => {
      for (const op of ops) {
        if (op.kind === "put") records.put(copy(op.value), [this.name, op.key]);
        else if (op.kind === "delete") records.delete([this.name, op.key]);
        else if (op.kind === "deletePrefix") {
          const range = IDBKeyRange.bound([this.name, op.prefix], [this.name, op.prefix + "\uffff"]);
          await new Promise<void>((resolve, reject) => {
            const cursor = records.openKeyCursor(range);
            cursor.onerror = () => reject(cursor.error ?? new Error("indexeddb_cursor_failed"));
            cursor.onsuccess = () => {
              const row = cursor.result;
              if (!row) { resolve(); return; }
              if ((row.key as string[])[1].startsWith(op.prefix)) row.delete();
              row.continue();
            };
          });
        }
      }
    });
  }
}
