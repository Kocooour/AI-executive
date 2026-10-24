// D2a part 3: transactional, backed-up Area normalization of the LIVE store, and its rollback.
//   apply:    ... scripts/apply-area-normalization.mjs --manifest <preflight.json> --confirm <sourceSha256>
//   rollback: ... scripts/apply-area-normalization.mjs --rollback <applied.json>   --confirm <resultSha256>
// Run with the service stopped (docs/D2A-AREA-APPLY.md). Data directory: AI_EXECUTIVE_DATA_DIR (absolute).
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AreaNormalizationBlocked } from "../lib/area-normalization.ts";

const USAGE = "Usage: node --experimental-loader ./tests/ts-loader.mjs scripts/apply-area-normalization.mjs " +
  "(--manifest <preflight.json> | --rollback <applied.json>) --confirm <sha256>";
const args = process.argv.slice(2);
const mode = args[0] === "--manifest" || args[0] === "--rollback" ? args[0] : null;
if (!mode || args.length !== 4 || args[2] !== "--confirm" || !/^[0-9a-f]{64}$/.test(args[3])) {
  console.error(USAGE);
  process.exit(2);
}
if (!process.env.AI_EXECUTIVE_DATA_DIR || !path.isAbsolute(process.env.AI_EXECUTIVE_DATA_DIR)) {
  console.error("AI_EXECUTIVE_DATA_DIR must be set to an absolute path.");
  process.exit(2);
}
// A mistyped data directory must never create an empty store: the live store has to exist already.
let storeExists = false;
try { storeExists = statSync(path.join(process.env.AI_EXECUTIVE_DATA_DIR, "store.sqlite")).isFile(); } catch { /* missing */ }
if (!storeExists) {
  console.error(JSON.stringify({ status: "blocked", reasons: ["missing-store"] }));
  process.exit(2);
}
// Failure output carries reason codes only: no IDs, titles, paths or contents.
const fail = (e) => {
  const reasons = e instanceof AreaNormalizationBlocked
    ? [...new Set(e.issues.map(reason => String(reason).split(":")[0]))] : [e?.code ?? e?.name ?? "unknown"];
  console.error(JSON.stringify({ status: "blocked", reasons }));
  process.exitCode = 1;
};
// Loaded only now: the store module resolves the data directory (and may throw) when it is imported.
const {
  applyAreaNormalization, rollbackAreaNormalization, parseAreaPreflightManifest, parseAppliedManifest,
} = await import("../lib/area-normalization-apply.ts");
let manifestInput;
try { manifestInput = JSON.parse(readFileSync(args[1], "utf8")); }
catch { console.error(JSON.stringify({ status: "blocked", reasons: [mode === "--manifest" ? "bad-preflight-manifest" : "bad-applied-manifest"] })); process.exit(1); }
try {
  if (mode === "--manifest") {
    const expected = parseAreaPreflightManifest(manifestInput);
    // Refused before the database is opened (the store opens it lazily, on first use).
    if (args[3] !== expected.sourceSha256) { console.error(JSON.stringify({ status: "blocked", reasons: ["confirm-mismatch"] })); process.exit(2); }
    console.log(JSON.stringify(applyAreaNormalization(expected, { now: Date.now() }), null, 2));
  } else {
    const applied = parseAppliedManifest(manifestInput);
    if (args[3] !== applied.resultSha256) { console.error(JSON.stringify({ status: "blocked", reasons: ["confirm-mismatch"] })); process.exit(2); }
    console.log(JSON.stringify(rollbackAreaNormalization(applied), null, 2));
  }
} catch (e) { fail(e); }
