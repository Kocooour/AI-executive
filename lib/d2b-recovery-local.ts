// Read localStorage drafts as RAW key/value pairs for owner recovery.
// The ordinary draft readers intentionally ignore malformed entries; a rescue
// operation must NOT silently omit them or migrate/remove legacy keys.
import { OfflineRecoveryInvalid, offlineRecoveryLimits } from "./d2b-offline-reconciliation";
import { notesDraftsKey, type DraftStorage } from "./notes-drafts";
import { projectContextDraftPrefix } from "./project-context-drafts";

export type RawRecoveryDraft = Readonly<{ storageKey: string; rawValue: string }>;

export function readRawRecoveryDrafts(storage: DraftStorage): {
  noteDrafts: RawRecoveryDraft[];
  projectContextDrafts: RawRecoveryDraft[];
} {
  const noteDrafts: RawRecoveryDraft[] = [];
  const projectContextDrafts: RawRecoveryDraft[] = [];
  const keys = new Set<string>();
  try {
    // Prefix match anchored with ":"; do not collect unrelated localStorage.
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null) throw new OfflineRecoveryInvalid();
      if (keys.has(key)) throw new OfflineRecoveryInvalid();
      keys.add(key);
      const isNote = key === notesDraftsKey || key.startsWith(notesDraftsKey + ":");
      const isProject = key.startsWith(projectContextDraftPrefix + ":");
      if (!isNote && !isProject) continue;
      const rawValue = storage.getItem(key);
      if (rawValue === null) throw new OfflineRecoveryInvalid();
      const target = isNote ? noteDrafts : projectContextDrafts;
      target.push({ storageKey: key, rawValue });
      if (target.length > offlineRecoveryLimits.maxDraftsPerKind ||
          rawValue.length > offlineRecoveryLimits.maxDraftJsonChars) throw new OfflineRecoveryInvalid();
    }
  } catch { throw new OfflineRecoveryInvalid(); }
  // LocalStorage enumeration order is unspecified, and must not affect SHA.
  noteDrafts.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
  projectContextDrafts.sort((a, b) => a.storageKey.localeCompare(b.storageKey));
  return { noteDrafts, projectContextDrafts };
}

import { deletedKey, revivedKey, pendingKey, pendingSeqKey } from "./pending-markers";

// Recovery scans marker keys WITHOUT the ordinary marker-reader's legacy
// migration (which mutates storage and may ignore corrupted older values).
export function readRawRecoveryMarkers(storage: DraftStorage): {
  pendingDeletedIds: string[]; pendingRevivedIds: string[]; pendingSync: boolean;
} {
  type Intent = { id: string; op: string; type: "deleted" | "revived" };
  const found: Intent[] = [];
  const keys = new Set<string>();
  const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 240;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || keys.has(key)) throw new OfflineRecoveryInvalid();
      keys.add(key);
      for (const [prefix, type] of [[deletedKey, "deleted"], [revivedKey, "revived"]] as const) {
        if (key !== prefix && !key.startsWith(prefix + ":")) continue;
        const raw = storage.getItem(key);
        if (raw === null) throw new OfflineRecoveryInvalid();
        if (key === prefix) {
          // Older versions kept arrays in one JSON key. Reject malformed
          // values instead of letting the normal reader silently remove them.
          const list: unknown = JSON.parse(raw);
          if (!Array.isArray(list) || list.length > offlineRecoveryLimits.maxMarkersPerKind)
            throw new OfflineRecoveryInvalid();
          for (const entry of list) {
            const id = typeof entry === "string" ? entry :
              entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : null;
            if (!validId(id)) throw new OfflineRecoveryInvalid();
            found.push({ id, type, op: "0".repeat(13) + "-legacy" });
          }
        } else {
          const op = key.slice(prefix.length + 1);
          if (!op || op.length > 128 || !validId(raw)) throw new OfflineRecoveryInvalid();
          found.push({ id: raw, type, op });
        }
      }
    }
    if (found.filter(x => x.type === "deleted").length > offlineRecoveryLimits.maxMarkersPerKind ||
        found.filter(x => x.type === "revived").length > offlineRecoveryLimits.maxMarkersPerKind)
      throw new OfflineRecoveryInvalid();
    const latest = new Map<string, Intent>();
    for (const entry of found) {
      const previous = latest.get(entry.id);
      if (previous && entry.op === previous.op && entry.type !== previous.type)
        throw new OfflineRecoveryInvalid(); // conflicting legacy intents: no guessing
      if (!previous || entry.op > previous.op) latest.set(entry.id, entry);
    }
    const idsOf = (type: Intent["type"]) =>
      [...latest.values()].filter(x => x.type === type).map(x => x.id).sort();
    return {
      pendingDeletedIds: idsOf("deleted"),
      pendingRevivedIds: idsOf("revived"),
      pendingSync: storage.getItem(pendingKey) !== null || storage.getItem(pendingSeqKey) !== null,
    };
  } catch { throw new OfflineRecoveryInvalid(); }
}
