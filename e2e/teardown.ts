import { rm } from "node:fs/promises";
import path from "node:path";
import { reportedClientErrors } from "./client-errors";

type CleanupOptions = {
  cleanupMs?: number;
  retryMs?: number;
  remove?: (directory: string) => Promise<void> | void;
  warn?: (message: string) => void;
};

/** Best-effort teardown of this run's synthetic files only. Native Chrome
 * utility/crashpad processes can finish writes after the BFCache spec ends;
 * their late writes must not override a successful browser witness. */
export async function removeIsolatedRunDir(
  runDir: string,
  { cleanupMs = 10_000, retryMs = 100,
    remove = (directory) => rm(directory, { recursive: true, force: true, maxRetries: 0 }),
    warn = console.warn }: CleanupOptions = {},
): Promise<void> {
  if (!runDir || !path.basename(runDir).startsWith("lumi-e2e-")) return;
  const deadline = Date.now() + Math.max(0, cleanupMs);
  let delay = Math.max(1, retryMs);
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      await remove(runDir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = ["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"].includes(code || "");
      if (!transient || Date.now() >= deadline) {
        warn("Isolated E2E run directory cleanup failed (" + attempts +
          " attempts); retaining " + runDir + ": " + String(error));
        return;
      }
      await new Promise<void>(resolve => setTimeout(
        resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
      delay = Math.min(delay * 2, 1_000);
    }
  }
}

// Removes the run's private directory: its data, session and security outbox. Traces of failed
// scenarios are not in it; the runner keeps them in the checkout's ignored test-results/.
// Browser-reported errors must still fail the run. Only deletion failures are warnings.
export default async function teardown(): Promise<void> {
  const runDir = process.env.LUMI_E2E_RUN_DIR;
  if (!runDir || !path.basename(runDir).startsWith("lumi-e2e-")) return;
  let errors: string[] = [];
  try {
    errors = reportedClientErrors(runDir);
  } finally {
    // Do not let a racing Chrome helper's ENOTEMPTY conceal real assertion
    // failures, or incorrectly mark an otherwise passing release gate red.
    await removeIsolatedRunDir(runDir);
  }
  if (errors.length) throw new Error(
    `The app reported ${errors.length} error(s) from the browser to the server during the run (best-effort check):\n${errors.join("\n")}`);
}
