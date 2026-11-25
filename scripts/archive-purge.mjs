#!/usr/bin/env node
// #501 (2026-11-25): one-shot deletion of test-only legacy Archive data.
// No target personal-v1 writes, manifests, epochs, or replay fences.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SERVICE = "ai-executive";
const STORE = "/var/lib/ai-executive/store.sqlite";
const BACKUPS = "/var/backups/ai-executive";
export const ARCHIVE_TABLES = Object.freeze(["note_revisions", "relations", "tombstones", "entities"]);
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const count = (db, table) => Number(db.prepare("SELECT COUNT(*) AS n FROM " + quote(table)).get().n);
const counts = db => Object.fromEntries(ARCHIVE_TABLES.map(table => [table, count(db, table)]));
const changes = db => Number(db.prepare("SELECT total_changes() AS n").get().n);

function serviceState() {
  return execFileSync("systemctl", ["show", "-p", "ActiveState", "--value", SERVICE], {
    encoding: "utf8", timeout: 10_000,
  }).trim();
}
function hasBackup(directory) {
  // The operator user needs metadata-only read/list access to BACKUPS;
  // actual deploy-* backup directories remain root-owned and mode 0700.
  return readdirSync(directory, { withFileTypes: true })
    .some(item => /^deploy-[A-Za-z0-9]{8}$/.test(item.name) && item.isDirectory());
}
function integrity(db) {
  const rows = db.prepare("PRAGMA integrity_check").all();
  const ok = rows.length === 1 && Object.values(rows[0])[0] === "ok";
  const violations = db.prepare("PRAGMA foreign_key_check").all().length;
  return { integrityOk: ok, foreignKeyViolations: violations };
}

/**
 * The CLI pins all production paths and obtains the real user and systemd
 * state. Injectable parameters only make synthetic unit tests possible.
 */
export function purgeArchive({ dbPath = STORE, backupDirectory = BACKUPS,
  actor = userInfo().username, state = serviceState, dryRun = false } = {}) {
  if (actor !== SERVICE) throw new Error("operator-user-required");
  const actualState = typeof state === "function" ? state() : state;
  if (actualState !== "inactive" && actualState !== "failed") {
    throw new Error("service-not-stopped");
  }
  if (!hasBackup(backupDirectory)) throw new Error("deployment-backup-required");

  const db = new DatabaseSync(dbPath, { readOnly: dryRun });
  try {
    const before = counts(db);
    if (dryRun) return { dryRun: true, before, after: before };
    // All work, including removal and recreation of DELETE triggers, is one
    // atomic SQLite transaction. Without suppressing those triggers,
    // deleting entities also writes semantic outbox/mail integration rows.
    // This operator must not change ANY non-Archive table.
    db.exec("PRAGMA foreign_keys=ON");
    const startingChanges = changes(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      const names = ARCHIVE_TABLES.map(() => "?").join(",");
      const triggers = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (" + names + ")"
      ).all(...ARCHIVE_TABLES);
      for (const trigger of triggers) {
        if (!trigger.sql) throw new Error("unsupported-trigger");
        db.exec("DROP TRIGGER " + quote(trigger.name));
      }
      for (const table of ARCHIVE_TABLES) db.exec("DELETE FROM " + quote(table));
      for (const trigger of triggers) db.exec(trigger.sql);
      // total_changes counts changes caused by foreign-key actions and
      // triggers too, so any modification of another table aborts atomically.
      const deleted = Object.values(before).reduce((sum, n) => sum + n, 0);
      if (changes(db) - startingChanges !== deleted) throw new Error("unexpected-table-change");
      const after = counts(db);
      if (Object.values(after).some(n => n !== 0)) throw new Error("archive-not-empty");
      const check = integrity(db);
      if (!check.integrityOk || check.foreignKeyViolations !== 0) throw new Error("sqlite-integrity-failed");
      db.exec("COMMIT");
      return { dryRun: false, before, after, ...check };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally { db.close(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3 || !["--dry-run", "--apply"].includes(process.argv[2])) {
    console.error("Usage: node scripts/archive-purge.mjs --dry-run|--apply");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(purgeArchive({ dryRun: process.argv[2] === "--dry-run" })));
    } catch (e) {
      // Do not print data, source paths, SQLite payloads or error objects.
      console.error("Archive purge refused: " +
        (["operator-user-required", "service-not-stopped", "deployment-backup-required",
          "unexpected-table-change", "sqlite-integrity-failed", "archive-not-empty"]
          .includes(e?.message) ? e.message : "precondition-or-database-error"));
      process.exitCode = 1;
    }
  }
}
