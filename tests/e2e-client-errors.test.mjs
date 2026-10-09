import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// The best-effort second check of the browser tests (e2e/client-errors.ts) reads what the app
// reported to the server; this checks the reading, not the timing (which it does not promise).
const { reportedClientErrors } = await import("../e2e/client-errors.ts");

test("reported client errors are read from the run's database; other events and missing data are ignored", () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "lumi-e2e-check-"));
  try {
    assert.deepEqual(reportedClientErrors(runDir), []);
    mkdirSync(path.join(runDir, "data"));
    const database = new DatabaseSync(path.join(runDir, "data", "store.sqlite"));
    database.exec("CREATE TABLE security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER, action TEXT, outcome TEXT, actor_hash TEXT, details TEXT)");
    const insert = database.prepare("INSERT INTO security_events (created_at, action, outcome, actor_hash, details) VALUES (1, ?, 'failed', 'x', ?)");
    insert.run("client.runtime", JSON.stringify({ kind: "unhandledrejection", message: "boom", source: "http://localhost/?view=Inbox" }));
    insert.run("auth.login", JSON.stringify({ reason: "bad password" }));
    insert.run("client.runtime", "not json");
    database.close();
    assert.deepEqual(reportedClientErrors(runDir), ["unhandledrejection: boom (http://localhost/?view=Inbox)", "not json"]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
