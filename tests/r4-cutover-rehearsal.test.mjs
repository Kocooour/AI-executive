import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isWithinPath } from "../scripts/r4-path-boundary.mjs";

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
  return spawnSync(process.execPath, [script, ...args, "--offline-confirmed"], {
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
  assert.equal(report.connectors.sync.reconciliationPending, null,
    "older sync schema without message reconciliation must report unknown, not zero");
  assert.equal(report.connectors.sync.status, "complete");
  assert.match(report.schema.appliedMigrationsSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.backups.files, 1);
  assert.equal(sha(path.join(source, "store.sqlite")), original);
});

test("inventory reports anonymous iCloud account and linked CalDAV sync states", t => {
  const { source, base } = fixture(t);
  const db = new DatabaseSync(path.join(source, "store.sqlite"));
  try {
    db.exec(`
      CREATE TABLE calendar_accounts (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT NOT NULL,
        last_success_at INTEGER, label TEXT, last_error TEXT,
        encrypted_credentials TEXT
      );
      CREATE TABLE calendar_sources (
        id TEXT PRIMARY KEY, account_id TEXT, provider TEXT NOT NULL,
        status TEXT NOT NULL, last_success_at INTEGER, label TEXT,
        last_error TEXT, encrypted_url TEXT
      );
    `);
    const account = db.prepare("INSERT INTO calendar_accounts VALUES (?,?,?,?,?,?,?)");
    account.run("icloud-secret-id", "icloud", "auth_failed", 1700000000000, SECRET, SECRET, SECRET);
    account.run("icloud-second-id", "icloud", "ready", 1700003000000, SECRET, SECRET, SECRET);
    account.run("different-provider", "other", "error", 1700004000000, SECRET, SECRET, SECRET);
    const sourceRow = db.prepare("INSERT INTO calendar_sources VALUES (?,?,?,?,?,?,?,?)");
    sourceRow.run("calendar-pending", "icloud-secret-id", "caldav", "pending", null, SECRET, SECRET, SECRET);
    sourceRow.run("calendar-error", "icloud-secret-id", "caldav", "error", 1700002000000, SECRET, SECRET, SECRET);
    sourceRow.run("calendar-unknown", "icloud-second-id", "caldav", SECRET, 1700001000000, SECRET, SECRET, SECRET);
    sourceRow.run("unrelated-ics", "icloud-secret-id", "ics", "error", 1700009000000, SECRET, SECRET, SECRET);
    sourceRow.run("unrelated-provider", "different-provider", "caldav", "error", 1700009000000, SECRET, SECRET, SECRET);
  } finally { db.close(); }
  const output = path.join(base, "icloud-failed");
  const result = run(inventory, [source, output]);
  assert.equal(result.status, 0, result.stderr);
  const reportText = readFileSync(path.join(output, "inventory.json"), "utf8");
  const summaryText = readFileSync(path.join(output, "summary.txt"), "utf8");
  const report = JSON.parse(reportText);
  assert.equal(report.connectors.icloudPresent, true);
  const { accounts, calendars } = report.connectors.icloudSync;
  assert.equal(accounts.schema, "available");
  assert.equal(accounts.total, 2);
  assert.equal(accounts.byStatus.auth_failed, 1);
  assert.equal(accounts.byStatus.ready, 1);
  assert.equal(accounts.byStatus.error, 0);
  assert.deepEqual(accounts.lastSuccessAt, { earliest: 1700000000000, latest: 1700003000000 });
  assert.equal(calendars.schema, "available");
  assert.equal(calendars.total, 3);
  assert.equal(calendars.byStatus.pending, 1);
  assert.equal(calendars.byStatus.error, 1);
  assert.equal(calendars.byStatus.other, 1, "unrecognized private states are bucketed");
  assert.deepEqual(calendars.lastSuccessAt, { earliest: 1700001000000, latest: 1700002000000 });
  for (const outputText of [reportText, summaryText, result.stdout, result.stderr]) {
    assert.equal(outputText.includes(SECRET), false, "private iCloud values may not leak");
    assert.equal(outputText.includes("icloud-secret-id"), false);
    assert.equal(outputText.includes("calendar-pending"), false);
  }
});

test("inventory distinguishes empty iCloud state from missing schemas", t => {
  const { source, base } = fixture(t);
  const first = run(inventory, [source, path.join(base, "icloud-not-present")]);
  assert.equal(first.status, 0, first.stderr);
  const unavailable = JSON.parse(readFileSync(path.join(base, "icloud-not-present", "inventory.json"), "utf8"));
  for (const group of ["accounts", "calendars"]) {
    assert.equal(unavailable.connectors.icloudSync[group].schema, "not_available");
    assert.equal(unavailable.connectors.icloudSync[group].total, null);
    assert.equal(unavailable.connectors.icloudSync[group].byStatus, null);
  }

  const db = new DatabaseSync(path.join(source, "store.sqlite"));
  try {
    db.exec(`
      CREATE TABLE calendar_accounts (id TEXT PRIMARY KEY, provider TEXT, status TEXT, last_success_at INTEGER);
      CREATE TABLE calendar_sources (id TEXT PRIMARY KEY, account_id TEXT, provider TEXT, status TEXT, last_success_at INTEGER);
    `);
  } finally { db.close(); }
  const second = run(inventory, [source, path.join(base, "icloud-empty")]);
  assert.equal(second.status, 0, second.stderr);
  const empty = JSON.parse(readFileSync(path.join(base, "icloud-empty", "inventory.json"), "utf8"));
  assert.equal(empty.connectors.icloudPresent, false);
  for (const group of ["accounts", "calendars"]) {
    const value = empty.connectors.icloudSync[group];
    assert.equal(value.schema, "available");
    assert.equal(value.total, 0);
    assert.equal(value.byStatus.error, 0);
    assert.equal(value.byStatus.auth_failed, 0);
    assert.deepEqual(value.lastSuccessAt, { earliest: null, latest: null });
  }
});

test("inventory does not claim iCloud sync readiness for incomplete old schemas", t => {
  const { source, base } = fixture(t);
  const db = new DatabaseSync(path.join(source, "store.sqlite"));
  try {
    db.exec(`
      CREATE TABLE calendar_accounts (id TEXT PRIMARY KEY, provider TEXT, status TEXT, label TEXT);
      CREATE TABLE calendar_sources (id TEXT PRIMARY KEY, provider TEXT, status TEXT, last_success_at INTEGER);
    `);
    db.prepare("INSERT INTO calendar_accounts VALUES (?,?,?,?)")
      .run("private-account", "icloud", "auth_failed", SECRET);
  } finally { db.close(); }
  const output = path.join(base, "icloud-partial");
  const result = run(inventory, [source, output]);
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(path.join(output, "inventory.json"), "utf8");
  const report = JSON.parse(text);
  assert.equal(report.connectors.icloudPresent, true);
  for (const group of ["accounts", "calendars"]) {
    assert.equal(report.connectors.icloudSync[group].schema, "not_available");
    assert.equal(report.connectors.icloudSync[group].total, null);
    assert.equal(report.connectors.icloudSync[group].byStatus, null);
  }
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("private-account"), false);
});

test("inventory reports reconciliation backlog even after Gmail checkpoints clear", t => {
  const { source, base } = fixture(t);
  const file = path.join(source, "store.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE mail_sync_messages (
        account_id TEXT NOT NULL, message_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL, needs_reconcile INTEGER NOT NULL
      );
      UPDATE mail_sync_accounts SET
        last_synced_at=1700000000000, history_backlog_pending=0,
        pending_event_id=NULL, recovery_inbox_page_token=NULL,
        recovery_sent_page_token=NULL;
    `);
    db.prepare("INSERT INTO mail_sync_messages VALUES (?,?,?,?)")
      .run("account", "pending-id", SECRET, 1);
    db.prepare("INSERT INTO mail_sync_messages VALUES (?,?,?,?)")
      .run("account", "ready-id", SECRET, 0);
  } finally { db.close(); }

  const first = run(inventory, [source, path.join(base, "reconcile-present")]);
  assert.equal(first.status, 0, first.stderr);
  const firstReport = JSON.parse(readFileSync(path.join(base, "reconcile-present", "inventory.json"), "utf8"));
  assert.equal(firstReport.connectors.sync.status, "complete");
  assert.equal(firstReport.connectors.sync.pending, 0);
  assert.equal(firstReport.connectors.sync.recoveryPending, 0);
  assert.equal(firstReport.connectors.sync.reconciliationPending, 1,
    "a cleared history cursor does not prove message reconciliation");
  assert.equal(firstReport.connectors.syncedMessageRows, 2);
  assert.equal(JSON.stringify(firstReport).includes(SECRET), false);
  assert.equal(first.stdout.includes(SECRET), false);
  assert.equal(first.stderr.includes(SECRET), false);

  const updated = new DatabaseSync(file);
  try {
    updated.prepare("UPDATE mail_sync_messages SET needs_reconcile=0 WHERE message_id=?")
      .run("pending-id");
  } finally { updated.close(); }
  const second = run(inventory, [source, path.join(base, "reconcile-clear")]);
  assert.equal(second.status, 0, second.stderr);
  const secondReport = JSON.parse(readFileSync(path.join(base, "reconcile-clear", "inventory.json"), "utf8"));
  assert.equal(secondReport.connectors.sync.reconciliationPending, 0,
    "supported schema with no backlog must report zero");
  assert.equal(secondReport.connectors.sync.pending, 0);
  assert.equal(secondReport.connectors.sync.recoveryPending, 0);
});

test("inventory marks reconciliation as unavailable when message schema lacks the field", t => {
  const { source, base } = fixture(t);
  const db = new DatabaseSync(path.join(source, "store.sqlite"));
  try {
    db.exec("CREATE TABLE mail_sync_messages (account_id TEXT, message_id TEXT, subject TEXT)");
    db.prepare("INSERT INTO mail_sync_messages VALUES (?,?,?)").run("account", "legacy-id", SECRET);
  } finally { db.close(); }
  const out = path.join(base, "legacy-reconcile");
  const result = run(inventory, [source, out]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "inventory.json"), "utf8"));
  assert.equal(report.connectors.syncedMessageRows, 1);
  assert.equal(report.connectors.sync.reconciliationPending, null);
  assert.equal(JSON.stringify(report).includes(SECRET), false);
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

test("rehearsal --verify rejects duplicate or overlapping sources before creating output", t => {
  const { source, base } = fixture(t);
  const alias = path.join(base, "offline-alias");
  symlinkSync(source, alias, "dir");
  const nested = path.join(source, "nested-copy");
  mkdirSync(nested);

  const examples = [
    [source, source, "identical"],
    [source, alias, "symlink-alias"],
    [alias, source, "reverse-alias"],
    [source, nested, "nested"],
    [nested, source, "parent"],
  ];
  for (const [expected, candidate, name] of examples) {
    const out = path.join(base, "verify-input-" + name);
    const result = run(rehearsal, ["--verify", expected, candidate, out]);
    assert.notEqual(result.status, 0, "must reject " + name);
    assert.equal(existsSync(out), false, "must not create output for " + name);
    assert.equal(result.stdout.includes(SECRET), false);
    assert.equal(result.stderr.includes(SECRET), false);
  }
});

test("rehearsal rejects overlapping optional target/config inputs", t => {
  const { source, base } = fixture(t);
  const alias = path.join(base, "offline-alias");
  symlinkSync(source, alias, "dir");
  const nested = path.join(source, "nested-config");
  mkdirSync(nested);
  for (const [flag, extra, name] of [
    ["--config-offline", source, "same-config"],
    ["--config-offline", nested, "nested-config"],
    ["--target-offline", alias, "alias-target"],
  ]) {
    const output = path.join(base, "nonverify-" + name);
    const result = run(rehearsal, [source, output, flag, extra]);
    assert.notEqual(result.status, 0, "must reject overlapping " + name);
    assert.equal(existsSync(output), false);
  }
});

test("rehearsal --verify still accepts separate independent input directories", t => {
  const { source, base } = fixture(t);
  const candidate = path.join(base, "independent-copy");
  cpSync(source, candidate, { recursive: true });
  // cpSync's newly created destination root may inherit permissions from the
  // runner's umask rather than the source. Align ONLY this positive fixture:
  // the independent copies must actually have matching root metadata.
  chmodSync(candidate, lstatSync(source).mode & 0o7777);
  assert.equal(lstatSync(candidate).mode & 0o7777, lstatSync(source).mode & 0o7777);
  const out = path.join(base, "verify-distinct");
  const result = run(rehearsal, ["--verify", source, candidate, out]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(path.join(out, "rehearsal.json"), "utf8"));
  assert.equal(report.verdict, "equal");
  assert.equal(report.mode, "verify-copies");
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
  const guarded = spawnSync(process.execPath, [rehearsal, source, path.join(base, "refused"), "--offline-confirmed"], {
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
    const result = spawnSync(process.execPath, [script, source, out, "--offline-confirmed"], {
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


test("both CLIs require explicit offline-snapshot acknowledgement before any output", t => {
  const { source, base } = fixture(t);
  for (const script of [inventory, rehearsal]) {
    const output = path.join(base, path.basename(script) + "-no-ack");
    const result = spawnSync(process.execPath, [script, source, output], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, AI_EXECUTIVE_DATA_DIR: "", AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: "" },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(output), false);
  }
});

test("both CLIs refuse implicit cwd/.data live source or output without environment config", t => {
  const { source, base } = fixture(t);
  const live = path.join(base, ".data");
  cpSync(source, live, { recursive: true });
  const alias = path.join(base, "default-alias");
  symlinkSync(live, alias, "dir");
  for (const script of [inventory, rehearsal]) {
    for (const candidate of [live, alias]) {
      const out = path.join(base, path.basename(script) + "-source-rejected");
      const result = spawnSync(process.execPath, [script, candidate, out, "--offline-confirmed"], {
        cwd: base, encoding: "utf8",
        env: { ...process.env, AI_EXECUTIVE_DATA_DIR: "", AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: "" },
      });
      assert.notEqual(result.status, 0, "must refuse implicit .data including symlink alias");
      assert.equal(existsSync(out), false);
    }
    for (const output of [path.join(live, "forbidden"), path.join(alias, "forbidden")]) {
      const result = spawnSync(process.execPath, [script, source, output, "--offline-confirmed"], {
        cwd: base, encoding: "utf8",
        env: { ...process.env, AI_EXECUTIVE_DATA_DIR: "", AI_EXECUTIVE_TARGET_STAGING_DIRECTORY: "" },
      });
      assert.notEqual(result.status, 0, "must refuse output under implicit live .data");
      assert.equal(existsSync(output), false);
    }
  }
});

test("inventory labels only exact known migration prefixes as known schema versions", t => {
  const { source, base } = fixture(t);
  const migrationText = readFileSync(path.join(root, "lib/schema-migrations.ts"), "utf8");
  const currentIds = [...migrationText.matchAll(/\bid:\s*"([^"]+)"/g)].map(match => match[1]);
  assert.ok(currentIds.length >= 2, "expected tracked named migrations");
  const file = path.join(source, "store.sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec("DELETE FROM schema_migrations");
    const insert = db.prepare("INSERT INTO schema_migrations (id) VALUES (?)");
    for (const id of currentIds) insert.run(id);
  } finally { db.close(); }
  const inventoryAt = name => {
    const out = path.join(base, name);
    const result = run(inventory, [source, out]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(path.join(out, "inventory.json"), "utf8")).schema;
  };
  const full = inventoryAt("current-version");
  assert.equal(full.migrationIdentity, "known_current");
  assert.equal(full.knownSchemaVersion, "legacy-migrations-" + currentIds.length);
  assert.equal(full.expectedMigrationCount, currentIds.length);
  const olderDb = new DatabaseSync(file);
  try { olderDb.prepare("DELETE FROM schema_migrations WHERE id=?").run(currentIds.at(-1)); }
  finally { olderDb.close(); }
  const older = inventoryAt("older-version");
  assert.equal(older.migrationIdentity, "known_older");
  assert.equal(older.knownSchemaVersion, "legacy-migrations-" + (currentIds.length - 1));
  const unknownDb = new DatabaseSync(file);
  try {
    unknownDb.prepare("DELETE FROM schema_migrations WHERE id=?").run(currentIds[0]);
    unknownDb.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run("not-a-known-migration");
  } finally { unknownDb.close(); }
  const unknown = inventoryAt("unknown-version");
  assert.equal(unknown.migrationRows, older.migrationRows);
  assert.equal(unknown.migrationIdentity, "unknown");
  assert.equal(unknown.knownSchemaVersion, null);
});


test("root-aware path containment rejects the root overlap without visiting real root", () => {
  // Pure function only: do not run either CLI against '/'.
  assert.equal(isWithinPath("/", "/"), true);
  assert.equal(isWithinPath("/tmp/new-output", "/"), true);
  assert.equal(isWithinPath("/tmp/new-output", "/tmp"), true);
  assert.equal(isWithinPath("/tmp", "/tmp"), true);
  assert.equal(isWithinPath("/tmp/sibling", "/tmp/source"), false);
  assert.equal(isWithinPath("/tmp-evasion", "/tmp"), false);
  assert.equal(isWithinPath("/tmp/source", "/tmp/source/sub"), false);
  assert.equal(isWithinPath("/tmp/source/sub", "/tmp/source"), true);
});

test("rehearsal protects original ownership/mode in private manifest while archived copies stay private", t => {
  const { source, base } = fixture(t);
  const backup = path.join(source, "backups", "private.backup");
  const sensitiveName = "secret-" + SECRET + ".bak";
  const secret = path.join(source, "backups", sensitiveName);
  writeFileSync(secret, SECRET, { mode: 0o640 });
  chmodSync(backup, 0o640);
  chmodSync(path.join(source, "backups"), 0o750);
  const original = lstatSync(backup);
  const out = path.join(base, "manifest-verified");
  const result = run(rehearsal, [source, out]);
  assert.equal(result.status, 0, result.stderr);
  const privateFile = path.join(out, "archive", "private-file-manifest.json");
  const content = readFileSync(privateFile, "utf8");
  const privateManifest = JSON.parse(content);
  const reportText = readFileSync(path.join(out, "rehearsal.json"), "utf8");
  const report = JSON.parse(reportText);
  const items = privateManifest.trees.legacy.entries;
  const file = items.find(row => row.relative === path.join("backups", "private.backup"));
  const dir = items.find(row => row.relative === "backups");
  assert.equal(file.mode, 0o640);
  assert.equal(file.uid, original.uid);
  assert.equal(file.gid, original.gid);
  assert.equal(dir.mode, 0o750);
  assert.match(file.digest, /^[0-9a-f]{64}$/);
  assert.equal(report.privateManifestSha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(privateManifest.trees.legacy.root.mode, lstatSync(source).mode & 0o7777);
  assert.equal(privateManifest.format, "lumi-r4-private-file-manifest-v1");
  assert.equal(items.some(row => row.relative.includes(sensitiveName)), true);
  assert.equal(reportText.includes(SECRET), false);
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stderr.includes(SECRET), false);
  assert.equal(lstatSync(privateFile).mode & 0o7777, 0o600);
  assert.equal(lstatSync(path.join(out, "archive", "legacy", "backups", "private.backup")).mode & 0o7777, 0o600);
  assert.equal(lstatSync(path.join(out, "archive", "legacy", "backups")).mode & 0o7777, 0o700);
  assert.equal(lstatSync(path.join(out, "restored", "legacy", "backups", "private.backup")).mode & 0o7777, 0o600);
});

test("verify-copies rejects a root-directory-only mode mismatch", t => {
  const { source, base } = fixture(t);
  const candidate = path.join(base, "root-only-mode-change");
  cpSync(source, candidate, { recursive: true });
  // No file content, nested directory, or file metadata is changed. Only the
  // input root differs, which must be included in original-metadata equality.
  chmodSync(source, 0o700);
  chmodSync(candidate, 0o750);
  assert.notEqual(lstatSync(source).mode & 0o7777, lstatSync(candidate).mode & 0o7777);
  const sourceDigest = sha(path.join(source, "store.sqlite"));
  const candidateDigest = sha(path.join(candidate, "store.sqlite"));
  assert.equal(sourceDigest, candidateDigest);
  const output = path.join(base, "root-mode-verification");
  const result = run(rehearsal, ["--verify", source, candidate, output]);
  assert.notEqual(result.status, 0, "root metadata mismatch must not pass");
  assert.equal(existsSync(path.join(output, "rehearsal.json")), false,
    "failed verification must not claim PASS");
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stderr.includes(SECRET), false);
  assert.equal(sha(path.join(source, "store.sqlite")), sourceDigest);
  assert.equal(sha(path.join(candidate, "store.sqlite")), candidateDigest);
});

test("verify-copies fails closed when original permissions differ despite identical bytes", t => {
  const { source, base } = fixture(t);
  const candidate = path.join(base, "changed-mode");
  cpSync(source, candidate, { recursive: true });
  chmodSync(path.join(candidate, "backups", "private.backup"), 0o640);
  const result = run(rehearsal, ["--verify", source, candidate, path.join(base, "mode-verify")]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.includes(SECRET), false);
});
