// D2b part 1, OFFLINE ONLY. This tool cannot apply a migration, rename workspaces or activate sharing.
// SQLite must be a consistent copy. Opening a WAL-mode read-only database can create -wal/-shm sidecars.
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readAreaNormalizationSource } from "../lib/area-normalization-source.ts";
import { auditAreaPartition } from "../lib/area-partition-audit.ts";
import { AreaNormalizationBlocked } from "../lib/area-normalization.ts";
import { classifiedTables } from "../lib/backup-scope.ts";

if (process.argv.length !== 4 || process.argv[2] !== "--offline-copy") {
  console.error("Usage: node --experimental-loader ./tests/ts-loader.mjs scripts/audit-area-partition.mjs --offline-copy <copied-store.sqlite>");
  process.exit(2);
}
let db;
try {
  if (!statSync(process.argv[3]).isFile()) throw new AreaNormalizationBlocked(["not-a-regular-file"]);
  db = new DatabaseSync(process.argv[3], { readOnly: true });
  const { source, identity, at } = readAreaNormalizationSource(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => String(row.name));
  const classified = new Set(classifiedTables());
  // Safe to interpolate only a strictly validated identifier read from SQLite schema.
  if (names.some(name => !/^[a-z_][a-z_0-9]*$/i.test(name)))
    throw new AreaNormalizationBlocked(["unsupported-table-name"]);
  const tableInventory = names.map(table => ({
    table, rows: Number(db.prepare('SELECT COUNT(*) AS n FROM "' + table + '"').get().n),
  }));
  const report = auditAreaPartition(source, identity, at, tableInventory);
  if (names.some(name => !classified.has(name))) {
    report.findings.push({ code: "unclassified-schema-table", count: names.filter(name => !classified.has(name)).length });
    report.findings.sort((a, b) => a.code.localeCompare(b.code, "en"));
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // Privacy: never log table row values, file paths, entity IDs or exception messages.
  const reasons = error instanceof AreaNormalizationBlocked
    ? [...new Set(error.issues.map(i => String(i).split(":")[0]))]
    : [typeof error?.code === "string" && /^E[A-Z]+$/.test(error.code) ? error.code : "read-failed"];
  console.error(JSON.stringify({ status: "blocked", reasons }));
  process.exitCode = 1;
} finally {
  db?.close();
}
