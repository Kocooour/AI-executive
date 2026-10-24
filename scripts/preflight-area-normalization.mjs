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
  // Both mirror timestamps are written with the payload by replaceUnchecked
  // (lib/server-store.ts); they must agree, or the offline copy is inconsistent.
  const entities = db.prepare("SELECT id, payload, updated_at FROM entities ORDER BY id").all().map(row => {
    const e = JSON.parse(row.payload);
    if (e.id !== row.id) throw new AreaNormalizationBlocked(["entity-id-disagrees"]);
    if (!Number.isSafeInteger(row.updated_at) || row.updated_at !== (e.updatedAt || 0))
      throw new AreaNormalizationBlocked(["entity-timestamp-disagrees"]);
    return e;
  });
  const relations = db.prepare("SELECT id, payload, created_at FROM relations ORDER BY id").all().map(row => {
    const r = JSON.parse(row.payload);
    if (r.id !== row.id) throw new AreaNormalizationBlocked(["relation-id-disagrees"]);
    if (!Number.isSafeInteger(row.created_at) || row.created_at !== (r.createdAt || 0))
      throw new AreaNormalizationBlocked(["relation-timestamp-disagrees"]);
    return r;
  });
  const tombstones = db.prepare("SELECT id, deleted_at FROM tombstones ORDER BY id").all()
    .map(r => ({ id: r.id, deletedAt: r.deleted_at }));
  const metadata = new Map(db.prepare("SELECT key, value FROM metadata WHERE key IN ('revision','restoreGeneration')")
    .all().map(row => [row.key, row.value]));
  // readSnapshot() defaults a missing restoreGeneration to 0 until the first
  // restore/import. A present but malformed value is never a valid default.
  if (!metadata.has("revision"))
    throw new AreaNormalizationBlocked(["missing-store-revision"]);
  function counter(key, value) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) ||
        !Number.isSafeInteger(Number(value)))
      throw new AreaNormalizationBlocked(["invalid-store-" + key]);
    return Number(value);
  }
  const revision = counter("revision", metadata.get("revision"));
  const restoreGeneration = metadata.has("restoreGeneration")
    ? counter("restore-generation", metadata.get("restoreGeneration")) : 0;
  const at = entities.reduce((n, e) => Math.max(n, Number.isFinite(e.updatedAt) ? e.updatedAt : 0), 0);
  const manifest = createAreaPreflight({ entities, relations }, { revision, restoreGeneration, tombstones }, at);
  console.log(JSON.stringify({ status: "offline-preflight-only", ...manifest }, null, 2));
} catch (e) {
  // No payloads, private titles, entity IDs or file paths in failure output.
  const reasons = e instanceof AreaNormalizationBlocked
    ? [...new Set(e.issues.map(reason => String(reason).split(":")[0]))] : [e?.code ?? e?.name ?? "unknown"];
  console.error(JSON.stringify({ status: "blocked", reasons }));
  process.exitCode = 1;
} finally { db?.close(); }
