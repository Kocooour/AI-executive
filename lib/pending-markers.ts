// The bookkeeping of changes waiting to be sent is shared by all tabs of the browser
// (localStorage): the "waiting" mark, and the records deleted or restored here. Each deletion and
// restoration is kept as its own entry (record id + operation id). A save removes exactly the
// entries it has sent, so what another tab recorded meanwhile stays for that tab's own save, even
// for the same record (deleted, restored and deleted again while the first save was on its way).

export const pendingKey = "ai-executive-pending-sync";
export const deletedKey = "ai-executive-pending-deletions";
export const revivedKey = "ai-executive-pending-revivals";
const pendingSeqKey = "ai-executive-pending-seq";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type Marker = { id: string; op: string };

function entries(storage: Store, key: string): Marker[] {
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    if (!Array.isArray(value)) return [];
    // Older versions kept plain ids.
    return value.flatMap((item) => typeof item === "string" ? [{ id: item, op: `legacy:${item}` }]
      : item && typeof item.id === "string" && typeof item.op === "string" ? [{ id: item.id, op: item.op }] : []);
  } catch {
    return [];
  }
}

function store(storage: Store, key: string, list: Marker[]) {
  if (list.length) storage.setItem(key, JSON.stringify(list));
  else storage.removeItem(key);
}

const unique = (list: Marker[]) => [...new Set(list.map((marker) => marker.id))];
let counter = 0;
const newOp = () => `${Date.now().toString(36)}-${(counter += 1).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const pendingDeletedIds = (storage: Store) => unique(entries(storage, deletedKey));
export const pendingRevivedIds = (storage: Store) => unique(entries(storage, revivedKey));

// A record deleted here: a restoration of it not sent yet is replaced by the deletion.
export function recordDeleted(storage: Store, id: string) {
  store(storage, revivedKey, entries(storage, revivedKey).filter((marker) => marker.id !== id));
  store(storage, deletedKey, [...entries(storage, deletedKey).filter((marker) => marker.id !== id), { id, op: newOp() }]);
}

// A deleted record restored here: a deletion of it not sent yet is replaced by the restoration.
export function recordRevived(storage: Store, id: string) {
  store(storage, deletedKey, entries(storage, deletedKey).filter((marker) => marker.id !== id));
  store(storage, revivedKey, [...entries(storage, revivedKey).filter((marker) => marker.id !== id), { id, op: newOp() }]);
}

const pendingSeq = (storage: Store) => Number(storage.getItem(pendingSeqKey) || 0);

// A change waits to be sent; every call counts, so a save can tell whether one came after it.
export function markPending(storage: Store) {
  storage.setItem(pendingKey, "1");
  storage.setItem(pendingSeqKey, String(pendingSeq(storage) + 1));
}

export type SentMarkers = { seq: number; deletedEntries: Marker[]; revivedEntries: Marker[]; deleted: string[]; revived: string[] };

export function captureMarkers(storage: Store): SentMarkers {
  const deletedEntries = entries(storage, deletedKey), revivedEntries = entries(storage, revivedKey);
  return { seq: pendingSeq(storage), deletedEntries, revivedEntries, deleted: unique(deletedEntries), revived: unique(revivedEntries) };
}

export function clearSentMarkers(storage: Store, sent: SentMarkers) {
  const sentOps = (list: Marker[]) => new Set(list.map((marker) => `${marker.id}\u0000${marker.op}`));
  const deletedOps = sentOps(sent.deletedEntries), revivedOps = sentOps(sent.revivedEntries);
  store(storage, deletedKey, entries(storage, deletedKey).filter((marker) => !deletedOps.has(`${marker.id}\u0000${marker.op}`)));
  store(storage, revivedKey, entries(storage, revivedKey).filter((marker) => !revivedOps.has(`${marker.id}\u0000${marker.op}`)));
  if (pendingSeq(storage) === sent.seq) storage.removeItem(pendingKey);
}
