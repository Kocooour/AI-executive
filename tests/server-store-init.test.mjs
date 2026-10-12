import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "lumi-store-init-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const databasePath = path.join(dataDir, "store.sqlite");

test("a failed initialisation is not cached; the next call retries the migrations", async () => {
  // A schema_migrations table without applied_at makes recording the first migration fail.
  const broken = new DatabaseSync(databasePath);
  broken.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
  broken.close();

  const store = await import("../lib/server-store.ts");
  assert.throws(() => store.getDatabase());
  // Still failing: a second call starts again instead of returning the half-initialised connection.
  assert.throws(() => store.getDatabase());

  const repair = new DatabaseSync(databasePath);
  repair.exec("DROP TABLE schema_migrations");
  repair.close();

  const database = store.getDatabase();
  const applied = database.prepare("SELECT id FROM schema_migrations").all().map((row) => row.id);
  assert.ok(applied.includes("2026-10-context-claims-three-level-sensitivity"));
  assert.ok(database.prepare("SELECT 1 FROM entities WHERE id = 'workspace:personal'").get());
  assert.equal(store.getDatabase(), database);
});
