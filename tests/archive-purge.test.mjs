import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { applySchema } from "../lib/server-store.ts";
import { ARCHIVE_TABLES, purgeArchive } from "../scripts/archive-purge.mjs";

// Synthetic copy only; never load a runtime or target personal-v1 database.
const root = mkdtempSync(path.join(tmpdir(), "lumi-501-purge-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
function fixture(backup = true) {
  const dir = path.join(root, "fixture-" + ++serial);
  mkdirSync(dir);
  const dbPath = path.join(dir, "store.sqlite");
  const backupDirectory = path.join(dir, "backups");
  mkdirSync(backupDirectory);
  if (backup) mkdirSync(path.join(backupDirectory, "deploy-abcdefgh"));
  const db = new DatabaseSync(dbPath);
  applySchema(db);
  // Existing production uses the normal revision metadata; after purge it
  // must still be present and prevent startup from re-seeding test Archive.
  db.prepare("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run("revision","42");
  // The workspace is a structural container (calendar, iCloud, Gmail, agents,
  // attention resolve it): the purge must keep it.
  db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)")
    .run("workspace:personal", JSON.stringify({ id: "workspace:personal", type: "workspace",
      title: "Personal", workspaceId: "personal", status: "active", properties: {} }), 1);
  // The archive owns these four tables, including a historical note revision.
  db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)")
    .run("task:old", JSON.stringify({ id: "task:old", type: "task", title: "synthetic" }), 1);
  db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)")
    .run("note:old", JSON.stringify({ id: "note:old", type: "note", title: "synthetic" }), 1);
  db.prepare("INSERT INTO relations(id,payload,created_at) VALUES(?,?,?)")
    .run("relation:old", JSON.stringify({
      id: "relation:old", sourceEntityId: "task:old", targetEntityId: "note:old",
    }), 1);
  db.prepare("INSERT INTO tombstones(id,deleted_at) VALUES(?,?)").run("task:deleted", 1);
  db.prepare(
    "INSERT INTO note_revisions(id,note_id,workspace_id,revision,title,content," +
    "content_sha256,origin,store_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
  ).run("note-revision:old", "note:old", "personal", 1, "synthetic", "synthetic",
    "a".repeat(64), "test", 1, 1);
  // These are explicitly protected tables. Passkey bytes, mail/calendar
  // settings, session histories and metadata must survive byte-for-byte.
  db.prepare("INSERT INTO passkey_credentials(credential_id,public_key,counter,transports," +
    "device_type,backed_up,rp_id,label,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("passkey:test", Buffer.from([1, 2, 3]), 0, "[]", "singleDevice", 0,
      "example.test", "synthetic passkey", 1);
  db.prepare("INSERT INTO calendar_sources(id,workspace_id,provider,label,encrypted_url," +
    "status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("calendar:test", "personal", "ical", "synthetic", "encrypted", "active", 1, 1);
  db.prepare("INSERT INTO work_sessions(id,workspace_id,task_id,state,revision," +
    "accumulated_ms,running_since,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("session:test", "personal", "task:old", "completed", 1, 100, null, 1, 1, 1);
  db.prepare(
    "INSERT INTO mail_accounts(id,provider,workspace_id,email," +
    "encrypted_refresh_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
  ).run("mail:test", "gmail", "personal", "test@example.invalid",
    "synthetic-encrypted-token", 1, 1);
  const protectedTables = ["passkey_credentials", "mail_accounts",
    "calendar_sources", "work_sessions", "metadata", "semantic_index_outbox"];
  const protectedRows = Object.fromEntries(protectedTables.map(table =>
    [table, db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all()]));
  const triggerSql = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  db.close();
  return { dbPath, backupDirectory, protectedTables, protectedRows, triggerSql };
}
const archiveRows = (db, table) => db.prepare('SELECT COUNT(*) AS n FROM "' + table + '"' +
  (table === "entities" ? " WHERE json_extract(payload,'$.type') IS NOT 'workspace'" : "")).get().n;
const workspaceRows = db => db.prepare(
  "SELECT COUNT(*) AS n FROM entities WHERE id='workspace:personal'").get().n;
const run = (f, options = {}) => purgeArchive({
  dbPath: f.dbPath, backupDirectory: f.backupDirectory,
  actor: "ai-executive", state: "inactive", ...options,
});
test("dry-run, atomic apply, protected data and triggers, then zero-count second run", () => {
  const f = fixture();
  const dry = run(f, { dryRun: true });
  assert.deepEqual(dry.before, { note_revisions: 1, relations: 1, tombstones: 1, entities: 2 });
  assert.deepEqual(dry.after, dry.before);
  assert.equal(dry.workspacesKept, 1);
  const removed = run(f);
  assert.equal(removed.integrityOk, true);
  assert.equal(removed.foreignKeyViolations, 0);
  assert.deepEqual(removed.before, dry.before);
  assert.deepEqual(removed.after, { note_revisions: 0, relations: 0, tombstones: 0, entities: 0 });
  assert.equal(removed.workspacesKept, 1);
  // Simulate an ACTUAL server-store restart, not just reopening raw SQLite.
  execFileSync(process.execPath, [
    "--experimental-loader","./scripts/target-staging-ts-loader.mjs",
    "--input-type=module","-e",
    "import { getDatabase } from './lib/server-store.ts'; getDatabase().close();",
  ], { cwd: process.cwd(), env: { ...process.env,
    AI_EXECUTIVE_DATA_DIR: path.dirname(f.dbPath) },
    stdio: ["ignore","pipe","pipe"], timeout: 20_000 });
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    for (const table of ARCHIVE_TABLES) assert.equal(archiveRows(db, table), 0, table);
    assert.equal(workspaceRows(db), 1, "workspace:personal survives purge and restart");
    for (const table of f.protectedTables)
      assert.deepEqual(db.prepare('SELECT * FROM "' + table + '" ORDER BY rowid').all(),
        f.protectedRows[table], table + " must be unmodified");
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),
      f.triggerSql, "triggers must be fully restored");
  } finally { db.close(); }
  const again = run(f);
  assert.deepEqual(again.before, removed.after);
  assert.deepEqual(again.after, removed.after);
});
test("refuses active service, missing backup, wrong user without deleting any row", () => {
  const f = fixture(false);
  assert.throws(() => run(f, { state: "active" }), /service-not-stopped/);
  assert.throws(() => run(f), /deployment-backup-required/);
  assert.throws(() => run(f, { actor: "root" }), /operator-user-required/);
  assert.throws(() => run(f, { state: "activating" }), /service-not-stopped/);
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 3); }
  finally { db.close(); }
});
test("fresh installation still seeds its default workspace on first server startup", () => {
  const dir = path.join(root, "blank-" + ++serial);
  mkdirSync(dir);
  execFileSync(process.execPath, [
    "--experimental-loader","./scripts/target-staging-ts-loader.mjs",
    "--input-type=module","-e",
    "import { getDatabase } from './lib/server-store.ts'; getDatabase().close();",
  ], { cwd: process.cwd(), env: { ...process.env, AI_EXECUTIVE_DATA_DIR: dir },
    stdio: ["ignore","pipe","pipe"], timeout: 20_000 });
  const db = new DatabaseSync(path.join(dir,"store.sqlite"), { readOnly:true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entities WHERE id='workspace:personal'").get().n,1);
  } finally { db.close(); }
});

test("calendar, iCloud and Gmail workspace checks still resolve after purge and restart", async () => {
  const f = fixture();
  run(f);
  // The same predicate every workspace-scoped legacy API uses (calendar route,
  // saveCalendarSource, icloud-calendar, mail-gmail, agents, attention).
  const out = execFileSync(process.execPath, [
    "--experimental-loader","./scripts/target-staging-ts-loader.mjs",
    "--input-type=module","-e",
    "import { readSnapshot, getDatabase } from './lib/server-store.ts';" +
    "const ok = readSnapshot().entities.some(e => e.type === 'workspace' && e.workspaceId === 'personal');" +
    "const other = readSnapshot().entities.filter(e => e.type !== 'workspace').length;" +
    "getDatabase().close(); process.stdout.write(JSON.stringify({ ok, other }));",
  ], { cwd: process.cwd(), env: { ...process.env, AI_EXECUTIVE_DATA_DIR: path.dirname(f.dbPath) },
    encoding: "utf8", timeout: 20_000 });
  assert.deepEqual(JSON.parse(out), { ok: true, other: 0 });
});
