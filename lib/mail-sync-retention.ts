import type { DatabaseSync } from "node:sqlite";

// Privacy-only database maintenance: no Gmail requests, OAuth secrets, user
// sessions, browser state or AI access. Safe to run at startup and repeatedly.
export const MAIL_RETENTION_SWEEP_MS = 15 * 60_000;

export function pruneExpiredMailMetadata(database: DatabaseSync, now = Date.now()): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid retention clock");
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='mail_sync_messages'",
  ).get();
  if (!tables) return 0; // Rolling upgrades and restores of an older schema.
  database.exec("BEGIN IMMEDIATE");
  try {
    // Orphans are deleted as a privacy safeguard; normal disconnect/consent
    // deletion already cascades synchronously through SQLite triggers.
    const result = database.prepare(`DELETE FROM mail_sync_messages AS m
      WHERE NOT EXISTS (
        SELECT 1 FROM mail_sync_accounts AS s
        WHERE s.account_id=m.account_id AND s.workspace_id=m.workspace_id
          AND m.received_at >= (? - s.retention_days * 86400000)
      )`).run(now);
    database.exec("COMMIT");
    return Number(result.changes);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
