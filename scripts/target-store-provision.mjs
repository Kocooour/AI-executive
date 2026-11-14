#!/usr/bin/env node
// R4 / #422 public CLI. Re-exec the internal worker using only two narrowly
// scoped Node warning filters: node:sqlite experimental status and Node's
// typeless TypeScript module warning. Real errors remain visible and the
// worker emits exactly three settings on success.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeFailureReason } from "./r4-cli-errors.mjs";

const worker = fileURLToPath(new URL("./target-store-provision-worker.mjs", import.meta.url));
const child = spawnSync(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
  worker, ...process.argv.slice(2),
], { stdio: "inherit" });

if (child.error || child.signal) {
  process.stderr.write("R4 target provision: FAIL — " +
    (child.error ? safeFailureReason(child.error) : "operator command interrupted") +
    " (private paths and values suppressed)\n");
  process.exitCode = 1;
} else {
  process.exitCode = child.status ?? 1;
}
