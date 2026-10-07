import { db } from "./db";

// Browser-side copies of server data and the bookkeeping of unsent changes.
// Device preferences (theme, language, start view) are not user data and stay.
const pendingSyncKey = "ai-executive-pending-sync";
const localDataKeys = [
  pendingSyncKey,
  "ai-executive-pending-deletions",
  "ai-executive-pending-revivals",
  "ai-executive-active-workspace",
  "ai-executive-write-workspace",
];

export function hasUnsentChanges() {
  return localStorage.getItem(pendingSyncKey) === "1";
}

// Removes everything this browser cached for the signed-in user. The caller is responsible for
// having synchronized, or for having the user's consent to drop unsent changes.
export async function clearLocalData() {
  try {
    await db.transaction("rw", db.entities, db.relations, async () => {
      await db.entities.clear();
      await db.relations.clear();
    });
  } catch {
    await db.delete();
  }
  localDataKeys.forEach((key) => localStorage.removeItem(key));
  // Nothing local is left to push: the next start must take the server copy as it is, not merge.
  localStorage.setItem("ai-executive-server-synced", "1");
}
