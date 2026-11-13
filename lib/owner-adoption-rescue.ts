// Last-resort, owner-clicked salvage when the durable owner-adoption fence
// itself is unreadable. The original and observed generations are UNKNOWN:
// this is intentionally NOT a D2b recovery bundle and cannot be imported,
// assessed against server state or automatically merged.
//
// Capture only Lumi's local-data keys, never arbitrary origin localStorage
// (which may contain authentication or application secrets).
import type { Entity, Relation } from "./db";
import { offlineRecoveryFile } from "./d2b-offline-recovery-file";

export const unreadableOwnerRescueFilename = "lumi-interrupted-restore-raw-unverified.json";
export type RawOwnerRescueReason = "unreadable-owner-adoption-fence" | "owner-adoption-lock-unavailable";

type Store = Pick<Storage, "getItem" | "key" | "length">;
const exactKeys = new Set([
  "ai-executive-owner-adoption-fence",
  "ai-executive-restore-generation",
  "ai-executive-server-synced",
  "ai-executive-pending-sync",
  "ai-executive-pending-seq",
  "ai-executive-pending-deletions",
  "ai-executive-pending-revivals",
  "ai-executive-notes-drafts",
  "ai-executive-open-texts",
]);
const prefixes = [
  "ai-executive-pending-deletions:",
  "ai-executive-pending-revivals:",
  "ai-executive-notes-drafts:",
  "ai-executive-project-context-drafts:",
  "ai-executive-open-texts:",
];

export type RawOwnerRescueStorage = ReadonlyArray<Readonly<{ key: string; value: string }>>;

export function captureUnreadableOwnerRescueStorage(storage: Store): RawOwnerRescueStorage {
  const entries: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  const count = storage.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > 20_000)
    throw new Error("OWNER_RESCUE_STORAGE_UNAVAILABLE");
  for (let i = 0; i < count; i += 1) {
    const key = storage.key(i);
    if (key === null || seen.has(key)) throw new Error("OWNER_RESCUE_STORAGE_UNAVAILABLE");
    seen.add(key);
    if (!exactKeys.has(key) && !prefixes.some(prefix => key.startsWith(prefix))) continue;
    const value = storage.getItem(key);
    if (value === null) throw new Error("OWNER_RESCUE_STORAGE_UNAVAILABLE");
    entries.push({ key, value });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

export type RawOwnerRescueLocal = Readonly<{
  entities: Entity[];
  relations: Relation[];
  base: { entities: Entity[]; relations: Relation[] } | null;
}>;

// This deliberately has a distinct, non-importable format. If IndexedDB is
// unreadable it is explicitly marked missing; no claim of completeness.
export function encodeUnreadableOwnerRescue(
  local: RawOwnerRescueLocal | null, storage: RawOwnerRescueStorage, capturedAt = Date.now(),
  reason: RawOwnerRescueReason = "unreadable-owner-adoption-fence",
): Uint8Array {
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0 ||
      (reason !== "unreadable-owner-adoption-fence" && reason !== "owner-adoption-lock-unavailable") ||
      !Array.isArray(storage) ||
      !storage.some(entry => entry.key === "ai-executive-owner-adoption-fence"))
    throw new Error("OWNER_RESCUE_INVALID");
  const data = {
    format: "lumi-owner-adoption-raw-rescue", version: 1,
    verified: false, complete: false, autoImportPermitted: false,
    reason, capturedAt,
    indexedDbReadable: local !== null,
    local, storage,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  if (bytes.byteLength === 0 || bytes.byteLength > offlineRecoveryFile.maxUtf8Bytes)
    throw new Error("OWNER_RESCUE_TOO_LARGE");
  return bytes;
}
