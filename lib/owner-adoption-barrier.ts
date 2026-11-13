// Cross-tab guard for a server-certified owner restore. Distinct from a D2b
// rescue hold: the owner adoption must still write its own IndexedDB transaction.
export const ownerAdoptionFenceKey = "ai-executive-owner-adoption-fence";
export const ownerAdoptionGenerationKey = "ai-executive-restore-generation";

type Readable = Pick<Storage, "getItem">;
type Writable = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Enumerable = Pick<Storage, "getItem" | "key" | "length">;
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
export function startOwnerAdoptionFence(storage: Writable, generation: number): void {
  if (!validGeneration(generation) || storage.getItem(ownerAdoptionFenceKey) !== null)
    throw new Error("OWNER_ADOPTION_FENCE_UNAVAILABLE");
  const value = String(generation);
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
  const fence = storage.getItem(ownerAdoptionFenceKey);
  if (fence === null) return true;
  const generation = Number(fence);
  if (!validGeneration(generation) || generation <= 0 || String(generation) !== fence ||
      storage.getItem(ownerAdoptionGenerationKey) !== fence ||
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
