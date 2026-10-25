// Persistent, browser-wide STOP marker for a restore-generation mismatch.
// This marker carries only counters; never private tasks, drafts, titles or IDs.
// Do not clear it during this phase: recovery and consent to discard are distinct.
export const offlineRecoveryHoldKey = "ai-executive-offline-recovery-hold";
// Durable intent closes the cross-tab write fence while we wait for the browser-wide
// exclusive lock. The final hold and any sign-out wipe are serialized by that lock.
export const offlineRecoveryIntentKey = "ai-executive-offline-recovery-intent";
const recoveryDataLockName = "ai-executive-recovery-data";

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
  try {
    const persisted = storage?.getItem(offlineRecoveryHoldKey);
    return parseOfflineRecoveryHold(persisted === null || persisted === undefined
      ? storage?.getItem(offlineRecoveryIntentKey) ?? null : persisted);
  } catch { return null; }
}

// A malformed persisted marker ALSO blocks writes. Never silently clear corruption.
export function offlineRecoveryIsHeld(storage: RecoveryStorage | null = browserStorage()): boolean {
  if (heldInThisTab) return true;
  try { return storage === null || storage.getItem(offlineRecoveryHoldKey) !== null ||
    storage.getItem(offlineRecoveryIntentKey) !== null; }
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
  const intent = storage.getItem(offlineRecoveryIntentKey);
  const fromIntent = parseOfflineRecoveryHold(intent);
  if (intent !== null && !fromIntent) throw new Error("OFFLINE_RECOVERY_HOLD_CORRUPT");
  const marker: OfflineRecoveryHold = fromIntent ?? {
    version: 1, knownGeneration: knownGeneration ?? null, observedGeneration, createdAt: now,
  };
  try {
    storage.setItem(offlineRecoveryHoldKey, JSON.stringify(marker));
    if (storage.getItem(offlineRecoveryHoldKey) !== JSON.stringify(marker))
      throw new Error("OFFLINE_RECOVERY_HOLD_UNAVAILABLE");
  } catch { throw new Error("OFFLINE_RECOVERY_HOLD_UNAVAILABLE"); }
  return marker;
}

// Every destructive browser wipe and recovery-hold installation uses the SAME
// exclusive browser lock. No step of a wipe may execute after a finalized hold.
// Without Web Locks we fail closed on destructive wipes in real browsers.
export async function withOfflineRecoveryDataLock<T>(work: () => Promise<T>, destructive = false): Promise<T> {
  const locks = typeof navigator !== "undefined"
    ? (navigator as Navigator & { locks?: {
      request<TValue>(name: string, callback: () => Promise<TValue>): Promise<TValue>;
    } }).locks
    : undefined;
  if (locks) return locks.request(recoveryDataLockName, work);
  if (destructive && typeof window !== "undefined") throw new Error("OFFLINE_RECOVERY_LOCK_UNAVAILABLE");
  return work(); // Non-browser tests; recovery hold remains fail-closed if storage fails.
}

// Persist the intent *synchronously*, before any await for another tab's lock.
// Even if the tab crashes before finalizing the marker, the intent persists and
// blocks subsequent writes and allows an owner-only export after reload.
function stageOfflineRecoveryIntent(knownGeneration: number | undefined, observedGeneration: number | undefined) {
  heldInThisTab = true;
  const storage = browserStorage();
  if (!storage || !(knownGeneration === undefined || validNumber(knownGeneration)) ||
      !validNumber(observedGeneration)) throw new Error("OFFLINE_RECOVERY_HOLD_UNAVAILABLE");
  const current = storage.getItem(offlineRecoveryHoldKey) ?? storage.getItem(offlineRecoveryIntentKey);
  if (current !== null) {
    const parsed = parseOfflineRecoveryHold(current);
    if (!parsed) throw new Error("OFFLINE_RECOVERY_HOLD_CORRUPT");
    return parsed;
  }
  const marker: OfflineRecoveryHold = {
    version: 1, knownGeneration: knownGeneration ?? null,
    observedGeneration, createdAt: Date.now(),
  };
  storage.setItem(offlineRecoveryIntentKey, JSON.stringify(marker));
  if (storage.getItem(offlineRecoveryIntentKey) !== JSON.stringify(marker))
    throw new Error("OFFLINE_RECOVERY_HOLD_UNAVAILABLE");
  return marker;
}

export async function beginOfflineRecoveryHoldSafely(
  knownGeneration: number | undefined, observedGeneration: number | undefined,
): Promise<OfflineRecoveryHold> {
  const intent = stageOfflineRecoveryIntent(knownGeneration, observedGeneration);
  return withOfflineRecoveryDataLock(async () =>
    beginOfflineRecoveryHold(intent.knownGeneration ?? undefined, intent.observedGeneration));
}

// Generations can advance through multiple server restores while a browser is
// frozen. Preserve the FIRST observed mismatch in the hold; export against the
// CURRENT server generation as long as it has not moved backward.
export function recoveryExportGeneration(hold: OfflineRecoveryHold, current: number): number {
  if (!validNumber(current) || current < hold.observedGeneration ||
      current <= (hold.knownGeneration ?? 0))
    throw new Error("OFFLINE_RECOVERY_GENERATION_INVALID");
  return current;
}
