// Persistent, browser-wide STOP marker for a restore-generation mismatch.
// This marker carries only counters; never private tasks, drafts, titles or IDs.
// Do not clear it during this phase: recovery and consent to discard are distinct.
export const offlineRecoveryHoldKey = "ai-executive-offline-recovery-hold";

export type OfflineRecoveryHold = Readonly<{
  version: 1;
  knownGeneration: number | null;
  observedGeneration: number;
  createdAt: number;
}>;

type RecoveryStorage = Pick<Storage, "getItem" | "setItem">;
let heldInThisTab = false;

function browserStorage(): RecoveryStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

const validNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseOfflineRecoveryHold(raw: string | null): OfflineRecoveryHold | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 4 || item.version !== 1 ||
        !(item.knownGeneration === null || validNumber(item.knownGeneration)) ||
        !validNumber(item.observedGeneration) || !validNumber(item.createdAt)) return null;
    return item as OfflineRecoveryHold;
  } catch { return null; }
}

export function readOfflineRecoveryHold(storage: RecoveryStorage | null = browserStorage()): OfflineRecoveryHold | null {
  try { return parseOfflineRecoveryHold(storage?.getItem(offlineRecoveryHoldKey) ?? null); }
  catch { return null; }
}

// A malformed persisted marker ALSO blocks writes. Never silently clear corruption.
export function offlineRecoveryIsHeld(storage: RecoveryStorage | null = browserStorage()): boolean {
  if (heldInThisTab) return true;
  try { return storage?.getItem(offlineRecoveryHoldKey) !== null && storage !== null; }
  catch { return true; }
}

/** Called synchronously BEFORE any await / destructive adoption. */
export function beginOfflineRecoveryHold(
  knownGeneration: number | undefined,
  observedGeneration: number | undefined,
  storage: RecoveryStorage | null = browserStorage(),
  now = Date.now(),
): OfflineRecoveryHold {
  heldInThisTab = true; // fail closed even when localStorage refuses writes
  if (!(knownGeneration === undefined || validNumber(knownGeneration)) ||
      !validNumber(observedGeneration) || !validNumber(now) ||
      !storage) throw new Error("OFFLINE_RECOVERY_HOLD_UNAVAILABLE");
  let existing: string | null;
  try { existing = storage.getItem(offlineRecoveryHoldKey); }
  catch { throw new Error("OFFLINE_RECOVERY_HOLD_UNAVAILABLE"); }
  if (existing !== null) {
    const parsed = parseOfflineRecoveryHold(existing);
    if (!parsed) throw new Error("OFFLINE_RECOVERY_HOLD_CORRUPT");
    return parsed;
  }
  const marker: OfflineRecoveryHold = {
    version: 1, knownGeneration: knownGeneration ?? null, observedGeneration, createdAt: now,
  };
  try {
    storage.setItem(offlineRecoveryHoldKey, JSON.stringify(marker));
    if (storage.getItem(offlineRecoveryHoldKey) !== JSON.stringify(marker))
      throw new Error("OFFLINE_RECOVERY_HOLD_UNAVAILABLE");
  } catch { throw new Error("OFFLINE_RECOVERY_HOLD_UNAVAILABLE"); }
  return marker;
}
