// Read-only verification of a Lumi SQLite file (live data, or a copied backup).
// Prints only non-content facts: integrity result, row counts, size and checksum.
// Exit code: 0 integrity ok, 1 not ok / unreadable, 2 usage error.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
if (!file || process.argv.length > 3) {
  console.error("Usage: node scripts/check-data.mjs <path to store.sqlite>");
  process.exit(2);
}

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const result = { file, integrity: "unreadable", foreignKeyViolations: null, tables: {}, sizeBytes: null, sha256: null };
let code = 1;
try {
  result.sizeBytes = statSync(file).size;
  result.sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    result.integrity = integrity.map((row) => Object.values(row)[0]).join("; ");
    result.foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const { name } of tables) {
      result.tables[name] = Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get().count);
    }
    if (result.integrity === "ok" && result.foreignKeyViolations === 0) code = 0;
  } finally {
    database.close();
  }
} catch (error) {
  // Only the error class and code are reported: messages may echo paths or content.
  result.integrity = `unreadable (${error?.code ?? error?.name ?? "error"})`;
}
console.log(JSON.stringify(result));
process.exit(code);
