import { chmodSync, closeSync, copyFileSync, existsSync, openSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HttpInputError } from "./http-security";
import { emptiedInFileTables, includedTables, metadataKeptKeys } from "./backup-scope";

// Backup format 2: a consistent SQLite copy of the database (VACUUM INTO, so the app keeps running), cleaned of
// everything that is not owner data, with a small sidecar describing it. Nothing here touches the live database
// except reading it through the handle it is given.

export const backupFormatVersion = 2;

export interface BackupMeta {
  format: "lumi-backup";
  version: 2;
  createdAt: string;
  label: string;
  migrations: string[];
  counts: Record<string, number>;
  bytes: number;
  sha256: string;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function sha256File(file: string) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(file, "r");
  try {
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

export function countIncludedRows(database: DatabaseSync) {
  const counts: Record<string, number> = {};
  for (const table of includedTables) {
    counts[table] = tableExists(database, table)
      ? Number((database.prepare(`SELECT COUNT(*) AS value FROM ${quote(table)}`).get() as { value: number }).value)
      : 0;
  }
  return counts;
}

export function appliedMigrations(database: DatabaseSync) {
  if (!tableExists(database, "schema_migrations")) return [];
  return (database.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>).map((row) => String(row.id));
}

/**
 * Writes the cleaned copy of `source` to `destination` (which must not exist) and returns what the sidecar needs.
 * Rows of the excluded tables are deleted from the copy, which is then vacuumed so they do not stay in free pages.
 */
export function writeCleanCopy(source: DatabaseSync, destination: string) {
  source.prepare("VACUUM INTO ?").run(destination);
  chmodSync(destination, 0o600);
  const copy = new DatabaseSync(destination);
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
    copy.exec("BEGIN IMMEDIATE");
    for (const table of emptiedInFileTables) {
      if (table === "metadata" || !tableExists(copy, table)) continue;
      copy.exec(`DELETE FROM ${quote(table)}`);
    }
    if (tableExists(copy, "metadata")) {
      const keep = metadataKeptKeys.map(() => "?").join(",");
      copy.prepare(`DELETE FROM metadata WHERE key NOT IN (${keep})`).run(...metadataKeptKeys);
    }
    copy.exec("COMMIT");
    copy.exec("VACUUM");
    const counts = countIncludedRows(copy);
    const migrations = appliedMigrations(copy);
    const integrity = copy.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row as object)[0]).join("; ");
    if (integrity !== "ok") throw new Error("Backup copy failed its integrity check");
    return { counts, migrations };
  } finally {
    copy.close();
  }
}

export function describeFile(file: string) {
  return { bytes: statSync(file).size, sha256: sha256File(file) };
}

export function removeIfExists(file: string) {
  try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/**
 * Copies a backup (never modified) to `copyPath`, checks it and brings it to the current schema through the real
 * migrations with `applySchema`. Refuses, with nothing changed, a file that is not a Lumi database or that was
 * made by a newer version (it names migrations this build does not know).
 */
export function prepareRestoreCopy(
  backupPath: string,
  copyPath: string,
  knownMigrations: readonly string[],
  applySchema: (database: DatabaseSync) => void,
) {
  if (existsSync(copyPath)) throw new Error("Restore copy already exists");
  copyFileSync(backupPath, copyPath);
  chmodSync(copyPath, 0o600);
  try {
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(copyPath);
    } catch {
      throw new HttpInputError("Invalid backup");
    }
    try {
      let integrity = "";
      try {
        integrity = database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row as object)[0]).join("; ");
      } catch {
        throw new HttpInputError("Invalid backup");
      }
      if (integrity !== "ok" || !tableExists(database, "entities") || !tableExists(database, "relations")) {
        throw new HttpInputError("Invalid backup");
      }
      const unknown = appliedMigrations(database).filter((id) => !knownMigrations.includes(id));
      if (unknown.length) throw new HttpInputError("Backup was made by a newer version");
      database.exec("PRAGMA journal_mode = DELETE");
      applySchema(database);
    } finally {
      database.close();
    }
  } catch (error) {
    removeIfExists(copyPath);
    throw error;
  }
}

/** Replaces the owner-data tables of the live database from the attached copy (inside the caller's transaction). */
export function replaceTablesFromAttached(
  database: DatabaseSync,
  schema: string,
  tables: readonly string[],
  cleared: readonly string[],
  afterTable?: (table: string) => void,
) {
  for (const table of tables) {
    const live = (database.prepare(`PRAGMA main.table_info(${quote(table)})`).all() as Array<{ name: string }>).map((row) => String(row.name));
    const copied = new Set((database.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all() as Array<{ name: string }>).map((row) => String(row.name)));
    if (live.length === 0 || live.some((column) => !copied.has(column))) throw new HttpInputError("Invalid backup");
    const columns = live.map(quote).join(", ");
    database.exec(`DELETE FROM main.${quote(table)}`);
    database.exec(`INSERT INTO main.${quote(table)} (${columns}) SELECT ${columns} FROM ${schema}.${quote(table)}`);
    afterTable?.(table);
  }
  for (const table of cleared) database.exec(`DELETE FROM main.${quote(table)}`);
}

export function publish(temporary: string, final: string) {
  chmodSync(temporary, 0o600);
  renameSync(temporary, final);
}
