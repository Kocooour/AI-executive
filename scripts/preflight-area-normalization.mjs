// Strictly read-only D2a preflight of a consistent OFFLINE SQLite copy.
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { AreaNormalizationBlocked } from "../lib/area-normalization.ts";
import { createAreaPreflight } from "../lib/area-normalization-preflight.ts";
import { readAreaNormalizationSource } from "../lib/area-normalization-source.ts";

if (process.argv.length !== 4 || process.argv[2] !== "--offline-copy") {
  console.error("Usage: node --experimental-loader ./tests/ts-loader.mjs scripts/preflight-area-normalization.mjs --offline-copy <copied-store.sqlite>");
  process.exit(2);
}
let db;
try {
  if (!statSync(process.argv[3]).isFile()) throw new Error("Not a regular file");
  db = new DatabaseSync(process.argv[3], { readOnly: true });
  // The exact reader the transactional applicator uses (lib/area-normalization-source.ts).
  const { source, identity, at } = readAreaNormalizationSource(db);
  const manifest = createAreaPreflight(source, identity, at);
  console.log(JSON.stringify({ status: "offline-preflight-only", ...manifest }, null, 2));
} catch (e) {
  // No payloads, private titles, entity IDs or file paths in failure output.
  const reasons = e instanceof AreaNormalizationBlocked
    ? [...new Set(e.issues.map(reason => String(reason).split(":")[0]))] : [e?.code ?? e?.name ?? "unknown"];
  console.error(JSON.stringify({ status: "blocked", reasons }));
  process.exitCode = 1;
} finally { db?.close(); }
