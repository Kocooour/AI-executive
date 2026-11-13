import { forServer } from "./sendable";
import { db, readSyncBase } from "./db";
import { offlineRecoveryIsHeld, withOfflineRecoveryDataLock } from "./d2b-recovery-hold";
import { clearAllMarkers, pendingDeletedIds, pendingRevivedIds } from "./pending-markers";
import { clearNotesDrafts, keptNotesDrafts, notesDraftsKey } from "./notes-drafts";
import { clearProjectContextDrafts, keptProjectContextDrafts } from "./project-context-drafts";
import { clearOpenTexts } from "./open-texts";
import { finishOwnerAdoptionFence } from "./owner-adoption-barrier";
import { attentionCacheKey } from "./attention-cache";

// Browser-side copies of server data and the bookkeeping of unsent changes.
// Device preferences (theme, language, start view) are not user data and stay.
const pendingSyncKey = "ai-executive-pending-sync";
const serverSyncedKey = "ai-executive-server-synced";
export const restoreGenerationKey = "ai-executive-restore-generation";
const wipePendingKey = "ai-executive-wipe-pending";
// Set once this browser has completed a synchronization with the server, removed by signing out: a start without a
// connection then shows the data kept here (owner decision 2026-10-09), also when there is none yet.
export const signedInKey = "ai-executive-signed-in";
// Called when a synchronization with the server has completed: only then does this browser hold the
// account's data, so only then may a later start without a connection show it.
export function markSignedIn() {
  try {
    // A synchronization that was already under way when this browser signed out (possibly in
    // another tab) must not mark it signed in again after the local copy was removed.
    if (localStorage.getItem(signedOutKey) === "1") return;
    localStorage.setItem(signedInKey, "1");
  } catch { /* storage unavailable */ }
}
// Set by signing out (the local copy removed), cleared by the next sign-in. While it is set this
// browser is not offered the offline view, whatever a late synchronization leaves behind.
export const signedOutKey = "ai-executive-signed-out";
export function clearSignedOut() {
  try { localStorage.removeItem(signedOutKey); } catch { /* storage unavailable */ }
}
const localDataKeys = [
  pendingSyncKey,
  "ai-executive-pending-deletions",
  "ai-executive-pending-revivals",
  "ai-executive-open-texts",
  "ai-executive-pending-seq",
  notesDraftsKey,
  "ai-executive-active-workspace",
  "ai-executive-write-workspace",
  attentionCacheKey,
  signedInKey,
];

// True when this browser may hold something the server does not: a change waiting to be sent, or
// rows from before the first completed synchronization.
export async function hasUnsentChanges() {
  if (localStorage.getItem(pendingSyncKey) === "1") return true;
  // A deletion or restoration recorded just before its save was asked for (a tab closed between).
  if (pendingDeletedIds(localStorage).length || pendingRevivedIds(localStorage).length) return true;
  // Notes still being typed, or left by a page closed before saving them.
  if (keptNotesDrafts(localStorage).length || keptProjectContextDrafts(localStorage).length) return true;
  // A record the server would refuse is held back here until it is fixed (lib/sendable.ts).
  if (forServer(await db.entities.toArray(), [], await readSyncBase()).heldBack.length) return true;
  if (localStorage.getItem(serverSyncedKey) === "1") return false;
  return (await db.entities.where("type").notEqual("workspace").count()) > 0;
}

// Removes everything this browser cached for the signed-in user. The caller is responsible for
// having synchronized, or for having the user's consent to drop unsent changes.
// A wipe that cannot finish (for example a database held by another tab) stays marked and is
// completed by finishInterruptedWipe() on the next start.
export async function clearLocalData(timeoutMs = 4000) {
  // Hold installation and ALL destructive cleanup share a cross-tab exclusive Web Lock.
  // A tab which already holds the lock completes before a new hold is finalized;
  // a wipe which acquires it later sees the durable intent and is refused.
  return withOfflineRecoveryDataLock(async () => {
  // IndexedDB deletion and direct localStorage removal bypass the ordinary write fence.
  // A crashed/interrupted sign-out must not erase the owner's recovery source.
  const assertNotHeld = () => {
    // An already-running wipe acquired the lock before the recovery request.
    // The request nevertheless persists an intent immediately; stop the wipe
    // as soon as that intent becomes visible, not just on initial entry.
    if (offlineRecoveryIsHeld()) throw new Error("OFFLINE_RECOVERY_HELD");
  };
  assertNotHeld();
  localStorage.setItem(wipePendingKey, "1");
  assertNotHeld();
  localStorage.setItem(signedOutKey, "1");
  localDataKeys.forEach((key) => {
    assertNotHeld();
    localStorage.removeItem(key);
  });
  // Deletions and restorations waiting to be sent are one key each (lib/pending-markers.ts).
  assertNotHeld();
  clearAllMarkers(localStorage);
  // So are notes drafts and the notes of open texts, one per tab.
  assertNotHeld();
  clearNotesDrafts(localStorage);
  assertNotHeld();
  clearProjectContextDrafts(localStorage);
  assertNotHeld();
  clearOpenTexts(localStorage);
  // Nothing local is left to push: the next start must take the server copy as it is, not merge.
  assertNotHeld();
  localStorage.setItem(serverSyncedKey, "1");
  assertNotHeld();
  const wipe = db.transaction("rw", [db.entities, db.relations, db.baseEntities, db.baseRelations], async () => {
    await db.entities.clear();
    await db.relations.clear();
    await db.baseEntities.clear();
    await db.baseRelations.clear();
  });
  await Promise.race([
    wipe,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Local data wipe timed out")), timeoutMs)),
  ]);
  // After a COMPLETE purge the browser no longer owns a copy of the old
  // generation. Retaining either marker would falsely freeze its next login
  // after an unrelated restore, despite there being nothing local to recover.
  // Keep wipePending until these removals succeed (crash-safe retry).
  clearPurgedRestoreBaseline(localStorage);
  // A fully authorized, verified sign-out also retires an abandoned owner
  // restore fence. Partial wipes keep wipePending and cannot expose old rows.
  finishOwnerAdoptionFence(localStorage);
  localStorage.removeItem(wipePendingKey);
  }, true);
}

export function clearPurgedRestoreBaseline(storage: Pick<Storage, "removeItem">) {
  storage.removeItem(restoreGenerationKey);
  storage.removeItem(serverSyncedKey);
}

export async function finishInterruptedWipe() {
  if (offlineRecoveryIsHeld()) return;
  if (localStorage.getItem(wipePendingKey) !== "1") return;
  await clearLocalData().catch(() => undefined);
}
