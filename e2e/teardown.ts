import { rmSync } from "node:fs";
import path from "node:path";
import { reportedClientErrors } from "./client-errors";

// Removes the run's private directory: its data, session and security outbox. Traces of failed
// scenarios are not in it; the runner keeps them in the checkout's ignored test-results/.
// Before that, a best-effort second check (see e2e/client-errors.ts): if the app reported an error
// from a browser to the server, the run fails. It can miss a report still on its way; every
// scenario already fails on its pages' errors without depending on these reports.
export default function teardown() {
  const runDir = process.env.LUMI_E2E_RUN_DIR;
  if (!runDir || !path.basename(runDir).startsWith("lumi-e2e-")) return;
  let errors: string[] = [];
  try {
    errors = reportedClientErrors(runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  if (errors.length) throw new Error(`The app reported ${errors.length} error(s) from the browser to the server during the run (best-effort check):\n${errors.join("\n")}`);
}
