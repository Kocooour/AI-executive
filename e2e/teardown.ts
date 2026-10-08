import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Errors the app reported from the browser during the run (unhandled rejections, runtime errors).
// The server keeps them as `client.runtime` security events; a run that produced one fails even
// when every scenario passed, because the user would have met an error nobody saw.
function clientErrors(runDir: string) {
  const file = path.join(runDir, "data", "store.sqlite");
  if (!existsSync(file)) return [];
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return (database.prepare("SELECT details FROM security_events WHERE action = 'client.runtime' ORDER BY id").all() as Array<{ details: string }>)
      .map((row) => {
        try {
          const details = JSON.parse(row.details) as { kind?: string; message?: string; source?: string };
          return `${details.kind || "error"}: ${details.message || "?"}${details.source ? ` (${details.source})` : ""}`;
        } catch {
          return row.details;
        }
      });
  } finally {
    database.close();
  }
}

// Removes the run's private directory: its data, session and security outbox. Traces of failed
// scenarios are not in it; the runner keeps them in the checkout's ignored test-results/.
export default async function teardown() {
  const runDir = process.env.LUMI_E2E_RUN_DIR;
  if (!runDir || !path.basename(runDir).startsWith("lumi-e2e-")) return;
  // A report sent in the last moments of the final scenario may still be on its way.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  let errors: string[] = [];
  try {
    errors = clientErrors(runDir);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  if (errors.length) throw new Error(`The app reported ${errors.length} error(s) from the browser during the run:\n${errors.join("\n")}`);
}
