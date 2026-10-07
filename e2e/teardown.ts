import { rmSync } from "node:fs";
import path from "node:path";

// Removes the run's private directory: its data, session and security outbox. Traces of failed
// scenarios are not in it; the runner keeps them in the checkout's ignored test-results/.
export default function teardown() {
  const runDir = process.env.LUMI_E2E_RUN_DIR;
  if (!runDir || !path.basename(runDir).startsWith("lumi-e2e-")) return;
  rmSync(runDir, { recursive: true, force: true });
}
