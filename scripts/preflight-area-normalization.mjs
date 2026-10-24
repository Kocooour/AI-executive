// Strictly read-only D2a preflight of a consistent OFFLINE SQLite copy.
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { AreaNormalizationBlocked } from "../lib/area-normalization.ts";
import { createAreaPreflight } from "../lib/area-normalization-preflight.ts";

if (process.argv.length !== 4 || process.argv[2] !== "--offline-copy") {
  console.error("Usage: node --experimental-loader ./tests/ts-loader.mjs scripts/preflight-area-normalization.mjs --offline-copy <copied-store.sqlite>");
  process.exit(2);
}
let db;
try {
  if (!statSync(process.argv[3]).isFile()) throw new Error("Not a regular file");
  db = new DatabaseSync(process.argv[3], { readOnly: true });
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  if (!["entities", "relations", "tombstones", "metadata"].every(t => tables.has(t)))
    throw new AreaNormalizationBlocked(["bad-offline-schema"]);
  if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length > 0)
    throw new AreaNormalizationBlocked(["offline-integrity-failed"]);
  const entities = db.prepare("SELECT id, payload FROM entities ORDER BY id").all().map(row => {
    const e = JSON.parse(row.payload);
    if (e.id !== row.id) throw new AreaNormalizationBlocked(["entity-id-disagrees"]);
    return e;
  });
  const relations = db.prepare("SELECT id, payload FROM relations ORDER BY id").all().map(row => {
    const r = JSON.parse(row.payload);
    if (r.id !== row.id) throw new AreaNormalizationBlocked(["relation-id-disagrees"]);
    return r;
  });
  const tombstoneIds = db.prepare("SELECT id FROM tombstones ORDER BY id").all().map(r => r.id);
  const metadata = new Map(db.prepare("SELECT key, value FROM metadata WHERE key IN ('revision','restoreGeneration')")
    .all().map(row => [row.key, row.value]));
  if (!metadata.has("revision") || !metadata.has("restoreGeneration"))
    throw new AreaNormalizationBlocked(["missing-store-revision"]);
  const revision = Number(metadata.get("revision")), restoreGeneration = Number(metadata.get("restoreGeneration"));
  const at = entities.reduce((n, e) => Math.max(n, Number.isFinite(e.updatedAt) ? e.updatedAt : 0), 0);
  const manifest = createAreaPreflight({ entities, relations }, { revision, restoreGeneration, tombstoneIds }, at);
  console.log(JSON.stringify({ status: "offline-preflight-only", ...manifest }, null, 2));
} catch (e) {
  // No payloads, private titles, entity IDs or file paths in failure output.
  const reasons = e instanceof AreaNormalizationBlocked
    ? [...new Set(e.issues.map(reason => String(reason).split(":")[0]))] : [e?.code ?? e?.name ?? "unknown"];
  console.error(JSON.stringify({ status: "blocked", reasons }));
  process.exitCode = 1;
} finally { db?.close(); }
