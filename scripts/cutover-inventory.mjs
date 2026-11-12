#!/usr/bin/env node
// R4 / issue #408: content-free inventory of a DISPOSABLE, OFFLINE legacy data snapshot.
// Never open the original SQLite file: SQLite read-only connections may update -shm.
// Writes only to a NEW, expressly named directory; do not run on production.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, readFileSync, statSync, writeFileSync, chmodSync, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const TABLES = [
  "entities", "relations", "tombstones", "note_revisions", "context_subjects",
  "context_claims", "context_evidence", "context_sources", "context_review_events",
  "work_sessions", "work_session_intervals", "work_session_events",
  "mail_accounts", "mail_sync_accounts", "mail_sync_messages", "calendar_sources",
  "calendar_accounts", "passkey_credentials", "push_subscriptions",
  "schema_migrations", "metadata",
];
const ENTITY_KINDS = new Set(["workspace", "area", "project", "task", "note"]);
const MODIFIED_FIELDS = ["updated_at", "changed_at", "last_sync_at", "last_seen_at", "created_at", "recorded_at", "started_at"];
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const cleanInt = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const countRows = (db, table) => Number(db.prepare("SELECT COUNT(*) AS n FROM " + quote(table)).get().n);

function safeOutput(source, destination) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw Error("absolute paths required");
  const src = realpathSync(source);
  if (!lstatSync(src).isDirectory()) throw Error("source must be a directory");
  const parent = realpathSync(path.dirname(destination));
  const dst = path.join(parent, path.basename(destination));
  if (within(dst, src) || within(src, dst)) throw Error("source and output paths overlap");
  if (existsSync(dst) || (lstatSyncMaybe(dst) !== null)) throw Error("output must not exist");
  const configuredLive = process.env.AI_EXECUTIVE_DATA_DIR;
  for (const name of ["AI_EXECUTIVE_DATA_DIR", "AI_EXECUTIVE_TARGET_STAGING_DIRECTORY"]) {
    const liveConfigured = process.env[name];
    if (!liveConfigured || !existsSync(liveConfigured)) continue;
    const live = realpathSync(liveConfigured);
    if (within(src, live) || within(live, src) || within(dst, live) || within(live, dst))
      throw Error("configured live data overlap refused");
  }
  return { src, dst };
}
function lstatSyncMaybe(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function assertRegular(file) {
  const s = lstatSyncMaybe(file);
  if (!s || !s.isFile() || s.isSymbolicLink()) throw Error("snapshot database is missing or unsafe");
  return { size: s.size, mtimeMs: s.mtimeMs };
}
function snapshotFiles(src, dst) {
  const main = path.join(src, "store.sqlite");
  const before = new Map();
  for (const suffix of ["", "-wal"]) {
    const file = main + suffix;
    if (existsSync(file) || lstatSyncMaybe(file)) before.set(suffix, assertRegular(file));
  }
  if (!before.has("")) throw Error("offline snapshot has no store.sqlite");
  const privateDir = path.join(dst, "inspection-copy");
  mkdirSync(privateDir, { mode: 0o700 });
  for (const suffix of before.keys()) {
    const target = path.join(privateDir, "store.sqlite" + suffix);
    copyFileSync(main + suffix, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
  }
  for (const [suffix, original] of before) {
    const after = assertRegular(main + suffix);
    if (original.size !== after.size || original.mtimeMs !== after.mtimeMs)
      throw Error("offline snapshot changed while being copied");
  }
  return path.join(privateDir, "store.sqlite");
}

function readInventory(db, source, tokenAttestation) {
  const found = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (!found.has("entities")) throw Error("not a recognized legacy Lumi store");
  const integrity = db.prepare("PRAGMA integrity_check").all().every(row => Object.values(row)[0] === "ok");
  if (!integrity) throw Error("snapshot failed SQLite integrity_check");
  const tables = {};
  const timestampRanges = {};
  for (const table of TABLES) {
    if (!found.has(table)) continue;
    tables[table] = countRows(db, table);
    const cols = new Set(db.prepare("PRAGMA table_info(" + quote(table) + ")").all().map(row => row.name));
    const modified = MODIFIED_FIELDS.find(col => cols.has(col));
    if (!modified) continue;
    const range = db.prepare("SELECT MIN(" + quote(modified) + ") AS earliest, MAX(" + quote(modified) + ") AS latest FROM " + quote(table)).get();
    timestampRanges[table] = { earliest: cleanInt(range.earliest), latest: cleanInt(range.latest) };
  }

  // Workspace IDs can be emails/names. Assign anonymous local labels, never print IDs.
  const entities = db.prepare("SELECT payload FROM entities").all();
  const parsed = entities.map(row => {
    let value;
    try { value = JSON.parse(String(row.payload)); } catch { return { workspace: null, kind: "other" }; }
    const kind = ENTITY_KINDS.has(value?.type) ? value.type : "other";
    return { kind, workspace: typeof value?.workspaceId === "string" && value.workspaceId ? value.workspaceId : null };
  });
  const workspaces = [...new Set(parsed.map(v => v.workspace).filter(Boolean))].sort();
  const byKind = {}, byWorkspace = {};
  for (const e of parsed) {
    const workspaceLabel = e.workspace ? "workspace_" + (workspaces.indexOf(e.workspace) + 1) : "workspace_unknown";
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    if (!byWorkspace[workspaceLabel]) byWorkspace[workspaceLabel] = {};
    byWorkspace[workspaceLabel][e.kind] = (byWorkspace[workspaceLabel][e.kind] || 0) + 1;
  }

  // Provider fields, when present, are matched against a fixed allowlist only.
  const mail = {
    gmailPresent: false, icloudPresent: false,
    accounts: tables.mail_accounts || 0,
    syncingAccounts: tables.mail_sync_accounts || 0,
    syncedMessageRows: tables.mail_sync_messages || 0,
    // "absent" must not mean "not inspected"; status below exists only when schema supports it.
    sync: { status: "not_available", neverSynced: null, everSynced: null, pending: null,
      recoveryPending: null, lastSyncedAt: { earliest: null, latest: null } },
  };
  for (const table of ["mail_accounts", "mail_sync_accounts", "calendar_accounts", "calendar_sources"]) {
    if (!found.has(table)) continue;
    const cols = new Set(db.prepare("PRAGMA table_info(" + quote(table) + ")").all().map(row => row.name));
    if (!cols.has("provider")) continue;
    for (const row of db.prepare("SELECT DISTINCT provider FROM " + quote(table)).all()) {
      const provider = typeof row.provider === "string" ? row.provider.toLowerCase() : "";
      if (provider === "gmail" || provider === "google") mail.gmailPresent = true;
      if (provider === "icloud" || provider === "apple") mail.icloudPresent = true;
    }
  }

  if (found.has("mail_sync_accounts")) {
    const cols = new Set(db.prepare("PRAGMA table_info(mail_sync_accounts)").all().map(row => row.name));
    if (cols.has("last_synced_at")) {
      const pendingColumns = ["history_backlog_pending", "pending_event_id", "recovery_inbox_page_token", "recovery_sent_page_token"];
      const present = pendingColumns.filter(col => cols.has(col));
      const condition = present.map(col => col === "history_backlog_pending"
        ? 'COALESCE("history_backlog_pending", 0) <> 0'
        : quote(col) + ' IS NOT NULL').join(" OR ");
      const pending = condition
        ? Number(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_accounts WHERE " + condition).get().n)
        : null;
      const recoveryCondition = ["recovery_inbox_page_token", "recovery_sent_page_token"].filter(col => cols.has(col))
        .map(col => quote(col) + " IS NOT NULL").join(" OR ");
      const syncedRange = db.prepare("SELECT MIN(last_synced_at) AS earliest, MAX(last_synced_at) AS latest FROM mail_sync_accounts").get();
      mail.sync = {
        status: present.length === pendingColumns.length ? "complete" : "partial",
        neverSynced: Number(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_accounts WHERE last_synced_at IS NULL").get().n),
        everSynced: Number(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_accounts WHERE last_synced_at IS NOT NULL").get().n),
        pending,
        recoveryPending: recoveryCondition
          ? Number(db.prepare("SELECT COUNT(*) AS n FROM mail_sync_accounts WHERE " + recoveryCondition).get().n)
          : null,
        lastSyncedAt: { earliest: cleanInt(syncedRange.earliest), latest: cleanInt(syncedRange.latest) },
      };
    }
  }
  // Integration token is configured by AI_EXECUTIVE_INTEGRATION_TOKEN in the service
  // environment, which is deliberately NOT inspected by this offline database tool.
  // Do not turn "not inspected" into false: absence of a metadata row proves nothing.
  const integrationTokenPresent = tokenAttestation;
  const userVersion = cleanInt(db.prepare("PRAGMA user_version").get().user_version);
  const migrations = found.has("schema_migrations")
    ? db.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map(row => String(row.id))
    : null;
  // Cryptographic fingerprint distinguishes different migration sets with the same count.
  // Names themselves never leave this process (do not risk leaking custom ID strings).
  const migrationsSha256 = migrations === null ? null
    : createHash("sha256").update(JSON.stringify(migrations)).digest("hex");
  const backupsDir = path.join(source, "backups");
  let backupFiles = 0;
  if (lstatSyncMaybe(backupsDir)?.isDirectory() && !lstatSync(backupsDir).isSymbolicLink()) {
    for (const item of readdirSync(backupsDir, { withFileTypes: true })) {
      if (item.isFile() && !item.isSymbolicLink()) backupFiles += 1;
    }
  }
  return {
    format: "lumi-r4-content-free-inventory-v1", integrity: "ok", schema: {
      sqliteUserVersion: userVersion, migrationRows: migrations?.length ?? null,
      appliedMigrationsSha256: migrationsSha256,
      migrationIdentity: migrations === null ? "unavailable" : "fingerprinted",
    },
    entities: { count: entities.length, byKind, byWorkspace },
    tables, lastModifiedRanges: timestampRanges,
    notes: { noteEntities: byKind.note || 0, revisionRows: tables.note_revisions || 0 },
    context: { claims: tables.context_claims || 0, evidence: tables.context_evidence || 0, sources: tables.context_sources || 0 },
    work: { sessions: tables.work_sessions || 0, intervals: tables.work_session_intervals || 0 },
    connectors: mail,
    credentials: {
      passkeys: tables.passkey_credentials || 0, pushTargets: tables.push_subscriptions || 0,
      integrationTokenPresent, integrationTokenInspection: tokenAttestation === null ? "environment_not_inspected" : "operator_attested",
    },
    backups: { files: backupFiles },
  };
}

function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 2 || (args.length === 4 && args[2] === "--integration-token-present" &&
      (args[3] === "true" || args[3] === "false"))))
    throw Error("usage: inventory <offline-copy> <new-output> [--integration-token-present true|false]");
  const tokenAttestation = args.length === 4 ? args[3] === "true" : null;
  const { src, dst } = safeOutput(args[0], args[1]);
  // Only create the new output directory once all collision/alias checks have passed.
  mkdirSync(dst, { mode: 0o700 });
  const copiedFile = snapshotFiles(src, dst);
  const db = new DatabaseSync(copiedFile, { readOnly: true });
  let report;
  try { report = readInventory(db, src, tokenAttestation); } finally { db.close(); }
  const summary = [
    "R4 offline inventory (content-free; no production access)",
    "Legacy entities: " + report.entities.count,
    "Notes/revisions: " + report.notes.noteEntities + "/" + report.notes.revisionRows,
    "Context claims/evidence: " + report.context.claims + "/" + report.context.evidence,
    "Work sessions: " + report.work.sessions,
    "Gmail sync inspected: " + report.connectors.sync.status,
    "Passkeys/push targets: " + report.credentials.passkeys + "/" + report.credentials.pushTargets,
    "Backup files: " + report.backups.files,
    "SQLite integrity: " + report.integrity,
  ].join("\n") + "\n";
  writeFileSync(path.join(dst, "inventory.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(dst, "summary.txt"), summary, { flag: "wx", mode: 0o600 });
  // Never print the path: even a filename may be sensitive.
  process.stdout.write(summary);
}
try { main(); } catch (error) {
  // Do not echo OS/SQLite messages: they can contain sensitive absolute paths/SQL content.
  console.error("R4 inventory refused or failed (" + (error instanceof Error ? error.constructor.name : "error") + ")");
  process.exitCode = 1;
}
