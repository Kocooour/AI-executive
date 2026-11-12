import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(report.credentials.integrationTokenPresent, true);
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
  assert.ok(existsSync(path.join(out, "archive/store.sqlite")));
  assert.ok(existsSync(path.join(out, "restored/store.sqlite")));
});

test("rehearsal --verify rejects a tampered row", t => {
  const { source, base } = fixture(t);
  const candidate = path.join(base, "tampered");
  mkdirSync(candidate);
  copyFileSync(path.join(source, "store.sqlite"), path.join(candidate, "store.sqlite"));
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
  mkdirSync(candidate);
  copyFileSync(path.join(source, "store.sqlite"), path.join(candidate, "store.sqlite"));
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
