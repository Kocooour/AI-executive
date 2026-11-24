import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_TABLES, inventoryCopy, inventoryDatabase } from "../scripts/archive-purge-inventory.mjs";
import { classifiedTables } from "../lib/backup-scope.ts";

// Do not attach fixtures to the app's normal runtime store.
const testRoot = mkdtempSync(path.join(tmpdir(), "lumi-archive-test-"));
after(() => rmSync(testRoot, { recursive: true, force: true }));
process.env.AI_EXECUTIVE_DATA_DIR = path.join(testRoot, "no-live-data");
mkdirSync(process.env.AI_EXECUTIVE_DATA_DIR);
const { applySchema } = await import("../lib/server-store.ts");
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(repo, "scripts/archive-purge-inventory.mjs");
const secret = "PRIVATE_ARCHIVE_TITLE_NEVER_PRINT";
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';

function schemaReference(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return inventoryDatabase(db).schemaDigest; }
  finally { db.close(); }
}
function attestation(file, filename, referenceSchemaSha256) {
  const buf = readFileSync(file);
  writeFileSync(filename, JSON.stringify({
    format: "lumi-archive-isolated-copy-v1", method: "sqlite-backup",
    consistent: true, sourceStoreIdentity: "a".repeat(64),
    referenceSchemaSha256,
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
  }), { mode: 0o600 });
}

function createFixture() {
  const dir = mkdtempSync(path.join(testRoot, "copy-"));
  const file = path.join(dir, "isolated.sqlite");
  const manifest = path.join(dir, "copy-attestation.json");
  const db = new DatabaseSync(file);
  try {
    // Real legacy schema and named migrations, not a test-only table sketch.
    applySchema(db);
    const entity = db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)");
    entity.run("workspace:personal", JSON.stringify({
      id: "workspace:personal", type: "workspace", title: secret, workspaceId: "personal",
    }), 1);
    for (const kind of ["task", "note", "project"]) {
      entity.run(kind + ":archived", JSON.stringify({
        id: kind + ":archived", type: kind, title: secret,
        content: secret, workspaceId: "personal",
      }), 1);
    }
    entity.run("area:archived", JSON.stringify({
      id: "area:archived", type: "area", title: secret, workspaceId: "personal",
    }), 1);
    const s = db.prepare(
      "INSERT INTO work_sessions(id,workspace_id,task_id,state,revision,accumulated_ms," +
      "running_since,started_at,completed_at,created_at,updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    );
    s.run("session:running", "personal", "task:archived", "running", 1, 0, 1, 1, null, 1, 1);
    s.run("session:completed", "personal", "task:other-store", "completed", 1, 10,
      null, 1, 10, 1, 10);
    db.prepare("INSERT INTO work_session_intervals(id,session_id,workspace_id,task_id,started_at,created_at) VALUES(?,?,?,?,?,?)")
      .run("interval:1", "session:running", "personal", "task:archived", 1, 1);
    db.prepare("INSERT INTO work_session_events(id,session_id,workspace_id,task_id,action,to_state,revision,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run("event:1", "session:running", "personal", "task:archived", "start", "running", 1, 1);
    const att = db.prepare(
      "INSERT INTO attention_states(workspace_id,attention_key,subject_id,rule_id," +
      "state,source_fingerprint,changed_at) VALUES(?,?,?,?,?,?,?)"
    );
    att.run("personal", "task", "task:archived", "rule", "active", "hash", 1);
    att.run("personal", "note", "note:archived", "rule", "active", "hash", 1);
    const notif = db.prepare(
      "INSERT INTO notification_deliveries(delivery_key,entity_id,reminder_at,status," +
      "last_attempt_at) VALUES(?,?,?,?,?)"
    );
    notif.run("delivery:task", "task:archived", "2026-01-01", "pending", 1);
    notif.run("delivery:project", "project:archived", "2026-01-01", "pending", 1);
    db.prepare(
      "INSERT INTO calendar_sources(id,workspace_id,provider,label,encrypted_url,status," +
      "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
    ).run("source:one", "personal", "ical", "calendar", "encrypted", "active", 1, 1);
    const humanWiki = db.prepare(
      "INSERT INTO context_subjects(id,workspace_id,subject_type,canonical_entity_id," +
      "display_title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
    );
    humanWiki.run("subject:task", "personal", "task", "task:archived", secret, 1, 1);
    humanWiki.run("subject:project", "personal", "project", "project:archived", secret, 1, 1);
    humanWiki.run("subject:unlinked", "personal", "person", null, secret, 1, 1);
    humanWiki.run("subject:external", "personal", "task", "task:other-store", secret, 1, 1);
    const revision = db.prepare(
      "INSERT INTO note_revisions(id,note_id,workspace_id,revision,title,content," +
      "content_sha256,origin,store_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
    );
    revision.run("rev:archive", "note:archived", "personal", 1, secret,
      secret, "a".repeat(64), "test", 1, 1);
    revision.run("rev:external", "note:other-store", "personal", 1, secret,
      secret, "b".repeat(64), "test", 1, 1);
  } finally {
    db.close();
  }
  const baselineSchema = schemaReference(file);
  attestation(file, manifest, baselineSchema);
  return {
    file, manifest,
    refresh: () => attestation(file, manifest, baselineSchema),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function cli(f) {
  return spawnSync(process.execPath,
    [script, "--db-copy", f.file, "--manifest", f.manifest], { encoding: "utf8" });
}

test("inventory contract includes every real schema table and classified backup table", () => {
  assert.deepEqual([...KNOWN_TABLES].sort(), [...classifiedTables()].sort());
  const f = createFixture();
  try {
    const report = inventoryCopy(f.file, f.manifest);
    assert.deepEqual(report.missingTables, []);
    assert.equal(report.unknownTableCount, 0);
    assert.equal(report.missingTriggerCount, 0, "real migrations must create expected triggers");
    assert.equal(report.unknownTriggerCount, 0);
    assert.deepEqual(report.invalidColumns, []);
    assert.equal(report.inventoryComplete, true);
  } finally { f.cleanup(); }
});

test("isolated real-schema inventory reports running/deleted-task matrix without private content", () => {
  const f = createFixture();
  try {
    const report = inventoryCopy(f.file, f.manifest);
    assert.equal(report.format, "lumi-archive-inventory-v2");
    assert.equal(report.destructiveActionsAllowed, false);
    assert.equal(report.copyHashMatched, true);
    assert.equal(report.entityCounts.task, 1);
    assert.equal(report.entityCounts.note, 1);
    assert.equal(report.entityCounts.project, 1);
    assert.deepEqual(report.sessionsByState.running,
      { total: 1, linkedToArchiveTask: 1, notMatchedInArchive: 0 });
    assert.deepEqual(report.sessionsByState.completed,
      { total: 1, linkedToArchiveTask: 0, notMatchedInArchive: 1 });
    assert.deepEqual(report.taskLinks.work_sessions,
      { total: 2, linkedToArchive: 1, notMatchedInArchive: 1 });
    assert.deepEqual(report.workspaceLinks.calendar_sources,
      { total: 1, linkedToLegacyWorkspace: 1, withoutMatchingLegacyWorkspace: 0 });
    assert.equal(report.derivedLinks.attention_states.linkedToArchive, 2);
    assert.equal(report.derivedLinks.notification_deliveries.linkedToArchive, 2);
    assert.deepEqual(report.derivedLinks.context_subjects, {
      total: 4, nullReferences: 1, nonNullReferences: 3,
      linkedToArchive: 2, notMatchedInArchive: 1,
    });
    assert.deepEqual(report.derivedLinks.note_revisions, {
      total: 2, linkedToArchive: 1, notMatchedInArchive: 1,
    });
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(JSON.stringify(report).includes(f.file), false);
    const proc = cli(f);
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(JSON.parse(proc.stdout).inventoryComplete, true);
    for (const output of [proc.stdout, proc.stderr]) {
      assert.equal(output.includes(secret), false);
      assert.equal(output.includes(f.file), false);
    }
  } finally { f.cleanup(); }
});

test("workspace-link inventory scales by distinct workspace, not entities per row", () => {
  const f = createFixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      // A large protected table with just two distinct workspaces. The old
      // correlated query parsed/scanned all entities once for each row.
      const insert = db.prepare(
        "INSERT INTO context_commands(workspace_id,idempotency_key,request_hash," +
        "result_payload,created_at) VALUES(?,?,?,?,?)"
      );
      for (let i = 0; i < 3000; i++) {
        insert.run(i % 2 === 0 ? "personal" : "external",
          "command:" + i, "hash", "{}", 1);
      }
      const plan = db.prepare(
        "EXPLAIN QUERY PLAN SELECT workspace_id, COUNT(*) FROM context_commands GROUP BY workspace_id"
      ).all().map((row) => String(row.detail)).join(" ");
      assert.doesNotMatch(plan, /CORRELATED SCALAR SUBQUERY|SCAN e\\b/i);
    } finally { db.close(); }
    f.refresh();
    const report = inventoryCopy(f.file, f.manifest);
    assert.equal(report.inventoryComplete, true);
    assert.deepEqual(report.workspaceLinks.context_commands, {
      total: 3000, linkedToLegacyWorkspace: 1500, withoutMatchingLegacyWorkspace: 1500,
    });
  } finally { f.cleanup(); }
});

test("symlinked protected data root resolves to physical directory and refuses live copy", () => {
  const f = createFixture();
  const oldRoot = process.env.AI_EXECUTIVE_DATA_DIR;
  const alias = path.join(testRoot, "configured-root-alias");
  try {
    symlinkSync(path.dirname(f.file), alias, "dir");
    process.env.AI_EXECUTIVE_DATA_DIR = alias;
    assert.throws(() => inventoryCopy(f.file, f.manifest), /live-database-refused/);
    process.env.AI_EXECUTIVE_DATA_DIR = path.join(testRoot, "root-does-not-exist");
    assert.throws(() => inventoryCopy(f.file, f.manifest), /protected-directory-unverified/);
  } finally {
    process.env.AI_EXECUTIVE_DATA_DIR = oldRoot;
    rmSync(alias);
    f.cleanup();
  }
});

test("inverting running/completed task references changes per-state dependency matrix", () => {
  const f = createFixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      db.exec("UPDATE work_sessions SET task_id='task:other-store' WHERE id='session:running'");
      db.exec("UPDATE work_sessions SET task_id='task:archived' WHERE id='session:completed'");
    } finally { db.close(); }
    f.refresh();
    const matrix = inventoryCopy(f.file, f.manifest).sessionsByState;
    assert.equal(matrix.running.linkedToArchiveTask, 0);
    assert.equal(matrix.completed.linkedToArchiveTask, 1);
  } finally { f.cleanup(); }
});

test("missing required task column fails closed, despite all table names being present", () => {
  const f = createFixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      db.exec("DROP TABLE work_session_intervals");
      db.exec("CREATE TABLE work_session_intervals(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL)");
    } finally { db.close(); }
    f.refresh();
    const report = inventoryCopy(f.file, f.manifest);
    assert.equal(report.inventoryComplete, false);
    assert.ok(report.invalidColumns.includes("work_session_intervals.task_id"));
    assert.ok(report.blockers.includes("invalid-schema-columns"));
    assert.deepEqual(report.taskLinks, {});
  } finally { f.cleanup(); }
});

test("unknown table and trigger names never enter JSON or stderr", () => {
  const f = createFixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      db.exec("CREATE TABLE " + quote(secret) + "(id TEXT)");
      db.exec("CREATE TRIGGER " + quote(secret + "_trigger") + " AFTER INSERT ON push_subscriptions BEGIN SELECT 1; END");
    } finally { db.close(); }
    f.refresh();
    const report = inventoryCopy(f.file, f.manifest);
    assert.equal(report.inventoryComplete, false);
    assert.equal(report.unknownTableCount, 1);
    assert.equal(report.unknownTriggerCount, 1);
    assert.equal(JSON.stringify(report).includes(secret), false);
    const proc = cli(f);
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout.includes(secret), false);
    assert.equal(proc.stderr.includes(secret), false);
  } finally { f.cleanup(); }
});

test("deleted required trigger is classified as schema drift", () => {
  const f = createFixture();
  try {
    const db = new DatabaseSync(f.file);
    try { db.exec("DROP TRIGGER mail_workspace_deleted"); }
    finally { db.close(); }
    f.refresh();
    const report = inventoryCopy(f.file, f.manifest);
    assert.ok(report.missingTriggerCount > 0);
    assert.ok(report.blockers.includes("missing-triggers"));
    assert.equal(report.inventoryComplete, false);
  } finally { f.cleanup(); }
});

test("a same-name trigger with a changed body fails the trusted schema digest", () => {
  const f = createFixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      db.exec("DROP TRIGGER mail_workspace_deleted");
      db.exec("CREATE TRIGGER mail_workspace_deleted AFTER DELETE ON entities BEGIN SELECT 1; END");
    } finally { db.close(); }
    f.refresh();
    const report = inventoryCopy(f.file, f.manifest);
    assert.equal(report.missingTriggerCount, 0);
    assert.ok(report.blockers.includes("schema-manifest-drift"));
    assert.equal(report.inventoryComplete, false);
  } finally { f.cleanup(); }
});

test("malformed entity payload stays private and fails classification closed", () => {
  const f = createFixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      // The real semantic outbox trigger correctly rejects invalid JSON on INSERT.
      // Temporarily suspend it to model pre-migration corruption on disk.
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?")
        .get("semantic_outbox_entities_insert").sql;
      db.exec("DROP TRIGGER semantic_outbox_entities_insert");
      db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)")
        .run("task:corrupt", secret + "-invalid-json", 1);
      db.exec(ddl);
    } finally { db.close(); }
    f.refresh();
    const report = inventoryCopy(f.file, f.manifest);
    assert.equal(report.malformedEntityRows, 1);
    assert.equal(report.inventoryComplete, false);
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally { f.cleanup(); }
});

test("CLI refuses --apply, hardlink alias, symlinks, sidecars, missing/stale manifest", () => {
  const f = createFixture();
  try {
    const proc = spawnSync(process.execPath, [script, "--apply", f.file], { encoding: "utf8" });
    assert.equal(proc.status, 2);
    assert.equal(proc.stdout, "");
    assert.throws(() => inventoryCopy("relative.sqlite", f.manifest));
    assert.throws(() => inventoryCopy(f.file));
    const alias = path.join(path.dirname(f.file), "hardlink.sqlite");
    linkSync(f.file, alias);
    assert.throws(() => inventoryCopy(alias, f.manifest), /unsafe-file/);
    rmSync(alias);
    const symlink = path.join(path.dirname(f.file), "link.sqlite");
    symlinkSync(f.file, symlink);
    assert.throws(() => inventoryCopy(symlink, f.manifest));
    rmSync(symlink);
    const wal = f.file + "-wal";
    writeFileSync(wal, "uncheckpointed");
    assert.throws(() => inventoryCopy(f.file, f.manifest), /sqlite-sidecars-refused/);
    rmSync(wal);
    symlinkSync(f.manifest, f.file + "-shm");
    assert.throws(() => inventoryCopy(f.file, f.manifest), /sqlite-sidecars-refused/);
    rmSync(f.file + "-shm");
    const original = readFileSync(f.manifest, "utf8");
    writeFileSync(f.manifest, JSON.stringify({ ...JSON.parse(original), sha256: "0".repeat(64) }));
    assert.throws(() => inventoryCopy(f.file, f.manifest), /manifest-mismatch/);
    writeFileSync(f.manifest, original);
    assert.equal(inventoryCopy(f.file, f.manifest).copyHashMatched, true);
  } finally { f.cleanup(); }
});
