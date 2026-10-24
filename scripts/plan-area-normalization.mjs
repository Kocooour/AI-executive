// Read-only inventory/planning of an OFFLINE JSON snapshot. Never opens the live
// SQLite store, changes its revision, or writes normalized content back to disk.
// Usage: node --experimental-loader ./tests/ts-loader.mjs scripts/plan-area-normalization.mjs snapshot.json
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { planAreaNormalization, AreaNormalizationBlocked } from "../lib/area-normalization.ts";
import { validateSnapshotStructure } from "../lib/snapshot-validation.ts";

const filename = process.argv[2];
if (!filename || process.argv.length !== 3) {
  console.error("Usage: node --experimental-loader ./tests/ts-loader.mjs scripts/plan-area-normalization.mjs <offline-snapshot.json>");
  process.exit(2);
}
try {
  const bytes = readFileSync(filename);
  const inputSha256 = createHash("sha256").update(bytes).digest("hex");
  const snapshot = JSON.parse(bytes.toString("utf8"));
  try {
    validateSnapshotStructure(snapshot);
  } catch {
    throw new AreaNormalizationBlocked(["snapshot-structure-invalid"]);
  }
  // A large snapshot must not exceed the JS argument stack.
  const timestamp = snapshot.entities.reduce((max, entity) => Math.max(max, entity.updatedAt || 0), 0);
  const { report } = planAreaNormalization(snapshot, timestamp);
  console.log(JSON.stringify({ status: "plan-only", inputSha256, report }, null, 2));
} catch (error) {
  // Do not print entity content, note bodies or source mail into logs.
  if (error instanceof AreaNormalizationBlocked) {
    console.error(JSON.stringify({ status: "blocked", issues: error.issues }));
  } else {
    console.error(JSON.stringify({ status: "failed", error: error?.name ?? "unknown" }));
  }
  process.exitCode = 1;
}
