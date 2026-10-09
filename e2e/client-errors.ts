import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Errors the app itself reported to the test server during a run, read from the run's database
// (`client.runtime` security events). This is a best-effort second check: the app sends these
// reports without waiting for an answer, so one sent in the last moments of a run can arrive after
// this is read. The reliable check is per scenario, from the browser itself (e2e/fixtures.ts).
export function reportedClientErrors(runDir: string) {
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
