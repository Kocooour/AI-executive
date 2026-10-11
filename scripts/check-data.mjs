// Read-only verification of a Lumi SQLite file (live data, or a copied backup).
// Prints only non-content facts: integrity result, row counts, size and checksum.
// Exit code: 0 integrity ok and at least one table, 1 not ok / unreadable / no tables, 2 usage error.
//
// Notes for the migration procedure:
// - With WAL the recent data may live in `-wal`, so the checksum of the main file alone proves nothing;
//   the table counts (and the backup manifest) are the real controls. The WAL size and checksum are
//   reported so a difference is visible.
// - Even a read-only open creates `-wal`/`-shm` when they are missing, and updates `-shm`. Run it as
//   the account that owns the data, or on a root-owned copy.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
if (!file || process.argv.length > 3) {
  console.error("Usage: node scripts/check-data.mjs <path to store.sqlite>");
  process.exit(2);
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
// Read in fixed-size pieces: a large database or WAL is never held in memory as a whole (and whole-file
// reads fail above 2 GiB).
function sha256(path) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(path, "r");
  try {
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
const result = {
  file, integrity: "unreadable", foreignKeyViolations: null, tables: {},
  mainFileBytes: null, mainFileSha256: null, walBytes: null, walSha256: null, shmBytes: null,
};
let code = 1;
try {
  // Facts about the files are taken before opening: opening may create or touch -wal/-shm.
  result.mainFileBytes = statSync(file).size;
  result.mainFileSha256 = sha256(file);
  if (existsSync(`${file}-wal`)) { result.walBytes = statSync(`${file}-wal`).size; result.walSha256 = sha256(`${file}-wal`); }
  if (existsSync(`${file}-shm`)) result.shmBytes = statSync(`${file}-shm`).size;
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    result.integrity = integrity.map((row) => Object.values(row)[0]).join("; ");
    result.foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const { name } of tables) {
      result.tables[name] = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get().count);
    }
    // An empty or non-Lumi file passes integrity_check with no tables; that is not a usable database.
    if (Object.keys(result.tables).length === 0) result.problem = "no-tables";
    else if (result.integrity === "ok" && result.foreignKeyViolations === 0) code = 0;
  } finally {
    database.close();
  }
} catch (error) {
  // Only the error class and code are reported: messages may echo paths or content.
  result.integrity = `unreadable (${error?.code ?? error?.name ?? "error"})`;
}
console.log(JSON.stringify(result));
process.exit(code);
