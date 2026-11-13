// Cross-tab guard for a server-certified owner restore. Distinct from a D2b
// rescue hold: the owner adoption must still write its own IndexedDB transaction.
export const ownerAdoptionFenceKey = "ai-executive-owner-adoption-fence";
export const ownerAdoptionGenerationKey = "ai-executive-restore-generation";

type Readable = Pick<Storage, "getItem">;
type Writable = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Enumerable = Pick<Storage, "getItem" | "key" | "length">;
export type OwnerAdoptionFence = Readonly<{
  version: 1;
  observedGeneration: number;
  knownGeneration: number | null;
}>;
const validGeneration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function browserStore(): Readable | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

// Each loaded tab retains its OWN generation. Another tab must not change it
// merely by advancing the shared localStorage value.
let knownInThisTab: number | undefined;
let initialized = false;
export function initializeAdoptionGeneration(known: number | undefined) {
  if (!initialized) { knownInThisTab = known; initialized = true; }
}
export function advanceAdoptionGeneration(generation: number) {
  knownInThisTab = generation;
  initialized = true;
}
export function ownerAdoptionFencePresent(storage: Readable | null = browserStore()): boolean {
  if (!storage) return typeof window !== "undefined";
  try { return storage.getItem(ownerAdoptionFenceKey) !== null; } catch { return true; }
}
export function crossTabAdoptionBlocked(
  known: number | undefined, storage: Readable | null = browserStore(),
): boolean {
  if (!storage) return typeof window !== "undefined";
  try {
    if (storage.getItem(ownerAdoptionFenceKey) !== null) return true;
    const raw = storage.getItem(ownerAdoptionGenerationKey);
    if (raw === null) return known !== undefined;
    const generation = Number(raw);
    if (!validGeneration(generation)) return true;
    // Legacy pages can have a synchronized local copy without having ever
    // stored the generation counter. A newer certified generation must not
    // be treated as their own merely because `known` is missing.
    if (known === undefined)
      return generation > 0 && storage.getItem("ai-executive-server-synced") === "1";
    return generation !== known;
  } catch { return true; }
}
export function isCrossTabAdoptionBlocked() {
  return crossTabAdoptionBlocked(initialized ? knownInThisTab : undefined);
}
// The marker records the *original* generation too. If the browser crashes
// before the new generation is stamped, the owner can resume a certified
// restore, or export the still-recoverable local data without inventing a
// known generation equal to the observed one.
export function readOwnerAdoptionFence(storage: Readable): OwnerAdoptionFence | null {
  const raw = storage.getItem(ownerAdoptionFenceKey);
  if (raw === null) return null;
  try {
    const marker = JSON.parse(raw) as Partial<OwnerAdoptionFence>;
    if (!marker || marker.version !== 1 || !validGeneration(marker.observedGeneration) ||
        marker.observedGeneration === 0 ||
        !(marker.knownGeneration === null || validGeneration(marker.knownGeneration)) ||
        Object.keys(marker).length !== 3) return null;
    return marker as OwnerAdoptionFence;
  } catch { return null; }
}
export function startOwnerAdoptionFence(
  storage: Writable, generation: number, knownGeneration?: number,
): void {
  if (!validGeneration(generation) || generation === 0 ||
      !(knownGeneration === undefined || validGeneration(knownGeneration)) ||
      storage.getItem(ownerAdoptionFenceKey) !== null)
    throw new Error("OWNER_ADOPTION_FENCE_UNAVAILABLE");
  const marker: OwnerAdoptionFence = {
    version: 1, observedGeneration: generation, knownGeneration: knownGeneration ?? null,
  };
  const value = JSON.stringify(marker);
  storage.setItem(ownerAdoptionFenceKey, value);
  if (storage.getItem(ownerAdoptionFenceKey) !== value)
    throw new Error("OWNER_ADOPTION_FENCE_UNAVAILABLE");
}
export function finishOwnerAdoptionFence(storage: Writable): void {
  storage.removeItem(ownerAdoptionFenceKey);
  if (storage.getItem(ownerAdoptionFenceKey) !== null)
    throw new Error("OWNER_ADOPTION_FENCE_NOT_CLEARED");
}

// A failed final fence removal does NOT mean the original IndexedDB copy
// survived. If the complete cleanup and new generation were already
// committed, the marker can be removed idempotently under the same lock
// on the next startup. Never finalize a partial cleanup or absent generation.
export function ownerAdoptionReadyToFinish(storage: Enumerable): boolean {
  const raw = storage.getItem(ownerAdoptionFenceKey);
  if (raw === null) return true;
  const fence = readOwnerAdoptionFence(storage);
  if (!fence || storage.getItem(ownerAdoptionGenerationKey) !== String(fence.observedGeneration) ||
      storage.getItem("ai-executive-server-synced") !== "1") return false;
  assertOwnerAdoptionCleanup(storage);
  return true;
}

// Fail closed on even a single leftover local deletion/revival marker or draft.
// Selective localStorage.removeItem failures must never be certified by a new
// generation, or a tombstone can delete data from the restored server.
export function assertOwnerAdoptionCleanup(storage: Enumerable): void {
  const exact = [
    "ai-executive-pending-sync", "ai-executive-pending-seq",
    "ai-executive-pending-deletions", "ai-executive-pending-revivals",
    "ai-executive-notes-drafts",
  ];
  const prefixes = [
    "ai-executive-pending-deletions:", "ai-executive-pending-revivals:",
    "ai-executive-notes-drafts:", "ai-executive-project-context-drafts:",
  ];
  for (const key of exact) if (storage.getItem(key) !== null)
    throw new Error("OWNER_ADOPTION_LOCAL_CLEANUP_INCOMPLETE");
  const count = storage.length;
  for (let index = 0; index < count; index += 1) {
    const key = storage.key(index);
    if (key === null || exact.includes(key) || prefixes.some(prefix => key.startsWith(prefix)))
      throw new Error("OWNER_ADOPTION_LOCAL_CLEANUP_INCOMPLETE");
  }
}

/**
 * Ordinary synchronization may only re-affirm the generation already known
 * to this browser. It may NOT certify a different restore generation. Must be
 * called while holding ai-executive-recovery-data Web Lock, so another tab's
 * owner adoption cannot race the read/modify/write.
 */
export function persistOrdinaryGeneration(
  storage: Writable, knownGeneration: number | undefined, generation: number,
): boolean {
  if (!validGeneration(generation) || storage.getItem(ownerAdoptionFenceKey) !== null)
    return false;
  const raw = storage.getItem(ownerAdoptionGenerationKey);
  const persisted = raw === null ? undefined : Number(raw);
  if (raw !== null && !validGeneration(persisted)) return false;
  if (knownGeneration !== undefined && (generation !== knownGeneration || persisted !== knownGeneration))
    return false;
  if (persisted !== undefined && persisted !== generation) return false;
  storage.setItem(ownerAdoptionGenerationKey, String(generation));
  return storage.getItem(ownerAdoptionGenerationKey) === String(generation);
}
