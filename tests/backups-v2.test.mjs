import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-backups-v2-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const scope = await import("../lib/backup-scope.ts");
const engine = await import("../lib/backup-engine.ts");
const pack = await import("../lib/backup-package.ts");
const migrations = await import("../lib/schema-migrations.ts");

const backupsDir = path.join(dataDir, "backups");
const db = () => store.getDatabase();
const quote = (name) => `"${name}"`;

const task = (id, title = id) => ({ id, type: "task", title, status: "open", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1 });
const note = (id, title, content) => ({ id, type: "note", title, content, status: "active", workspaceId: "personal", properties: { projectId: "project:p" }, createdAt: 1, updatedAt: 2 });
const project = { id: "project:p", type: "project", title: "P", status: "active", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1 };
const workspaceEntity = () => store.readSnapshot().entities.find((entity) => entity.id === "workspace:personal");
const setEntities = (entities, deleted = []) => {
  const current = store.readSnapshot();
  const result = store.replaceSnapshot(current.revision, [workspaceEntity(), ...entities], [], deleted, [], current.restoreGeneration);
  assert.equal(result.conflict, false);
};
const dump = (database, table) => JSON.stringify(database.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all(), (_key, value) => value instanceof Uint8Array ? `blob:${Buffer.from(value).toString("hex")}` : value);
const dumpAll = (tables) => Object.fromEntries(tables.map((table) => [table, dump(db(), table)]));

const overrides = {
  work_sessions: { state: "completed", running_since: null },
  work_session_intervals: { ended_at: 5 },
  mail_sync_accounts: { retention_days: 30 },
};
// One row for a table, every column filled from the schema, so that a table added later is covered without edits here.
function seed(table, tag) {
  const columns = db().prepare(`PRAGMA table_info(${quote(table)})`).all();
  const base = tag === "A" ? 100 : 200;
  const values = columns.map((column, index) => {
    const own = overrides[table]?.[column.name];
    if (own !== undefined) return own;
    const type = String(column.type).toUpperCase();
    if (type.includes("INT")) return base + index;
    if (type.includes("BLOB")) return Buffer.from(`${tag}-${column.name}`);
    return `${tag}-${table}-${column.name}`;
  });
  db().prepare(`INSERT INTO ${quote(table)} (${columns.map((column) => quote(column.name)).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
}
const replaced = scope.replacedTables;
const excludedSeedable = scope.excludedTables.filter((table) => table !== "schema_migrations" && table !== "metadata");
const keptSeedable = excludedSeedable.filter((table) => !scope.excludedClearedTables.includes(table));
const resetTables = (tables, tag) => { for (const table of tables) { db().exec(`DELETE FROM ${quote(table)}`); seed(table, tag); } };
const files = (extension) => readdirSync(backupsDir).filter((entry) => entry.endsWith(extension));

test("every table of the schema is classified as included or excluded, once", () => {
  const actual = db().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  const classified = scope.classifiedTables();
  assert.deepEqual(actual.filter((name) => !classified.includes(name)), [], "a table is in the schema but not in backup-scope.ts");
  assert.deepEqual(classified.filter((name) => !actual.includes(name)), [], "a classified table does not exist");
  assert.equal(new Set(classified).size, classified.length, "a table is listed twice");
});

test("a full backup is a cleaned database copy with a sidecar; excluded data is not in the file", () => {
  setEntities([project, task("task:1", "First"), note("note:1", "Note", "text one")]);
  resetTables(replaced, "A");
  resetTables(excludedSeedable, "A");
  db().prepare("INSERT INTO metadata (key, value) VALUES ('vapidKeys', 'secret-push-key') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

  const summary = store.createBackup("manual");
  assert.equal(summary.format, "full");
  assert.ok(summary.name.endsWith("-manual.sqlite"));
  const file = path.join(backupsDir, summary.name);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const sidecarFile = path.join(backupsDir, summary.name.replace(/\.sqlite$/, ".meta.json"));
  assert.equal(statSync(sidecarFile).mode & 0o777, 0o600);
  const meta = JSON.parse(readFileSync(sidecarFile, "utf8"));
  assert.equal(meta.format, "lumi-backup");
  assert.equal(meta.version, 2);
  assert.equal(meta.sha256, engine.sha256File(file));
  assert.equal(meta.bytes, statSync(file).size);
  assert.deepEqual(meta.migrations, migrations.schemaMigrations.map((migration) => migration.id).sort());
  assert.equal(meta.counts.entities, store.readSnapshot().entities.length);
  assert.equal(meta.counts.note_revisions, 1);
  assert.equal(readdirSync(backupsDir).some((entry) => entry.endsWith(".tmp")), false);

  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    for (const table of scope.emptiedInFileTables.filter((name) => name !== "metadata")) {
      assert.equal(copy.prepare(`SELECT COUNT(*) AS value FROM ${quote(table)}`).get().value, 0, table);
    }
    assert.deepEqual(copy.prepare("SELECT key FROM metadata ORDER BY key").all().map((row) => row.key), ["revision", "updatedAt"]);
    for (const table of scope.includedTables) {
      assert.equal(copy.prepare(`SELECT COUNT(*) AS value FROM ${quote(table)}`).get().value, meta.counts[table], table);
    }
    for (const table of replaced) assert.equal(dump(copy, table), dump(db(), table), table);
    assert.ok(copy.prepare("SELECT COUNT(*) AS value FROM schema_migrations").get().value > 0);
    assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    copy.close();
  }
  // Removed rows are not left in free pages either.
  const bytes = readFileSync(file);
  for (const secret of ["secret-push-key", "A-passkey_credentials-credential_id", "A-security_events-action"]) {
    assert.equal(bytes.includes(Buffer.from(secret)), false, secret);
  }
  const listed = store.listBackups().find((backup) => backup.name === summary.name);
  assert.equal(listed.format, "full");
  assert.equal(listed.entityCount, meta.counts.entities);
  assert.equal(listed.noteRevisionCount, 1);
  assert.equal(listed.error, undefined);
});

test("restore returns every included table to the backup, keeps excluded tables, clears the cleared ones", () => {
  const backup = store.listBackups().find((entry) => entry.label === "manual" && entry.format === "full");
  const backupDb = new DatabaseSync(path.join(backupsDir, backup.name), { readOnly: true });
  const backedUp = Object.fromEntries(replaced.map((table) => [table, dump(backupDb, table)]));
  const backedUpSnapshot = { entities: backupDb.prepare("SELECT payload FROM entities ORDER BY updated_at, id").all().map((row) => JSON.parse(row.payload)) };
  backupDb.close();

  // The state changes after the backup: other rows everywhere, a new task, a task gone, passkeys and sessions change.
  resetTables(replaced, "B");
  resetTables(scope.excludedClearedTables, "B");
  resetTables(excludedSeedable, "B");
  setEntities([project, task("task:2", "Second"), note("note:1", "Note", "text two")], ["task:1"]);
  const before = store.readSnapshot();
  const excludedBefore = dumpAll(keptSeedable);
  const metadataBefore = dump(db(), "metadata");
  const migrationsBefore = dump(db(), "schema_migrations");

  const snapshot = store.restoreBackup(backup.name);

  for (const table of replaced.filter((name) => !scope.storeTables.includes(name))) {
    assert.equal(dump(db(), table), backedUp[table], `${table} is not as in the backup`);
  }
  for (const table of scope.excludedClearedTables.filter((name) => name !== "semantic_index_outbox")) {
    assert.equal(db().prepare(`SELECT COUNT(*) AS value FROM ${quote(table)}`).get().value, 0, table);
  }
  // Restore discards stale queue entries and enqueues exactly one fresh, global rebuild.
  // The outbox is excluded from the backup; its new marker is a side effect of restoreGeneration.
  assert.deepEqual(db().prepare(
    "SELECT object_type, object_id, workspace_id, operation FROM semantic_index_outbox ORDER BY id"
  ).all().map((row) => ({ ...row })), [
    { object_type: "rebuild", object_id: "*", workspace_id: "*", operation: "restore" },
  ]);
  assert.deepEqual(dumpAll(keptSeedable), excludedBefore);
  assert.equal(dump(db(), "schema_migrations"), migrationsBefore);
  // Metadata other than the store revision is untouched (push keys stay).
  const metadata = (text) => JSON.parse(text).filter((row) => !["revision", "updatedAt", "restoreGeneration"].includes(row.key));
  assert.deepEqual(metadata(dump(db(), "metadata")), metadata(metadataBefore));

  // Entities: as in the backup, with the same ids; what the backup did not know is tombstoned; the revision moves on.
  const after = store.readSnapshot();
  assert.deepEqual(after.entities.map((entity) => entity.id).sort(), backedUpSnapshot.entities.map((entity) => entity.id).sort());
  assert.deepEqual(after.entities.find((entity) => entity.id === "note:1").content, "text one");
  assert.equal(after.revision, before.revision + 1);
  assert.equal(snapshot.revision, after.revision);
  assert.ok(after.tombstones.some((tombstone) => tombstone.id === "task:2"));
  assert.equal(after.tombstones.some((tombstone) => tombstone.id === "task:1"), false);

  // The safety backup holds what the restore replaced.
  const safety = store.listBackups().find((entry) => entry.label === "before-restore");
  assert.ok(safety);
  const safetyDb = new DatabaseSync(path.join(backupsDir, safety.name), { readOnly: true });
  try {
    assert.ok(safetyDb.prepare("SELECT 1 FROM entities WHERE id = 'task:2'").get());
    assert.equal(safetyDb.prepare("SELECT COUNT(*) AS value FROM context_claims WHERE id LIKE 'B-%'").get().value, 1);
  } finally {
    safetyDb.close();
  }
});

// Rewrites a backup file in place the way an older or newer build could have produced it, and fixes its sidecar.
function alterBackup(name, change) {
  const file = path.join(backupsDir, name);
  const copy = new DatabaseSync(file);
  try { change(copy); } finally { copy.close(); }
  const sidecarFile = path.join(backupsDir, name.replace(/\.sqlite$/, ".meta.json"));
  const meta = JSON.parse(readFileSync(sidecarFile, "utf8"));
  Object.assign(meta, engine.describeFile(file));
  writeFileSync(sidecarFile, JSON.stringify(meta));
}
const stateOf = () => ({ snapshot: store.readSnapshot(), tables: dumpAll([...scope.includedTables, ...scope.excludedClearedTables, ...keptSeedable]) });

test("a backup made by a newer version is refused and nothing changes", () => {
  const made = store.createBackup("manual");
  alterBackup(made.name, (copy) => copy.exec("INSERT INTO schema_migrations (id, applied_at) VALUES ('2099-01-from-the-future', 'x')"));
  const file = path.join(backupsDir, made.name);
  const fileBefore = engine.sha256File(file);
  const before = stateOf();
  const backupsBefore = files(".sqlite").length;
  assert.throws(() => store.restoreBackup(made.name), /newer version/);
  assert.deepEqual(stateOf(), before);
  assert.equal(files(".sqlite").length, backupsBefore, "no safety backup for a refused restore");
  assert.equal(engine.sha256File(file), fileBefore, "the backup file is never modified");
  assert.deepEqual(readdirSync(path.join(dataDir, "tmp")), []);
});

test("a backup whose file no longer matches its sidecar checksum is refused", () => {
  const made = store.createBackup("manual");
  const file = path.join(backupsDir, made.name);
  const bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(file, bytes);
  const before = stateOf();
  assert.throws(() => store.restoreBackup(made.name), /checksum/);
  assert.deepEqual(stateOf(), before);
  rmSync(path.join(backupsDir, made.name.replace(/\.sqlite$/, ".meta.json")));
  assert.equal(store.listBackups().find((entry) => entry.name === made.name).error, "Invalid backup");
  assert.throws(() => store.restoreBackup(made.name), /Invalid backup/);
  assert.throws(() => store.restoreBackup("../store.sqlite"), /Invalid backup name/);
  assert.throws(() => store.restoreBackup("2026-01-01T00-00-00-000Z-manual.sqlite.meta.json"), /Invalid backup name/);
});

test("a failure in the middle of the restore transaction leaves the live data unchanged", () => {
  const backup = store.createBackup("manual");
  resetTables(replaced.filter((name) => !scope.storeTables.includes(name)), "C");
  setEntities([project, task("task:3", "Third")]);
  const before = stateOf();
  for (const table of ["work_sessions", "context_claims", "note_revisions", "ai_action_history"]) {
    store.failRestoreAfterTableForTests(table);
    assert.throws(() => store.restoreBackup(backup.name), /Restore failed \(test\)/);
    assert.deepEqual(stateOf(), before, `after a failure behind ${table}`);
  }
  store.failRestoreAfterTableForTests(null);
  assert.equal(db().prepare("PRAGMA database_list").all().length, 1, "the restore copy is detached");
  assert.deepEqual(readdirSync(path.join(dataDir, "tmp")), []);
  store.restoreBackup(backup.name);
  assert.ok(store.readSnapshot().tombstones.some((tombstone) => tombstone.id === "task:3"));
});

test("a legacy JSON backup is listed as such and restores records and links only", () => {
  const legacyName = "2026-01-02T03-04-05-678Z-manual.json";
  const entities = [workspaceEntity(), task("task:legacy", "From the old backup")];
  mkdirSync(backupsDir, { recursive: true });
  writeFileSync(path.join(backupsDir, legacyName), JSON.stringify({ revision: 1, entities, relations: [], tombstones: [], updatedAt: 1 }), { mode: 0o600 });
  const listed = store.listBackups().find((backup) => backup.name === legacyName);
  assert.equal(listed.format, "legacy");
  assert.equal(listed.entityCount, 2);
  assert.equal(listed.error, undefined);
  assert.equal(store.listBackups().some((backup) => backup.name.endsWith(".meta.json")), false);

  resetTables(replaced.filter((name) => !scope.storeTables.includes(name)), "D");
  const contextBefore = dumpAll(replaced.filter((name) => !scope.storeTables.includes(name)));
  store.restoreBackup(legacyName);
  assert.deepEqual(store.readSnapshot().entities.map((entity) => entity.id).sort(), ["task:legacy", "workspace:personal"]);
  assert.deepEqual(dumpAll(replaced.filter((name) => !scope.storeTables.includes(name) && name !== "note_revisions")),
    Object.fromEntries(Object.entries(contextBefore).filter(([table]) => table !== "note_revisions")), "context and history are not touched");
  assert.ok(store.listBackups().some((backup) => backup.label === "before-restore" && backup.format === "full"));
});

test("retention counts JSON and database backups together and removes the sidecar with the backup", () => {
  for (const entry of readdirSync(backupsDir)) rmSync(path.join(backupsDir, entry), { force: true });
  const emptyStore = JSON.stringify({ revision: 1, entities: [workspaceEntity()], relations: [], tombstones: [], updatedAt: 1 });
  for (let index = 0; index < 12; index += 1) {
    const name = `2026-01-${String(index + 1).padStart(2, "0")}T00-00-00-000Z-manual.json`;
    writeFileSync(path.join(backupsDir, name), emptyStore, { mode: 0o600 });
    const old = new Date(2026, 0, index + 1);
    utimesSync(path.join(backupsDir, name), old, old);
  }
  // 12 old JSON backups, then 9 new full ones: 21 in the class, 20 are kept, the oldest JSON file goes.
  for (let index = 0; index < 9; index += 1) store.createBackup("manual");
  const manual = readdirSync(backupsDir).filter((entry) => /-manual\.(json|sqlite)$/.test(entry));
  assert.equal(manual.length, 20);
  assert.equal(manual.filter((entry) => entry.endsWith(".json")).length, 11);
  assert.equal(existsSync(path.join(backupsDir, "2026-01-01T00-00-00-000Z-manual.json")), false);
  assert.equal(files(".meta.json").length, 9);
  // Pushing the full ones out removes their sidecars with them.
  for (let index = 0; index < 12; index += 1) store.createBackup("manual");
  assert.equal(readdirSync(backupsDir).filter((entry) => /-manual\.(json|sqlite)$/.test(entry) && !entry.endsWith(".meta.json")).length, 20);
  assert.equal(files(".meta.json").length, files(".sqlite").length);
  // Other classes are counted on their own.
  store.createBackup("daily");
  assert.equal(files("-daily.sqlite").length, 1);
});

test("the daily backup is taken once a day before the first change, in the new format", () => {
  for (const entry of readdirSync(backupsDir)) rmSync(path.join(backupsDir, entry), { force: true });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(store.hasDailyBackup(today), false);
  setEntities([project, task("task:daily", "Daily")]);
  assert.equal(store.hasDailyBackup(today), true);
  const daily = files("-daily.sqlite");
  assert.equal(daily.length, 1);
  setEntities([project, task("task:daily", "Daily again")]);
  assert.equal(files("-daily.sqlite").length, 1);
});

// Writes the export ZIP of the live data to a file (as the route does) and returns it.
function writeExport(options) {
  const copy = store.createExportCopy();
  const zipPath = path.join(tmp(), `export-${Math.random().toString(36).slice(2)}.zip`);
  try {
    const manifest = pack.writeExportZip(copy.path, zipPath, { counts: copy.counts, migrations: copy.migrations }, options);
    return { zipPath, manifest, copy };
  } catch (error) {
    rmSync(zipPath, { force: true });
    throw error;
  } finally {
    copy.dispose();
  }
}
const { unzipSync } = await import("fflate");
async function exportZip() {
  const { zipPath, manifest } = writeExport();
  const bytes = readFileSync(zipPath);
  rmSync(zipPath);
  return { bytes, manifest };
}
const tmp = () => path.join(dataDir, "tmp-test");
mkdirSync(tmp(), { recursive: true });
const verify = (bytes, limits) => {
  const zipPath = path.join(tmp(), `p-${Math.random().toString(36).slice(2)}.zip`);
  const databasePath = `${zipPath}.sqlite`;
  writeFileSync(zipPath, bytes);
  try { return pack.verifyPackage(zipPath, databasePath, limits); } finally { rmSync(zipPath, { force: true }); }
};

test("the export package has a manifest with checksums, the database, readable notes and tables, and history", async () => {
  setEntities([project, task("task:e1", "Exported task"), note("note:e1", "Poznámka: úvod", "Řádek 1\n\n- bod")]);
  resetTables(replaced.filter((name) => !scope.storeTables.includes(name)), "E");
  const { bytes, manifest } = await exportZip();
  assert.equal(readdirSync(path.join(dataDir, "tmp")).filter((entry) => entry.startsWith("export-")).length, 0, "the temporary copy is deleted");
  const entries = unzipSync(new Uint8Array(bytes));
  const names = Object.keys(entries).sort();
  assert.equal(names[0] === "manifest.json" || names.includes("manifest.json"), true);
  assert.ok(names.includes("database.sqlite"));
  for (const table of scope.includedTables) assert.ok(names.includes(`data/${table}.json`), table);
  assert.ok(names.includes("history/context-changes.jsonl") && names.includes("history/note-revisions.jsonl"));
  const markdown = Buffer.from(entries["notes/note_e1.md"]).toString("utf8");
  assert.match(markdown, /^---\nid: "note:e1"\ntitle: "Poznámka: úvod"\nworkspace: "personal"\nproject: "project:p"\nupdatedAt: 1970-01-01T00:00:00\.002Z\n---\n\nŘádek 1\n\n- bod\n$/);
  const packed = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  assert.equal(packed.format, "lumi-export");
  assert.equal(packed.version, 1);
  assert.deepEqual(packed.migrations, migrations.schemaMigrations.map((migration) => migration.id).sort());
  assert.deepEqual(Object.keys(packed.files).sort(), names.filter((name) => name !== "manifest.json"));
  const { createHash } = await import("node:crypto");
  for (const [name, info] of Object.entries(packed.files)) {
    assert.equal(createHash("sha256").update(entries[name]).digest("hex"), info.sha256, name);
    assert.equal(entries[name].length, info.bytes, name);
  }
  assert.deepEqual(JSON.parse(Buffer.from(entries["data/work_sessions.json"]).toString("utf8")), JSON.parse(JSON.stringify(db().prepare("SELECT * FROM work_sessions").all())));
  // JSON columns stay strings exactly as stored.
  assert.equal(typeof JSON.parse(Buffer.from(entries["data/pact_context.json"]).toString("utf8"))[0].payload, "string");
  // Nothing of the excluded tables.
  const text = names.map((name) => Buffer.from(entries[name]).toString("latin1")).join("\n");
  for (const secret of ["secret-push-key", "E-passkey", "B-passkey_credentials"]) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(verify(bytes).counts, manifest.counts);
});

test("an import restores the package like a backup: safety backup first, original ids, no merging", async () => {
  const { bytes } = await exportZip();
  const exported = store.readSnapshot();
  const exportedTables = dumpAll(replaced.filter((name) => !scope.storeTables.includes(name)));
  setEntities([project, task("task:after", "Created after the export")], ["task:e1", "note:e1"]);
  resetTables(replaced.filter((name) => !scope.storeTables.includes(name)), "F");
  const zipPath = path.join(tmp(), "import.zip");
  const databasePath = path.join(tmp(), "import.sqlite");
  writeFileSync(zipPath, bytes);
  pack.verifyPackage(zipPath, databasePath);
  const before = new Set(files(".sqlite"));
  store.restoreDatabaseFile(databasePath);
  assert.deepEqual(store.readSnapshot().entities.map((entity) => entity.id).sort(), exported.entities.map((entity) => entity.id).sort());
  assert.deepEqual(dumpAll(replaced.filter((name) => !scope.storeTables.includes(name))), exportedTables);
  const created = files(".sqlite").filter((name) => !before.has(name));
  assert.deepEqual(created.map((name) => name.replace(/^.*Z-/, "")), ["before-restore.sqlite"]);
  const safety = new DatabaseSync(path.join(backupsDir, created[0]), { readOnly: true });
  try { assert.ok(safety.prepare("SELECT 1 FROM entities WHERE id = 'task:after'").get()); } finally { safety.close(); }
  assert.ok(store.readSnapshot().tombstones.some((tombstone) => tombstone.id === "task:after"));
});

test("a tampered package is refused with a reason", async () => {
  const { bytes } = await exportZip();
  const entries = unzipSync(new Uint8Array(bytes));
  const rezip = (change) => {
    const copy = { ...entries };
    change(copy);
    return Buffer.from(zipSync(copy));
  };
  const manifest = () => JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  // A changed file.
  assert.throws(() => verify(rezip((files) => { files["notes/note_e1.md"] = strToU8("changed"); })), /checksums/);
  assert.throws(() => verify(rezip((files) => { files["database.sqlite"] = strToU8("not a database"); })), /checksums/);
  // A missing file, an extra file.
  assert.throws(() => verify(rezip((files) => { delete files["data/pact_agents.json"]; })), /missing or unexpected/);
  assert.throws(() => verify(rezip((files) => { files["extra.txt"] = strToU8("x"); })), /missing or unexpected/);
  assert.throws(() => verify(rezip((files) => { delete files["database.sqlite"]; })), /missing or unexpected/);
  assert.throws(() => verify(rezip((files) => { delete files["manifest.json"]; })), /missing or unexpected/);
  // A manifest of another format or version, or not JSON.
  assert.throws(() => verify(rezip((files) => { files["manifest.json"] = strToU8(JSON.stringify({ ...manifest(), version: 2 })); })), /Invalid export package/);
  assert.throws(() => verify(rezip((files) => { files["manifest.json"] = strToU8(JSON.stringify({ ...manifest(), format: "other" })); })), /Invalid export package/);
  assert.throws(() => verify(rezip((files) => { files["manifest.json"] = strToU8("{"); })), /Invalid export package/);
  // Not a ZIP at all, and a truncated one.
  assert.throws(() => verify(Buffer.from("this is not a zip file")), /Not a valid export file/);
  assert.throws(() => verify(Buffer.alloc(0)), /Not a valid export file/);
  assert.throws(() => verify(Buffer.from("PK\u0003\u0004 and then garbage that is not an entry")), /Not a valid export file/);
  assert.throws(() => verify(bytes.subarray(0, Math.floor(bytes.length / 2))), /Not a valid export file|missing|checksums/);
  // A manifest that lies about a size.
  assert.throws(() => verify(rezip((files) => { const lied = manifest(); lied.files["notes/note_e1.md"].bytes += 1; files["manifest.json"] = strToU8(JSON.stringify(lied)); })), /checksums/);
});

test("path traversal names, absurd entry counts and zip bombs are refused", async () => {
  const entries = { "manifest.json": strToU8("{}"), "database.sqlite": strToU8("x") };
  for (const name of ["../evil.txt", "/abs.txt", "a/../../b", "a\\b.txt", "C:/x.txt", "dir/", "./x"]) {
    assert.throws(() => verify(Buffer.from(zipSync({ ...entries, [name]: strToU8("x") }))), /Invalid export package/, name);
  }
  const many = { ...entries };
  for (let index = 0; index < 30; index += 1) many[`data/f${index}.json`] = strToU8("[]");
  assert.throws(() => verify(Buffer.from(zipSync(many)), { ...pack.defaultPackageLimits, maxEntries: 10 }), /too large/);
  const bomb = Buffer.from(zipSync({ ...entries, "data/bomb.json": new Uint8Array(5_000_000) }, { level: 9 }));
  assert.ok(bomb.length < 20_000, "a few kilobytes inflate to megabytes");
  assert.throws(() => verify(bomb, { ...pack.defaultPackageLimits, maxEntryBytes: 1_000_000 }), /too large/);
  assert.throws(() => verify(bomb, { ...pack.defaultPackageLimits, maxTotalBytes: 1_000_000 }), /too large/);
  const database = Buffer.from(zipSync({ ...entries, "database.sqlite": new Uint8Array(5_000_000) }, { level: 9 }));
  assert.throws(() => verify(database, { ...pack.defaultPackageLimits, maxDatabaseBytes: 1_000_000 }), /too large/);
});

test("a package whose database was made by a newer version is refused before anything changes", async () => {
  const copy = store.createExportCopy();
  const future = new DatabaseSync(copy.path);
  future.exec("INSERT INTO schema_migrations (id, applied_at) VALUES ('2099-01-from-the-future', 'x')");
  future.close();
  // The package is written around the altered database, so its checksums are right: only the schema check can refuse it.
  const zipPath = path.join(tmp(), "future.zip");
  const databasePath = path.join(tmp(), "future.sqlite");
  pack.writeExportZip(copy.path, zipPath, { counts: copy.counts, migrations: copy.migrations });
  copy.dispose();
  pack.verifyPackage(zipPath, databasePath);
  const before = stateOf();
  assert.throws(() => store.restoreDatabaseFile(databasePath), /newer version/);
  assert.deepEqual(stateOf(), before);
});

test("scripts/check-data.mjs verifies a full backup read-only", () => {
  const made = store.createBackup("manual");
  const file = path.join(backupsDir, made.name);
  const before = engine.sha256File(file);
  const result = spawnSync(process.execPath, ["scripts/check-data.mjs", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.integrity, "ok");
  for (const table of scope.includedTables) assert.ok(table in report.tables, table);
  assert.equal(report.tables.passkey_credentials, 0);
  assert.equal(engine.sha256File(file), before);
  assert.equal(existsSync(`${file}-wal`), false);
});

test("a store above the old package limits is exported and imported back", async () => {
  // 25 000 notes of about 3 KB: more entries than the old limit of 20 000, and data/entities.json above the old 64 MiB.
  const { randomBytes } = await import("node:crypto");
  const insert = db().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)");
  db().exec("BEGIN");
  for (let index = 0; index < 25_000; index += 1) {
    const entity = note(`note:big-${index}`, `Big ${index}`, randomBytes(2300).toString("base64"));
    insert.run(entity.id, JSON.stringify(entity), 1_000 + index);
  }
  db().exec("COMMIT");
  const { zipPath, manifest } = writeExport();
  const databasePath = path.join(tmp(), "big.sqlite");
  assert.ok(Object.keys(manifest.files).length + 1 > 20_000);
  assert.ok(manifest.files["data/entities.json"].bytes > 64 * 1024 ** 2);
  const verified = pack.verifyPackage(zipPath, databasePath);
  assert.equal(Object.keys(verified.files).length, Object.keys(manifest.files).length);
  db().exec("DELETE FROM entities WHERE id LIKE 'note:big-%'");
  store.restoreDatabaseFile(databasePath);
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM entities WHERE id LIKE 'note:big-%'").get().value, 25_000);
  db().exec("DELETE FROM entities WHERE id LIKE 'note:big-%'; DELETE FROM note_revisions WHERE note_id LIKE 'note:big-%'");
  rmSync(zipPath, { force: true });
  rmSync(databasePath, { force: true });
});

test("an export above the importer's limits is refused while it is written, and leaves a file only for the caller to delete", () => {
  const limits = pack.defaultPackageLimits;
  const entryCount = Object.keys(writeExportAndRemove().files).length;
  const refused = (changed, options = {}) => assert.throws(() => writeExportAndRemove({ limits: { ...limits, ...changed }, ...options }), (error) => error.status === 413 && error.message === "Export is too large to be imported again");
  refused({ maxEntries: entryCount });
  refused({ maxEntryBytes: 10 });
  refused({ maxTotalBytes: 100 });
  refused({ maxDatabaseBytes: 100 });
  refused({ maxManifestBytes: 500 });
  refused({}, { uploadLimit: 1000 });
  assert.doesNotThrow(() => writeExportAndRemove({ limits: { ...limits, maxEntries: entryCount + 1 } }));
  // What the importer accepts is never below what the exporter writes.
  assert.ok(limits.maxEntries >= 65_000 && limits.maxEntryBytes >= 1024 ** 3);
});
function writeExportAndRemove(options) {
  const written = writeExport(options);
  rmSync(written.zipPath, { force: true });
  return written.manifest;
}

test("a package that inflates far beyond what was read is refused by the ratio guard", () => {
  const entries = { "manifest.json": strToU8("{}"), "database.sqlite": strToU8("x"), "data/zeros.json": new Uint8Array(80 * 1024 ** 2) };
  assert.throws(() => verify(Buffer.from(zipSync(entries, { level: 9 }))), /too large/);
});

test("leftovers of a killed restore, import or export are removed at the next temporary file", () => {
  const tempDir = path.join(dataDir, "tmp");
  mkdirSync(tempDir, { recursive: true });
  const stale = ["restore-old.sqlite", "export-old.sqlite", "import-old.zip", "import-db-old.sqlite"].map((name) => path.join(tempDir, name));
  for (const file of stale) writeFileSync(file, "left over");
  const unrelated = path.join(tempDir, "keep-me.txt");
  writeFileSync(unrelated, "not ours");
  const inUse = store.temporaryFile("import", ".zip");
  writeFileSync(inUse, "in use by a running request");
  const next = store.temporaryFile("export", ".sqlite");
  assert.deepEqual(stale.filter((file) => existsSync(file)), []);
  assert.equal(existsSync(unrelated), true);
  assert.equal(existsSync(inUse), true, "a file of a request that is running is not removed");
  assert.equal(existsSync(next), false);
  rmSync(unrelated);
  rmSync(inUse);
});

test("a malformed legacy backup is listed as invalid without its validation detail, and restoring it says only that", () => {
  const name = "2026-03-04T05-06-07-890Z-manual.json";
  writeFileSync(path.join(backupsDir, name), JSON.stringify({ revision: 1, entities: [{ id: "x", type: "workspace", title: "w" }], relations: [], tombstones: [] }), { mode: 0o600 });
  const listed = store.listBackups().find((backup) => backup.name === name);
  assert.equal(listed.error, "Invalid backup");
  const before = stateOf();
  assert.throws(() => store.restoreBackup(name), (error) => error.message === "Invalid backup");
  assert.deepEqual(stateOf(), before);
  writeFileSync(path.join(backupsDir, name), "{ not json");
  assert.equal(store.listBackups().find((backup) => backup.name === name).error, "Invalid backup");
  rmSync(path.join(backupsDir, name));
});

test("the restore test hook cannot be switched on outside the test runner", () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.throws(() => store.failRestoreAfterTableForTests("context_claims"), /Not available outside tests/);
  } finally {
    process.env.NODE_TEST_CONTEXT = saved;
  }
});

test("the backup route answers an unexpected failure with a generic message and keeps paths out of the response", async () => {
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
  const route = await import("../app/api/backups/route.ts");
  const made = store.createBackup("manual");
  // The database file is replaced by a directory: reading it fails with an error that names its path.
  const file = path.join(backupsDir, made.name);
  rmSync(file);
  mkdirSync(file);
  const request = (body) => new Request("http://localhost:3000/api/backups", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  let response;
  try { response = await route.POST(request({ action: "restore", name: made.name })); } finally { console.error = originalError; }
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(text), { error: "Restore failed" });
  assert.equal(text.includes(dataDir), false);
  assert.ok(logged.some((line) => line.includes("Restore failed")), "the detail is logged on the server");
  const refused = await route.POST(request({ action: "restore", name: "../x.sqlite" }));
  assert.equal((await refused.json()).error, "Invalid backup name");
  rmSync(file, { recursive: true });
  rmSync(path.join(backupsDir, made.name.replace(/\.sqlite$/, ".meta.json")));
});

async function builtZip() {
  const { zipPath } = writeExport();
  return { zipPath, scratch: `${zipPath}.sqlite`, bytes: readFileSync(zipPath) };
}

test("an export is checked with the importer's own limits: upload size, entry limits, ratio guard", async () => {
  const { zipPath, scratch, bytes } = await builtZip();
  try {
    // A normal package passes with the real limits and the real upload limit.
    assert.ok(bytes.length < pack.maxImportUploadBytes);
    assert.equal(pack.verifyExportOutput(zipPath, scratch).format, "lumi-export");
    // A smaller upload limit than the file: refused with the export wording, nothing else.
    assert.throws(() => pack.verifyExportOutput(zipPath, scratch, bytes.length - 1), (error) => error.status === 413 && error.message === "Export is too large to be imported again");
    // Entry limits.
    assert.throws(() => pack.verifyExportOutput(zipPath, scratch, undefined, { ...pack.defaultPackageLimits, maxEntries: 3 }), /too large to be imported again/);
    assert.throws(() => pack.verifyExportOutput(zipPath, scratch, undefined, { ...pack.defaultPackageLimits, maxManifestBytes: 100 }), /too large to be imported again/);
  } finally {
    rmSync(zipPath, { force: true });
    rmSync(scratch, { force: true });
  }
  // Highly repetitive data inflates far beyond what is read: the importer's ratio guard would refuse it, so the export is not produced.
  const zeros = "0".repeat(6_000_000);
  db().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, 5)").run("note:zeros", JSON.stringify(note("note:zeros", "Zeros", zeros)));
  try {
    const repetitive = await builtZip();
    try {
      const guarded = { ...pack.defaultPackageLimits, bombFloorBytes: 1_000_000, maxRatio: 50 };
      assert.throws(() => pack.verifyExportOutput(repetitive.zipPath, repetitive.scratch, undefined, guarded), /too large to be imported again/);
      // The same package passes where the guard is not in the way: the refusal is the ratio guard, not a damaged package.
      assert.equal(pack.verifyExportOutput(repetitive.zipPath, repetitive.scratch).format, "lumi-export");
    } finally {
      rmSync(repetitive.zipPath, { force: true });
      rmSync(repetitive.scratch, { force: true });
    }
  } finally {
    db().exec("DELETE FROM entities WHERE id = 'note:zeros'");
  }
});

test("the manifest has its own small bound, checked while inflating", () => {
  const entries = { "database.sqlite": strToU8("x") };
  const files = {};
  for (let index = 0; index < 400; index += 1) files[`notes/n${index}.md`] = { sha256: "0".repeat(64), bytes: 1 };
  const manifest = strToU8(JSON.stringify({ format: "lumi-export", version: 1, createdAt: "x", migrations: [], counts: {}, files }));
  const zip = Buffer.from(zipSync({ ...entries, "manifest.json": manifest }));
  assert.throws(() => verify(zip, { ...pack.defaultPackageLimits, maxManifestBytes: manifest.length - 1 }), /too large/);
  // Inflated far beyond the bound from a few bytes: refused before it is parsed.
  const huge = Buffer.from(zipSync({ ...entries, "manifest.json": new Uint8Array(40 * 1024 ** 2).fill(32) }, { level: 9 }));
  assert.ok(huge.length < 100_000);
  assert.throws(() => verify(huge), /too large/);
});

test("reserved temporary paths are never cleaned up, whether or not the file exists yet", () => {
  const first = store.temporaryFile("import", ".zip");
  const second = store.temporaryFile("import-db", ".sqlite");
  store.removeLeftoverTemporaryFiles();
  writeFileSync(first, "uploaded so far");
  store.temporaryFile("export", ".sqlite"); // a later reservation runs the cleanup again
  store.removeLeftoverTemporaryFiles();
  assert.equal(readFileSync(first, "utf8"), "uploaded so far");
  writeFileSync(second, "second");
  store.removeLeftoverTemporaryFiles();
  assert.equal(existsSync(second), true);
  store.releaseTemporaryFile(first);
  store.releaseTemporaryFile(second);
  assert.equal(existsSync(first), false);
  // Once released, a file of the same name would be a leftover.
  writeFileSync(second, "leftover");
  store.removeLeftoverTemporaryFiles();
  assert.equal(existsSync(second), false);
});

test("a published database backup always has its sidecar, and one without it neither counts as the day's backup nor stays in the listing", () => {
  for (const entry of readdirSync(backupsDir)) rmSync(path.join(backupsDir, entry), { force: true });
  const today = new Date().toISOString().slice(0, 10);
  const daily = store.createBackup("daily");
  assert.equal(existsSync(path.join(backupsDir, daily.name.replace(/\.sqlite$/, ".meta.json"))), true);
  assert.equal(store.hasDailyBackup(today), true);
  assert.deepEqual(readdirSync(backupsDir).filter((entry) => entry.startsWith(".")), []);
  // A crash left the database file without its sidecar: the day has no usable daily backup, the owner's file is kept.
  const sidecar = path.join(backupsDir, daily.name.replace(/\.sqlite$/, ".meta.json"));
  const saved = readFileSync(sidecar);
  rmSync(sidecar);
  assert.equal(store.hasDailyBackup(today), false);
  writeFileSync(sidecar, "{ damaged");
  assert.equal(store.hasDailyBackup(today), false);
  // Or the file is not the size the sidecar states.
  writeFileSync(sidecar, saved);
  assert.equal(store.hasDailyBackup(today), true);
  writeFileSync(sidecar, JSON.stringify({ ...JSON.parse(saved.toString()), bytes: 1 }));
  assert.equal(store.hasDailyBackup(today), false);
  // At start: staging files of older builds and sidecars without a database go; a database without a sidecar is kept as .incomplete.
  writeFileSync(sidecar, "{ damaged");
  writeFileSync(path.join(backupsDir, ".2026-01-01T00-00-00-000Z-manual.sqlite.tmp"), "old staging");
  writeFileSync(path.join(backupsDir, "2026-01-01T00-00-00-000Z-manual.meta.json"), "{}");
  store.repairBackupsDirectory();
  const left = readdirSync(backupsDir).sort();
  assert.deepEqual(left, [`${daily.name}.incomplete`]);
  assert.equal(store.listBackups().length, 0);
  // Setting setEntities makes a new daily backup because none counts.
  setEntities([project, task("task:after-repair", "After repair")]);
  assert.equal(store.hasDailyBackup(today), true);
});

test("a backup killed after VACUUM INTO leaves no secret behind after the next start", () => {
  const crashDir = mkdtempSync(path.join(os.tmpdir(), "lumi-crash-"));
  const marker = `LUMI-SECRET-${Date.now()}`;
  const script = fileURLToPath(new URL("./support/crash-backup.mjs", import.meta.url));
  const run = (mode) => spawnSync(process.execPath, ["--experimental-loader", "./tests/ts-loader.mjs", script, crashDir, mode, marker],
    { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" } });
  try {
    const crashed = run("crash");
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    const scan = (mode) => JSON.parse(run(mode).stdout.trim().split("\n").pop());
    // The scenario is real: the killed process left the not yet cleaned copy, in the temporary folder, not in the backups.
    const tmpDir = path.join(crashDir, "tmp");
    const leftover = readdirSync(tmpDir).filter((entry) => entry.startsWith("backup-"));
    assert.equal(leftover.length, 1);
    assert.equal(readFileSync(path.join(tmpDir, leftover[0])).includes(Buffer.from(marker)), true);
    assert.deepEqual(readdirSync(path.join(crashDir, "backups")).filter((entry) => !entry.startsWith(".") === false), []);
    // The next start removes it.
    assert.deepEqual(scan("start"), []);
    assert.deepEqual(readdirSync(tmpDir), []);
  } finally {
    rmSync(crashDir, { recursive: true, force: true });
  }
});

test("an export of a large store runs in a small heap, where reading whole tables does not fit", () => {
  const lowDir = mkdtempSync(path.join(os.tmpdir(), "lumi-lowheap-"));
  const script = fileURLToPath(new URL("./support/export-low-heap.mjs", import.meta.url));
  const run = (nodeArgs, mode, count = "") => spawnSync(process.execPath, [...nodeArgs, "--experimental-loader", "./tests/ts-loader.mjs", script, lowDir, mode, count],
    { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" }, maxBuffer: 1024 ** 2 });
  const last = (result) => JSON.parse(result.stdout.trim().split("\n").pop());
  try {
    // About 75 MB of notes, written with the default heap.
    const seeded = run([], "seed", "2500");
    assert.equal(seeded.status, 0, seeded.stderr);
    // The first version of the export (a whole table in one string) does not fit 64 MB of heap ...
    const naive = run(["--max-old-space-size=64"], "naive");
    assert.notEqual(naive.status, 0, "reading the whole entities table should not fit the small heap");
    // ... the streamed export does, and what it writes passes the importer's verification (also run in the small heap).
    const streamed = run(["--max-old-space-size=64"], "export");
    assert.equal(streamed.status, 0, streamed.stderr.slice(-2000));
    const result = last(streamed);
    assert.ok(result.entries > 2500);
    assert.ok(result.entitiesJson > 64 * 1024 ** 2);
    assert.ok(result.zipBytes < pack.maxImportUploadBytes);
  } finally {
    rmSync(lowDir, { recursive: true, force: true });
  }
});

test("a save made before a restore is refused whole, whatever its base revision; one that knows the generation is accepted", () => {
  const backup = store.createBackup("manual");
  const before = store.readSnapshot();
  const generation = before.restoreGeneration ?? 0;
  const save = (restoreGeneration) => store.replaceSnapshot(store.readSnapshot().revision, [workspaceEntity(), project, task("task:generation", "Late save")], [], [], [], restoreGeneration);
  store.restoreBackup(backup.name);
  const restored = store.readSnapshot();
  assert.equal(restored.restoreGeneration, generation + 1);
  const dailyBefore = files("-daily.sqlite").length;
  for (const old of [undefined, generation, 0, generation + 7]) {
    const refused = save(old);
    assert.equal(refused.conflict, true);
    assert.equal(refused.restored, true);
    assert.equal(refused.snapshot.restoreGeneration, generation + 1);
  }
  // Nothing was written: not the record, not the revision, not a daily backup.
  const after = store.readSnapshot();
  assert.equal(after.revision, restored.revision);
  assert.equal(after.entities.some((entity) => entity.id === "task:generation"), false);
  assert.equal(files("-daily.sqlite").length, dailyBefore);
  // A device that holds the restored data saves normally.
  const accepted = save(generation + 1);
  assert.equal(accepted.conflict, false);
  assert.equal(accepted.snapshot.restoreGeneration, generation + 1, "the answer to a save carries the generation too");
  assert.equal(store.readSnapshot().entities.some((entity) => entity.id === "task:generation"), true);
  // Every kind of restore counts: a legacy backup and an import too.
  const legacy = "2026-05-06T07-08-09-123Z-manual.json";
  writeFileSync(path.join(backupsDir, legacy), JSON.stringify({ revision: 1, entities: [workspaceEntity()], relations: [], tombstones: [], updatedAt: 1 }), { mode: 0o600 });
  store.restoreBackup(legacy);
  assert.equal(store.readSnapshot().restoreGeneration, generation + 2);
  const copy = store.createExportCopy();
  store.restoreDatabaseFile(copy.path);
  copy.dispose();
  assert.equal(store.readSnapshot().restoreGeneration, generation + 3);
  // The generation is not part of a backup: restoring never lowers it.
  const file = new DatabaseSync(path.join(backupsDir, backup.name), { readOnly: true });
  assert.equal(file.prepare("SELECT 1 FROM metadata WHERE key = 'restoreGeneration'").get(), undefined);
  file.close();
});

test("the events of a calendar cache are emptied by a restore, so a source the backup lacks leaves no blocked time", async () => {
  const calendar = await import("../lib/calendar.ts");
  const now = Date.now();
  const insertSource = (id) => db().prepare(`INSERT INTO calendar_sources (id, workspace_id, provider, label, encrypted_url, status, created_at, updated_at) VALUES (?, 'personal', 'ics', ?, 'x', 'ready', 1, 1)`).run(id, id);
  const insertEvent = (id, source) => db().prepare(`INSERT INTO calendar_events (id, source_id, workspace_id, occurrence_key, payload, start_at, end_at, updated_at) VALUES (?, ?, 'personal', ?, ?, ?, ?, 1)`)
    .run(id, source, id, JSON.stringify({ id, title: "Blocked" }), now + 1000, now + 3_600_000);
  db().exec("DELETE FROM calendar_sources; DELETE FROM calendar_events");
  const backup = store.createBackup("manual"); // no calendar source
  insertSource("later-source");
  insertEvent("later-event", "later-source");
  assert.equal(calendar.listCalendarEvents("personal", now, now + 7_200_000).length, 1);
  store.restoreBackup(backup.name);
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM calendar_sources").get().value, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM calendar_events").get().value, 0);
  assert.deepEqual(calendar.listCalendarEvents("personal", now, now + 7_200_000), []);
  // A source that is in the backup keeps existing and its events are fetched again (here: refresh is attempted and fails without a feed, logged only).
  insertSource("kept-source");
  const withSource = store.createBackup("manual");
  insertEvent("stale-event", "kept-source");
  store.restoreBackup(withSource.name);
  assert.equal(db().prepare("SELECT COUNT(*) AS value FROM calendar_events").get().value, 0);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try { await calendar.refreshAllCalendarSources(); } finally { console.error = original; }
  assert.ok(logged.some((line) => line.includes("Calendar refresh after a restore failed")));
  db().exec("DELETE FROM calendar_sources");
});

test("an archive whose entries contain the bytes of a data descriptor signature is read correctly (not cut at the signature)", async () => {
  // A reader that looks for the end of an entry in the stream cuts it short at PK\x07\x08; the central directory has exact sizes.
  const { Zip, ZipPassThrough, ZipDeflate } = await import("fflate");
  const { createHash } = await import("node:crypto");
  const signature = Buffer.from([0x50, 0x4b, 0x07, 0x08, 0x50, 0x4b, 0x03, 0x04, 0x50, 0x4b, 0x01, 0x02]);
  const files = {
    "notes/signature.md": Buffer.concat([Buffer.from("before "), signature, Buffer.alloc(300, 7), signature, Buffer.from(" after")]),
    "data/other.json": Buffer.from("[]"),
    "database.sqlite": Buffer.concat([signature, Buffer.alloc(1000, 1), signature]),
  };
  const manifest = { format: "lumi-export", version: 1, createdAt: "x", migrations: [], counts: {},
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length }])) };
  for (const useDeflate of [false, true]) {
    const chunks = [];
    const zip = new Zip((error, chunk) => { if (error) throw error; chunks.push(Buffer.from(chunk)); });
    for (const [name, data] of [...Object.entries(files), ["manifest.json", Buffer.from(JSON.stringify(manifest))]]) {
      const entry = useDeflate ? new ZipDeflate(name) : new ZipPassThrough(name);
      zip.add(entry);
      entry.push(data, true);
    }
    zip.end();
    const verified = verify(Buffer.concat(chunks));
    assert.deepEqual(Object.keys(verified.files).sort(), Object.keys(files).sort());
  }
});

test("a streamed archive of many random entries always verifies (the case a streaming reader got wrong at random)", async () => {
  const { randomBytes } = await import("node:crypto");
  const insert = db().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)");
  db().exec("BEGIN");
  for (let index = 0; index < 4000; index += 1) {
    const entity = note(`note:rnd-${index}`, `Rnd ${index}`, randomBytes(1500).toString("base64"));
    insert.run(entity.id, JSON.stringify(entity), 9_000 + index);
  }
  db().exec("COMMIT");
  try {
    for (let round = 0; round < 3; round += 1) {
      const { zipPath } = writeExport();
      try { assert.equal(pack.verifyExportOutput(zipPath, `${zipPath}.sqlite`).format, "lumi-export"); } finally { rmSync(zipPath, { force: true }); rmSync(`${zipPath}.sqlite`, { force: true }); }
    }
  } finally {
    db().exec("DELETE FROM entities WHERE id LIKE 'note:rnd-%'; DELETE FROM note_revisions WHERE note_id LIKE 'note:rnd-%'");
  }
});

test("the store route answers a save from before a restore with 409 and code restored, and a current one with 200", async () => {
  process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
  const route = await import("../app/api/store/route.ts");
  const backup = store.createBackup("manual");
  store.restoreBackup(backup.name);
  const current = store.readSnapshot();
  const put = (generation) => route.PUT(new Request("http://localhost:3000/api/store", { method: "PUT", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: current.revision, entities: current.entities, relations: current.relations, deletedIds: [], revivedIds: [], restoreGeneration: generation }) }));
  const refused = await put(current.restoreGeneration - 1);
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.code, "restored");
  assert.equal(body.restoreGeneration, current.restoreGeneration);
  assert.equal((await put(undefined)).status, 409);
  const accepted = await put(current.restoreGeneration);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).restoreGeneration, current.restoreGeneration);
  // An ordinary revision conflict is not marked as a restore.
  const stale = await route.PUT(new Request("http://localhost:3000/api/store", { method: "PUT", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, entities: current.entities, relations: current.relations, deletedIds: [], revivedIds: [], restoreGeneration: current.restoreGeneration }) }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, undefined);
});
