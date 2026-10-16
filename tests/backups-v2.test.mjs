import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
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
  const result = store.replaceSnapshot(current.revision, [workspaceEntity(), ...entities], [], deleted);
  assert.equal(result.conflict, false);
};
const dump = (database, table) => JSON.stringify(database.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all(), (_key, value) => value instanceof Uint8Array ? `blob:${Buffer.from(value).toString("hex")}` : value);
const dumpAll = (tables) => Object.fromEntries(tables.map((table) => [table, dump(db(), table)]));

const overrides = {
  work_sessions: { state: "completed", running_since: null },
  work_session_intervals: { ended_at: 5 },
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
  for (const table of scope.excludedClearedTables) assert.equal(db().prepare(`SELECT COUNT(*) AS value FROM ${quote(table)}`).get().value, 0, table);
  assert.deepEqual(dumpAll(keptSeedable), excludedBefore);
  assert.equal(dump(db(), "schema_migrations"), migrationsBefore);
  // Metadata other than the store revision is untouched (push keys stay).
  const metadata = (text) => JSON.parse(text).filter((row) => !["revision", "updatedAt"].includes(row.key));
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

function exportPackage() {
  const copy = store.createExportCopy();
  const parts = pack.buildPackageParts(copy.path);
  const manifest = pack.buildManifest(parts, { counts: copy.counts, migrations: copy.migrations });
  return { copy, parts, manifest };
}
async function readStream(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
const { unzipSync } = await import("fflate");
async function exportZip() {
  const { copy, parts, manifest } = exportPackage();
  const bytes = await readStream(pack.packageStream(parts, manifest, copy.dispose));
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
  assert.throws(() => verify(Buffer.from("this is not a zip file")), /Invalid export package|missing/);
  assert.throws(() => verify(bytes.subarray(0, Math.floor(bytes.length / 2))), /Invalid export package|missing|checksums/);
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
  const { copy, parts, manifest } = exportPackage();
  const future = new DatabaseSync(copy.path);
  future.exec("INSERT INTO schema_migrations (id, applied_at) VALUES ('2099-01-from-the-future', 'x')");
  future.close();
  // The package is rebuilt around the altered database, so its checksums are right: only the schema check can refuse it.
  const rebuilt = pack.buildPackageParts(copy.path);
  const bytes = await readStream(pack.packageStream(rebuilt, pack.buildManifest(rebuilt, { counts: copy.counts, migrations: copy.migrations }), copy.dispose));
  const zipPath = path.join(tmp(), "future.zip");
  const databasePath = path.join(tmp(), "future.sqlite");
  writeFileSync(zipPath, bytes);
  pack.verifyPackage(zipPath, databasePath);
  const before = stateOf();
  assert.throws(() => store.restoreDatabaseFile(databasePath), /newer version/);
  assert.deepEqual(stateOf(), before);
  void parts; void manifest;
});
