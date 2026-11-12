import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventory = path.join(root, "scripts/cutover-inventory.mjs");
const rehearsal = path.join(root, "deployment/rehearsal/cutover-restore-rehearsal.mjs");
const SECRET = "NEVER_LEAK_PRIVATE_TITLE_123456789";
function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), "lumi-r4-synthetic-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, "offline");
  mkdirSync(source, { mode: 0o700 });
  const db = new DatabaseSync(path.join(source, "store.sqlite"));
  try {
    db.exec([
      "CREATE TABLE entities (id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at INTEGER NOT NULL);",
      "CREATE TABLE note_revisions (id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at INTEGER NOT NULL);",
      "CREATE TABLE context_claims (id TEXT PRIMARY KEY,literal_value TEXT,updated_at INTEGER NOT NULL);",
      "CREATE TABLE context_evidence (id TEXT PRIMARY KEY,body TEXT,created_at INTEGER NOT NULL);",
      "CREATE TABLE work_sessions (id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL);",
      "CREATE TABLE mail_accounts (id TEXT PRIMARY KEY,provider TEXT NOT NULL,updated_at INTEGER NOT NULL);",
      "CREATE TABLE mail_sync_accounts (account_id TEXT PRIMARY KEY,last_synced_at INTEGER,history_backlog_pending INTEGER,pending_event_id TEXT,recovery_inbox_page_token TEXT,recovery_sent_page_token TEXT);",
      "CREATE TRIGGER mail_sync_disconnected AFTER DELETE ON mail_accounts BEGIN DELETE FROM mail_sync_accounts WHERE account_id=OLD.id; END;",
      "CREATE INDEX note_revision_created_idx ON note_revisions(created_at);",
      "CREATE VIEW note_count AS SELECT COUNT(*) AS total FROM note_revisions;",
      "CREATE TABLE passkey_credentials (id TEXT PRIMARY KEY,label TEXT NOT NULL,created_at INTEGER NOT NULL);",
      "CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY,endpoint TEXT NOT NULL,created_at INTEGER NOT NULL);",
      "CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);",
      "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);",
    ].join("\n"));
    db.prepare("INSERT INTO entities VALUES (?,?,?)").run("one", JSON.stringify({
      type: "note", title: SECRET, content: SECRET, workspaceId: "secret+" + SECRET + "@example.org",
    }), 1700000000000);
    db.prepare("INSERT INTO entities VALUES (?,?,?)").run("two", JSON.stringify({
      type: "task", title: SECRET, workspaceId: "personal",
    }), 1700000000001);
    db.prepare("INSERT INTO note_revisions VALUES (?,?,?)").run("rev", SECRET, 1700000000000);
    db.prepare("INSERT INTO context_claims VALUES (?,?,?)").run("claim", SECRET, 1700000000000);
    db.prepare("INSERT INTO context_evidence VALUES (?,?,?)").run("evidence", SECRET, 1700000000000);
    db.prepare("INSERT INTO work_sessions VALUES (?,?)").run("session", 1700000000000);
    db.prepare("INSERT INTO mail_accounts VALUES (?,?,?)").run("account", "gmail", 1700000000000);
    db.prepare("INSERT INTO mail_sync_accounts VALUES (?,?,?,?,?,?)")
      .run("account", null, 1, SECRET, SECRET, null);
    db.prepare("INSERT INTO passkey_credentials VALUES (?,?,?)").run("passkey", SECRET, 1700000000000);
    db.prepare("INSERT INTO push_subscriptions VALUES (?,?,?)").run("push", SECRET, 1700000000000);
    db.prepare("INSERT INTO metadata VALUES (?,?)").run("integration_api_token", SECRET);
    db.prepare("INSERT INTO schema_migrations VALUES (?)").run("1");
  } finally { db.close(); }
  const backups = path.join(source, "backups");
  mkdirSync(backups);
  writeFileSync(path.join(backups, "private.backup"), SECRET, { mode: 0o600 });
  return { base, source };
}
function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, AI_EXECUTIVE_DATA_DIR: "" },
    timeout: 15000,
  });
}
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");

test("inventory: content-free report and summary, no write to source", t => {
  const { source, base } = fixture(t), out = path.join(base, "report");
  const original = sha(path.join(source, "store.sqlite"));
  const result = run(inventory, [source, out]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "inventory.json"), "utf8"));
  const allOutput = JSON.stringify(report) + readFileSync(path.join(out, "summary.txt"), "utf8") + result.stdout + result.stderr;
  assert.equal(allOutput.includes(SECRET), false);
  assert.equal(allOutput.includes("example.org"), false);
  assert.equal(report.integrity, "ok");
  assert.equal(report.entities.count, 2);
  assert.equal(report.entities.byKind.note, 1);
  assert.equal(report.entities.byKind.task, 1);
  assert.equal(report.notes.revisionRows, 1);
  assert.equal(report.context.claims, 1);
  assert.equal(report.context.evidence, 1);
  assert.equal(report.work.sessions, 1);
  assert.equal(report.connectors.gmailPresent, true);
  assert.equal(report.credentials.passkeys, 1);
  assert.equal(report.credentials.pushTargets, 1);
  assert.equal(report.credentials.integrationTokenPresent, null);
  assert.equal(report.credentials.integrationTokenInspection, "environment_not_inspected");
  assert.equal(report.connectors.sync.neverSynced, 1);
  assert.equal(report.connectors.sync.pending, 1);
  assert.equal(report.connectors.sync.recoveryPending, 1);
  assert.equal(report.connectors.sync.status, "complete");
  assert.match(report.schema.appliedMigrationsSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.backups.files, 1);
  assert.equal(sha(path.join(source, "store.sqlite")), original);
});

test("inventory refuses aliases, overlapping paths and existing output", t => {
  const { source, base } = fixture(t);
  assert.notEqual(run(inventory, [source, source]).status, 0);
  assert.notEqual(run(inventory, [source, path.join(source, "child")]).status, 0);
  const output = path.join(base, "existing"); mkdirSync(output);
  writeFileSync(path.join(output, "sentinel"), "untouched");
  assert.notEqual(run(inventory, [source, output]).status, 0);
  assert.equal(readFileSync(path.join(output, "sentinel"), "utf8"), "untouched");
});

test("rehearsal: archival backup restored to a fresh directory with matching table digests", t => {
  const { source, base } = fixture(t), out = path.join(base, "success");
  const original = sha(path.join(source, "store.sqlite"));
  const result = run(rehearsal, [source, out]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "rehearsal.json"), "utf8"));
  assert.equal(report.verdict, "equal");
  assert.equal(report.sqliteIntegrity, "ok");
  assert.equal(report.tables.entities.count, 2);
  assert.match(report.tables.entities.rowsSha256, /^[0-9a-f]{64}$/);
  assert.equal(sha(path.join(source, "store.sqlite")), original);
  assert.ok(existsSync(path.join(out, "archive/archival-store.sqlite")));
  assert.ok(existsSync(path.join(out, "archive/legacy/backups/private.backup")));
  assert.ok(existsSync(path.join(out, "restored/legacy/backups/private.backup")));
  assert.equal(readFileSync(path.join(out, "restored/legacy/backups/private.backup"), "utf8"), SECRET);
  assert.equal(report.target.status, "not_provided");
  assert.match(report.schemaSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.tables.entities.count, 2);
});

test("rehearsal --verify rejects a tampered row", t => {
  const { source, base } = fixture(t);
  const candidate = path.join(base, "tampered");
  cpSync(source, candidate, { recursive: true });
  const db = new DatabaseSync(path.join(candidate, "store.sqlite"));
  try { db.prepare("UPDATE note_revisions SET body=? WHERE id='rev'").run("tampered"); }
  finally { db.close(); }
  const result = run(rehearsal, ["--verify", source, candidate, path.join(base, "verify-tamper")]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stderr.includes(SECRET), false);
});

test("rehearsal --verify rejects a missing table", t => {
  const { source, base } = fixture(t);
  const candidate = path.join(base, "missing");
  cpSync(source, candidate, { recursive: true });
  const db = new DatabaseSync(path.join(candidate, "store.sqlite"));
  try { db.exec("DROP TABLE note_revisions"); } finally { db.close(); }
  assert.notEqual(run(rehearsal, ["--verify", source, candidate, path.join(base, "verify-missing")]).status, 0);
});

test("rehearsal refuses existing output, alias of source and configured live source", t => {
  const { source, base } = fixture(t);
  const out = path.join(base, "existing");
  mkdirSync(out);
  writeFileSync(path.join(out, "sentinel"), "keep");
  assert.notEqual(run(rehearsal, [source, out]).status, 0);
  assert.equal(readFileSync(path.join(out, "sentinel"), "utf8"), "keep");
  assert.notEqual(run(rehearsal, [source, source]).status, 0);
  const guarded = spawnSync(process.execPath, [rehearsal, source, path.join(base, "refused")], {
    cwd: root, encoding: "utf8", env: { ...process.env, AI_EXECUTIVE_DATA_DIR: source },
  });
  assert.notEqual(guarded.status, 0);
  assert.equal(existsSync(path.join(base, "refused")), false);
});


test("rehearsal --verify rejects a dropped privacy trigger (schema objects)", t => {
  const { source, base } = fixture(t);
  const candidate = path.join(base, "missing-trigger");
  cpSync(source, candidate, { recursive: true });
  const db = new DatabaseSync(path.join(candidate, "store.sqlite"));
  try { db.exec("DROP TRIGGER mail_sync_disconnected"); }
  finally { db.close(); }
  const result = run(rehearsal, ["--verify", source, candidate, path.join(base, "verify-trigger")]);
  assert.notEqual(result.status, 0, "missing trigger must not pass a restore rehearsal");
});

test("inventory distinguishes migration sets with equal counts", t => {
  const { source, base } = fixture(t);
  const beforeDir = path.join(base, "inventory-versions-before");
  const first = run(inventory, [source, beforeDir]);
  assert.equal(first.status, 0, first.stderr);
  const before = JSON.parse(readFileSync(path.join(beforeDir, "inventory.json"), "utf8"));
  const db = new DatabaseSync(path.join(source, "store.sqlite"));
  try { db.exec("UPDATE schema_migrations SET id='different-migration'"); }
  finally { db.close(); }
  const afterDir = path.join(base, "inventory-versions-after");
  const second = run(inventory, [source, afterDir]);
  assert.equal(second.status, 0, second.stderr);
  const after = JSON.parse(readFileSync(path.join(afterDir, "inventory.json"), "utf8"));
  assert.equal(before.schema.migrationRows, after.schema.migrationRows);
  assert.notEqual(before.schema.appliedMigrationsSha256, after.schema.appliedMigrationsSha256);
});

test("rehearsal archives and restores synthetic target database, journal and witness as a unit", t => {
  const { source, base } = fixture(t);
  const target = path.join(base, "offline-target");
  mkdirSync(target);
  const db = new DatabaseSync(path.join(target, "lumi-target.sqlite"));
  try {
    db.exec("CREATE TABLE target_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    db.prepare("INSERT INTO target_metadata VALUES (?,?)").run("generation", SECRET);
  } finally { db.close(); }
  const witness = new DatabaseSync(path.join(target, "lumi-target-witness.sqlite"));
  try { witness.exec("CREATE TABLE commits(n INTEGER PRIMARY KEY,journal_hash TEXT NOT NULL)"); }
  finally { witness.close(); }
  writeFileSync(path.join(target, "lumi-target.journal"), SECRET + "\n", { mode: 0o600 });
  const out = path.join(base, "complete");
  const result = run(rehearsal, [source, out, "--target-offline", target]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "rehearsal.json"), "utf8"));
  assert.equal(report.target.status, "bytes_and_sqlite_verified");
  assert.equal(report.target.files, 3);
  assert.ok(existsSync(path.join(out, "archive/target/lumi-target.journal")));
  assert.equal(readFileSync(path.join(out, "restored/target/lumi-target.journal"), "utf8"), SECRET + "\n");
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(JSON.stringify(report).includes(SECRET), false);
});

test("rehearsal rejects symlinks in source backup tree rather than following them", async t => {
  const { source, base } = fixture(t);
  const foreign = path.join(base, "foreign");
  writeFileSync(foreign, SECRET);
  const { symlinkSync } = await import("node:fs");
  symlinkSync(foreign, path.join(source, "backups", "outside"));
  const out = path.join(base, "unsafe");
  const result = run(rehearsal, [source, out]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stderr.includes(SECRET), false);
});


test("inventory accepts only boolean operator attestation for environment token, without token content", t => {
  const { source, base } = fixture(t);
  const out = path.join(base, "attested");
  const result = run(inventory, [source, out, "--integration-token-present", "true"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "inventory.json"), "utf8"));
  assert.equal(report.credentials.integrationTokenPresent, true);
  assert.equal(report.credentials.integrationTokenInspection, "operator_attested");
  const invalid = run(inventory, [source, path.join(base, "invalid"), "--integration-token-present", SECRET]);
  assert.notEqual(invalid.status, 0);
  assert.equal(existsSync(path.join(base, "invalid")), false);
  assert.equal(invalid.stderr.includes(SECRET), false);
});

test("inventory and rehearsal refuse writing under configured production data", t => {
  const { source, base } = fixture(t);
  const home = path.join(base, "production");
  mkdirSync(home);
  for (const script of [inventory, rehearsal]) {
    const out = path.join(home, "forbidden");
    const result = spawnSync(process.execPath, [script, source, out], {
      cwd: root, encoding: "utf8", env: { ...process.env, AI_EXECUTIVE_DATA_DIR: home },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(out), false);
  }
});


test("rehearsal includes separate offline operator configuration without disclosing values", t => {
  const { source, base } = fixture(t);
  const config = path.join(base, "offline-config");
  mkdirSync(config);
  writeFileSync(path.join(config, "service.env"), "AI_EXECUTIVE_INTEGRATION_TOKEN=" + SECRET + "\n", { mode: 0o600 });
  const out = path.join(base, "external-config");
  const result = run(rehearsal, [source, out, "--config-offline", config]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "rehearsal.json"), "utf8"));
  assert.equal(report.externalConfiguration.status, "bytes_verified");
  assert.equal(report.externalConfiguration.files, 1);
  assert.equal(readFileSync(path.join(out, "restored/configuration/service.env"), "utf8"),
    "AI_EXECUTIVE_INTEGRATION_TOKEN=" + SECRET + "\n");
  assert.equal(JSON.stringify(report).includes(SECRET), false);
  assert.equal(result.stdout.includes(SECRET), false);
});

test("rehearsal refuses repeated or malicious offline source option", t => {
  const { source, base } = fixture(t);
  const out = path.join(base, "duplicate");
  const result = run(rehearsal, [source, out, "--config-offline", source, "--config-offline", source]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(out), false);
});
