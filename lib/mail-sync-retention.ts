import type { DatabaseSync } from "node:sqlite";

// Privacy-only database maintenance: no Gmail requests, OAuth secrets, user
// sessions, browser state or AI access. Safe to run at startup and repeatedly.
export const MAIL_RETENTION_SWEEP_MS = 15 * 60_000;
const MAIL_DAY_MS = 86_400_000;
// The only retention choices; the schema CHECK and the settings UI mirror them.
export const MAIL_RETENTION_DAYS = [7, 30, 90] as const;

// Shared expiry rule for scheduler and transaction-scoped account maintenance.
// The caller manages its transaction; this helper must never BEGIN/COMMIT.
export function pruneExpiredMailAccount(database: DatabaseSync, accountId: string,
  retentionDays: number, now = Date.now()): number {
  if (!Number.isSafeInteger(now) || now < 0 || !(MAIL_RETENTION_DAYS as readonly number[]).includes(retentionDays))
    throw new Error("Invalid mail retention cutoff");
  return Number(database.prepare("DELETE FROM mail_sync_messages WHERE account_id=? AND received_at < ?")
    .run(accountId, now - retentionDays * MAIL_DAY_MS).changes);
}

export function pruneExpiredMailMetadata(database: DatabaseSync, now = Date.now()): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid retention clock");
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>)
    .map((row) => row.name));
  if (!tables.has("mail_sync_messages") || !tables.has("mail_sync_accounts")) return 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    // Orphans are deleted as a privacy safeguard; normal disconnect/consent
    // deletion already cascades synchronously through SQLite triggers.
    let removed = Number(database.prepare(`DELETE FROM mail_sync_messages AS m
      WHERE NOT EXISTS (
        SELECT 1 FROM mail_sync_accounts AS s
        WHERE s.account_id=m.account_id AND s.workspace_id=m.workspace_id
      )`).run().changes);
    const accounts = database.prepare("SELECT account_id, retention_days FROM mail_sync_accounts")
      .all() as Array<{account_id:string;retention_days:number}>;
    for (const account of accounts)
      removed += pruneExpiredMailAccount(database, account.account_id, account.retention_days, now);
    database.exec("COMMIT");
    return removed;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
