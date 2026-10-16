// Run by tests/backups-v2.test.mjs in child processes against a data directory of its own.
//   seed   : fills the store with notes (default heap)
//   export : writes and verifies the export ZIP; the test runs it with a small --max-old-space-size
//   naive  : what the first version did (SELECT * of a whole table, one JSON string); must not fit the same heap
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

const [dataDir, mode, count] = process.argv.slice(2);
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
const store = await import("../../lib/server-store.ts");
const pack = await import("../../lib/backup-package.ts");
const database = store.getDatabase();

if (mode === "seed") {
  const insert = database.prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)");
  database.exec("BEGIN");
  for (let index = 0; index < Number(count); index += 1) {
    const note = { id: `note:low-${index}`, type: "note", title: `Low ${index}`, content: randomBytes(22_000).toString("base64"), status: "active", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 2 + index };
    insert.run(note.id, JSON.stringify(note), note.updatedAt);
  }
  database.exec("COMMIT");
  console.log(JSON.stringify({ rows: Number(count) }));
} else if (mode === "export") {
  const copy = store.createExportCopy();
  const zipPath = path.join(dataDir, "low-heap-export.zip");
  const manifest = pack.writeExportZip(copy.path, zipPath, { counts: copy.counts, migrations: copy.migrations });
  copy.dispose();
  pack.verifyExportOutput(zipPath, path.join(dataDir, "low-heap-check.sqlite"));
  console.log(JSON.stringify({ entries: Object.keys(manifest.files).length, zipBytes: statSync(zipPath).size, entitiesJson: manifest.files["data/entities.json"].bytes }));
} else {
  const copy = store.createExportCopy();
  const { DatabaseSync } = await import("node:sqlite");
  const source = new DatabaseSync(copy.path, { readOnly: true });
  const text = JSON.stringify(source.prepare("SELECT * FROM entities").all());
  console.log(JSON.stringify({ length: text.length }));
}
