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
