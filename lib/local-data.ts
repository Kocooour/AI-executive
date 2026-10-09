import { forServer } from "./sendable";
import { db } from "./db";
import { clearAllMarkers, pendingDeletedIds, pendingRevivedIds } from "./pending-markers";
import { clearNotesDrafts, keptNotesDrafts, notesDraftsKey } from "./notes-drafts";
import { clearOpenTexts } from "./open-texts";

// Browser-side copies of server data and the bookkeeping of unsent changes.
// Device preferences (theme, language, start view) are not user data and stay.
const pendingSyncKey = "ai-executive-pending-sync";
const serverSyncedKey = "ai-executive-server-synced";
const wipePendingKey = "ai-executive-wipe-pending";
const localDataKeys = [
  pendingSyncKey,
  "ai-executive-pending-deletions",
  "ai-executive-pending-revivals",
  "ai-executive-open-texts",
  "ai-executive-pending-seq",
  notesDraftsKey,
  "ai-executive-active-workspace",
  "ai-executive-write-workspace",
];

// True when this browser may hold something the server does not: a change waiting to be sent, or
// rows from before the first completed synchronization.
export async function hasUnsentChanges() {
  if (localStorage.getItem(pendingSyncKey) === "1") return true;
  // A deletion or restoration recorded just before its save was asked for (a tab closed between).
  if (pendingDeletedIds(localStorage).length || pendingRevivedIds(localStorage).length) return true;
  // Notes still being typed, or left by a page closed before saving them.
  if (keptNotesDrafts(localStorage).length) return true;
  // A record the server would refuse is held back here until it is fixed (lib/sendable.ts).
  if (forServer(await db.entities.toArray(), [], null).heldBack.length) return true;
  if (localStorage.getItem(serverSyncedKey) === "1") return false;
  return (await db.entities.where("type").notEqual("workspace").count()) > 0;
}

// Removes everything this browser cached for the signed-in user. The caller is responsible for
// having synchronized, or for having the user's consent to drop unsent changes.
// A wipe that cannot finish (for example a database held by another tab) stays marked and is
// completed by finishInterruptedWipe() on the next start.
export async function clearLocalData(timeoutMs = 4000) {
  localStorage.setItem(wipePendingKey, "1");
  localDataKeys.forEach((key) => localStorage.removeItem(key));
  // Deletions and restorations waiting to be sent are one key each (lib/pending-markers.ts).
  clearAllMarkers(localStorage);
  // So are notes drafts and the notes of open texts, one per tab.
  clearNotesDrafts(localStorage);
  clearOpenTexts(localStorage);
  // Nothing local is left to push: the next start must take the server copy as it is, not merge.
  localStorage.setItem(serverSyncedKey, "1");
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
  localStorage.removeItem(wipePendingKey);
}

export async function finishInterruptedWipe() {
  if (localStorage.getItem(wipePendingKey) !== "1") return;
  await clearLocalData().catch(() => undefined);
}
