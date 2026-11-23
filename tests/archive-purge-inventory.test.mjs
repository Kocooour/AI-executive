import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_TABLES, inventoryCopy } from "../scripts/archive-purge-inventory.mjs";
import { classifiedTables } from "../lib/backup-scope.ts";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(repo, "scripts/archive-purge-inventory.mjs");
const secret = "PRIVATE_ARCHIVE_TITLE_NEVER_PRINT";

function quote(name) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "lumi-archive-inventory-"));
  const file = path.join(dir, "isolated.sqlite");
  const db = new DatabaseSync(file);
  try {
    // The fixture must cover every table in the actual legacy schema classification.
    for (const table of KNOWN_TABLES) {
      const special = {
        entities: "id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL",
        work_sessions: "id TEXT PRIMARY KEY, state TEXT, workspace_id TEXT, task_id TEXT",
        work_session_intervals: "id TEXT PRIMARY KEY, workspace_id TEXT, task_id TEXT",
        work_session_events: "id TEXT PRIMARY KEY, workspace_id TEXT, task_id TEXT",
        attention_states: "id TEXT PRIMARY KEY, workspace_id TEXT, subject_id TEXT",
        notification_deliveries: "id TEXT PRIMARY KEY, entity_id TEXT",
        calendar_sources: "id TEXT PRIMARY KEY, workspace_id TEXT",
        context_claims: "id TEXT PRIMARY KEY, workspace_id TEXT",
      };
      db.exec("CREATE TABLE " + quote(table) + " (" + (special[table] || "id TEXT PRIMARY KEY") + ")");
    }
    const entity = db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)");
    entity.run("workspace:personal", JSON.stringify({
      id: "workspace:personal", type: "workspace", title: secret, workspaceId: "personal",
    }), 1);
    entity.run("task:archive", JSON.stringify({
      id: "task:archive", type: "task", title: secret, content: secret,
    }), 1);
    entity.run("note:archive", JSON.stringify({
      id: "note:archive", type: "note", title: secret, content: secret,
    }), 1);
    db.exec("INSERT INTO work_sessions VALUES ('session-1','running','personal','task:archive')");
    db.exec("INSERT INTO work_sessions VALUES ('session-2','completed','personal','task:elsewhere')");
    db.exec("INSERT INTO work_session_intervals VALUES ('interval-1','personal','task:archive')");
    db.exec("INSERT INTO work_session_events VALUES ('event-1','personal','task:archive')");
    db.exec("INSERT INTO attention_states VALUES ('attention-1','personal','task:archive')");
    db.exec("INSERT INTO notification_deliveries VALUES ('notice-1','task:archive')");
    db.exec("INSERT INTO calendar_sources VALUES ('calendar-1','personal')");
    db.exec("INSERT INTO context_claims VALUES ('claim-1','personal')");
  } finally {
    db.close();
  }
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("inventory table contract stays aligned with the backup schema classification", () => {
  assert.deepEqual([...KNOWN_TABLES].sort(), [...classifiedTables()].sort());
  assert.equal(new Set(KNOWN_TABLES).size, KNOWN_TABLES.length);
});

test("read-only inventory counts all categories and logical references without item content", () => {
  const f = fixture();
  try {
    const report = inventoryCopy(f.file);
    assert.equal(report.format, "lumi-archive-inventory-v1");
    assert.equal(report.diagnosticOnly, true);
    assert.equal(report.destructiveActionsAllowed, false);
    assert.equal(report.inventoryComplete, true);
    assert.equal(report.integrityOk, true);
    assert.deepEqual(report.missingTables, []);
    assert.deepEqual(report.unknownTables, []);
    assert.equal(report.entityCounts.task, 1);
    assert.equal(report.entityCounts.note, 1);
    assert.equal(report.entityCounts.workspace, 1);
    assert.deepEqual(report.sessionsByState, { running: 1, completed: 1 });
    assert.deepEqual(report.taskLinks.work_sessions, {
      total: 2, linkedToLegacy: 1, withoutMatchingLegacy: 1,
    });
    assert.deepEqual(report.workspaceLinks.calendar_sources, {
      total: 1, linkedToLegacyWorkspace: 1, withoutMatchingLegacyWorkspace: 0,
    });
    assert.equal(report.derivedLinks.attention_states.linkedToLegacy, 1);
    assert.equal(report.derivedLinks.notification_deliveries.linkedToLegacy, 1);
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(JSON.stringify(report).includes(f.file), false);
    const proc = spawnSync(process.execPath, [script, "--db-copy", f.file], { encoding: "utf8" });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.stdout.includes(secret), false);
    assert.equal(proc.stdout.includes(f.file), false);
    assert.equal(proc.stderr.includes(secret), false);
    assert.equal(JSON.parse(proc.stdout).inventoryComplete, true);
  } finally {
    f.cleanup();
  }
});

test("invalid JSON and unfamiliar tables fail classification closed without leaking payloads", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.file);
    try {
      db.prepare("INSERT INTO entities(id,payload,updated_at) VALUES(?,?,?)")
        .run("task:broken", "invalid-json " + secret, 1);
      db.exec("CREATE TABLE new_unclassified_table(id TEXT)");
    } finally {
      db.close();
    }
    const report = inventoryCopy(f.file);
    assert.equal(report.inventoryComplete, false);
    assert.equal(report.malformedEntityRows, 1);
    assert.deepEqual(report.unknownTables, ["new_unclassified_table"]);
    assert.ok(report.blockers.includes("malformed-entities"));
    assert.ok(report.blockers.includes("unclassified-schema-tables"));
    assert.equal(JSON.stringify(report).includes(secret), false);
    const proc = spawnSync(process.execPath, [script, "--db-copy", f.file], { encoding: "utf8" });
    assert.equal(proc.status, 1);
    assert.equal(proc.stdout.includes(secret), false);
    assert.equal(proc.stderr.includes(secret), false);
  } finally {
    f.cleanup();
  }
});

test("CLI rejects --apply, relative paths, symlinks and configured live data directory", () => {
  const f = fixture();
  try {
    const proc = spawnSync(process.execPath, [script, "--apply", f.file], { encoding: "utf8" });
    assert.equal(proc.status, 2);
    assert.equal(proc.stdout, "");
    assert.throws(() => inventoryCopy("isolated.sqlite"));
    const link = path.join(f.dir, "copy-link.sqlite");
    symlinkSync(f.file, link);
    assert.throws(() => inventoryCopy(link));
    const originalDir = process.env.AI_EXECUTIVE_DATA_DIR;
    process.env.AI_EXECUTIVE_DATA_DIR = f.dir;
    try {
      assert.throws(() => inventoryCopy(f.file), /live-database-refused/);
    } finally {
      if (originalDir === undefined) delete process.env.AI_EXECUTIVE_DATA_DIR;
      else process.env.AI_EXECUTIVE_DATA_DIR = originalDir;
    }
  } finally {
    f.cleanup();
  }
});
