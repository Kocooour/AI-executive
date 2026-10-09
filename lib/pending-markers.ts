// The bookkeeping of changes waiting to be sent is shared by all tabs of the browser
// (localStorage): the "waiting" mark, and the records deleted or restored here.
//
// Tabs write to localStorage independently, so nothing here reads a shared value, changes it and
// writes it back: another tab's write in between would be lost (a lost deletion mark brings the
// record back from the server). Instead every deletion and restoration is its own key, written
// once (`ai-executive-pending-deletions:<operation>` holding the record id), and only ever removed
// as a whole. A save removes exactly the keys it has sent, so what another tab recorded meanwhile
// stays for that tab's own save, even for the same record (deleted, restored and deleted again
// while the first save was on its way). The "waiting" mark comes with a token that every request
// for a save replaces; a save removes the mark only if the token is still the one it saw.

export const pendingKey = "ai-executive-pending-sync";
export const deletedKey = "ai-executive-pending-deletions";
export const revivedKey = "ai-executive-pending-revivals";
export const pendingSeqKey = "ai-executive-pending-seq";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
// `key`: the storage key holding this entry. `op` orders operations: it starts with the time.
export type Marker = { id: string; op: string; key: string };

let counter = 0;
const tab = Math.random().toString(36).slice(2, 10);
const newOp = () => `${Date.now().toString(36).padStart(10, "0")}-${tab}-${(counter += 1).toString(36).padStart(6, "0")}`;

function keysWithPrefix(storage: Store, prefix: string) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

// Older versions kept one shared list per kind (of plain ids, then of {id, op}). Its entries are
// moved to keys of their own; if two tabs do this at once an entry is there twice, which is
// harmless (only the record ids are sent).
function migrateLegacy(storage: Store) {
  for (const listKey of [deletedKey, revivedKey]) {
    const raw = storage.getItem(listKey);
    if (raw === null) continue;
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) {
        value.forEach((item) => {
          const id = typeof item === "string" ? item : item && typeof item.id === "string" ? item.id : "";
          // A key of its own (an old tab may still write the shared list after it was moved), ordered
          // before every new entry.
          if (id) storage.setItem(`${listKey}:${"0".repeat(10)}-${newOp()}`, id);
        });
      }
    } catch {
      // Not readable: nothing to keep.
    }
    storage.removeItem(listKey);
  }
}

function entries(storage: Store, listKey: string): Marker[] {
  return keysWithPrefix(storage, `${listKey}:`).flatMap((key) => {
    const id = storage.getItem(key);
    return id ? [{ id, op: key.slice(listKey.length + 1), key }] : [];
  });
}

// When two tabs delete and restore the same record at the same moment, both entries can remain:
// the later operation decides. The other one counts as handled when that is sent.
function current(storage: Store) {
  migrateLegacy(storage);
  const deletedEntries = entries(storage, deletedKey), revivedEntries = entries(storage, revivedKey);
  const latest = new Map<string, { op: string; kind: "deleted" | "revived" }>();
  for (const [kind, list] of [["deleted", deletedEntries], ["revived", revivedEntries]] as const) {
    for (const marker of list) {
      const known = latest.get(marker.id);
      if (!known || marker.op > known.op) latest.set(marker.id, { op: marker.op, kind });
    }
  }
  const of = (kind: "deleted" | "revived") => [...latest].filter(([, value]) => value.kind === kind).map(([id]) => id);
  return { deletedEntries, revivedEntries, deleted: of("deleted"), revived: of("revived") };
}

export const pendingDeletedIds = (storage: Store) => current(storage).deleted;
export const pendingRevivedIds = (storage: Store) => current(storage).revived;

// Removes the entries of one record of one kind (each key as a whole).
function drop(storage: Store, listKey: string, id: string) {
  for (const marker of entries(storage, listKey)) if (marker.id === id) storage.removeItem(marker.key);
}

// A record deleted here: a restoration of it not sent yet is replaced by the deletion.
export function recordDeleted(storage: Store, id: string) {
  migrateLegacy(storage);
  drop(storage, revivedKey, id);
  storage.setItem(`${deletedKey}:${newOp()}`, id);
}

// A deleted record restored here: a deletion of it not sent yet is replaced by the restoration.
export function recordRevived(storage: Store, id: string) {
  migrateLegacy(storage);
  drop(storage, deletedKey, id);
  storage.setItem(`${revivedKey}:${newOp()}`, id);
}

// A change waits to be sent. Every call sets a new token, so a save can tell whether one came
// after it.
export function markPending(storage: Store) {
  storage.setItem(pendingKey, "1");
  storage.setItem(pendingSeqKey, newOp());
}

export type SentMarkers = { seq: string; deletedEntries: Marker[]; revivedEntries: Marker[]; deleted: string[]; revived: string[] };

export function captureMarkers(storage: Store): SentMarkers {
  const { deletedEntries, revivedEntries, deleted, revived } = current(storage);
  return { seq: storage.getItem(pendingSeqKey) || "", deletedEntries, revivedEntries, deleted, revived };
}

export function clearSentMarkers(storage: Store, sent: SentMarkers) {
  for (const marker of [...sent.deletedEntries, ...sent.revivedEntries]) storage.removeItem(marker.key);
  if ((storage.getItem(pendingSeqKey) || "") === sent.seq) {
    storage.removeItem(pendingKey);
    storage.removeItem(pendingSeqKey);
  }
}

// All of this bookkeeping (a restored backup replaces the data; signing out removes it).
export function clearAllMarkers(storage: Store) {
  for (const listKey of [deletedKey, revivedKey]) {
    removeAllWithPrefix(storage, `${listKey}:`);
    storage.removeItem(listKey);
  }
  storage.removeItem(pendingSeqKey);
}

// Collects the keys first and repeats, so a key moved by another tab's removal is not skipped.
export function removeAllWithPrefix(storage: Store, prefix: string) {
  for (let pass = 0; pass < 5; pass += 1) {
    const keys = keysWithPrefix(storage, prefix);
    if (!keys.length) return;
    keys.forEach((key) => storage.removeItem(key));
  }
}
