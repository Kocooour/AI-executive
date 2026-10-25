// Persistent, browser-wide STOP marker for a restore-generation mismatch.
// This marker carries only counters; never private tasks, drafts, titles or IDs.
// Do not clear it during this phase: recovery and consent to discard are distinct.
export const offlineRecoveryHoldKey = "ai-executive-offline-recovery-hold";
// Compatibility with recovery intents left by earlier drafts: such a marker
// remains a strict stop. New holds serialize their persistence with local wipes.
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
  try {
    // Node tests have no browser storage by design. A real browser where storage
    // is unavailable must still refuse writes instead of assuming no hold.
    if (storage === null) return typeof window !== "undefined";
    return storage.getItem(offlineRecoveryHoldKey) !== null ||
      storage.getItem(offlineRecoveryIntentKey) !== null;
  }
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

export function offlineRecoveryWipeSupported(): boolean {
  return typeof window === "undefined" || (typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { locks?: { request?: unknown } }).locks?.request === "function");
}

// Every destructive browser wipe and recovery-hold installation uses the SAME
// exclusive browser lock. Neither operation may interrupt the other halfway.
// If a user-authorized sign-out has already acquired the lock, it commits before
// a subsequently detected restore can persist its stop; if the hold wins, the
// subsequent wipe is blocked before deleting anything.
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

// Stop writes in this tab immediately. Other tabs receive the persistent stop
// only after taking the same lock that guards local-data deletion. This gives
// a total order to the two destructive/locking transitions: there can be no
// visible recovery hold inserted halfway through a multi-key wipe.
export async function beginOfflineRecoveryHoldSafely(
  knownGeneration: number | undefined, observedGeneration: number | undefined,
): Promise<OfflineRecoveryHold> {
  heldInThisTab = true;
  return withOfflineRecoveryDataLock(async () =>
    beginOfflineRecoveryHold(knownGeneration, observedGeneration));
}

// Generations can advance through multiple server restores while a browser is
// frozen. Preserve the FIRST observed mismatch in the hold; export against the
// CURRENT server generation as long as it has not moved backward.
// The restore generation takes precedence over revisions: a rollback often
// lowers the server revision and must never be mistaken for an up-to-date pull.
export function recoveryPullDecision(generationChanged: boolean, serverRevision: number, knownRevision: number):
  "restore" | "synced" | "apply" {
  if (generationChanged) return "restore";
  return serverRevision <= knownRevision ? "synced" : "apply";
}

export function recoveryExportGeneration(hold: OfflineRecoveryHold, current: number): number {
  if (!validNumber(current) || current < hold.observedGeneration ||
      current <= (hold.knownGeneration ?? 0))
    throw new Error("OFFLINE_RECOVERY_GENERATION_INVALID");
  return current;
}
