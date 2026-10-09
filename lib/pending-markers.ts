// The bookkeeping of changes waiting to be sent is shared by all tabs of the browser
// (localStorage): the "waiting" mark, and the records deleted or restored here. A save removes
// only what it has sent itself, so that what another tab recorded meanwhile stays for that tab's
// own save.

export const pendingKey = "ai-executive-pending-sync";
export const deletedKey = "ai-executive-pending-deletions";
export const revivedKey = "ai-executive-pending-revivals";
const pendingSeqKey = "ai-executive-pending-seq";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function ids(storage: Store, key: string) {
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export const pendingDeletedIds = (storage: Store) => ids(storage, deletedKey);
export const pendingRevivedIds = (storage: Store) => ids(storage, revivedKey);
const pendingSeq = (storage: Store) => Number(storage.getItem(pendingSeqKey) || 0);

// A change waits to be sent; every call counts, so a save can tell whether one came after it.
export function markPending(storage: Store) {
  storage.setItem(pendingKey, "1");
  storage.setItem(pendingSeqKey, String(pendingSeq(storage) + 1));
}

export type SentMarkers = { seq: number; deleted: string[]; revived: string[] };

export function captureMarkers(storage: Store): SentMarkers {
  return { seq: pendingSeq(storage), deleted: pendingDeletedIds(storage), revived: pendingRevivedIds(storage) };
}

export function clearSentMarkers(storage: Store, sent: SentMarkers) {
  const keep = (key: string, current: string[], sentIds: string[]) => {
    const left = current.filter((id) => !sentIds.includes(id));
    if (left.length) storage.setItem(key, JSON.stringify(left));
    else storage.removeItem(key);
  };
  keep(deletedKey, pendingDeletedIds(storage), sent.deleted);
  keep(revivedKey, pendingRevivedIds(storage), sent.revived);
  if (pendingSeq(storage) === sent.seq) storage.removeItem(pendingKey);
}
