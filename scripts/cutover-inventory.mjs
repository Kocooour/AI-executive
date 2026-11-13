#!/usr/bin/env node
// R4 / issue #408: content-free inventory of a DISPOSABLE, OFFLINE legacy data snapshot.
// Never open the original SQLite file: SQLite read-only connections may update -shm.
// Writes only to a NEW, expressly named directory; do not run on production.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync, chmodSync, constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isWithinPath as within } from "./r4-path-boundary.mjs";

const TABLES = [
  "entities", "relations", "tombstones", "note_revisions", "context_subjects",
  "context_claims", "context_evidence", "context_sources", "context_review_events",
  "work_sessions", "work_session_intervals", "work_session_events",
  "mail_accounts", "mail_sync_accounts", "mail_sync_messages", "calendar_sources",
  "calendar_accounts", "passkey_credentials", "push_subscriptions",
  "schema_migrations", "metadata",
];
const ENTITY_KINDS = new Set(["workspace", "area", "project", "task", "note"]);
// Fixed output keys: an unexpected DB status must not become a public field name.
const ICLOUD_STATUSES = new Set(["ready", "pending", "stale", "syncing", "error", "auth_failed"]);
function icloudStatusCounts(rows) {
  const counts = { ready: 0, pending: 0, stale: 0, syncing: 0, error: 0, auth_failed: 0, other: 0 };
  for (const row of rows) {
    const key = typeof row.status === "string" && ICLOUD_STATUSES.has(row.status)
      ? row.status : "other";
    counts[key] += Number(row.n);
  }
  return counts;
}
const unavailableIcloudGroup = () => ({
  schema: "not_available", total: null, byStatus: null,
  lastSuccessAt: { earliest: null, latest: null },
});
// Pinned catalog from lib/schema-migrations.ts at this PR's base SHA.
// Update this ordered, non-sensitive migration list whenever app migrations change.
// Never infer "current" from a count or PRAGMA user_version alone.
const KNOWN_LEGACY_MIGRATIONS = Object.freeze([
  "2026-10-context-claims-three-level-sensitivity",
  "2026-10-context-change-events-undo-linkage",
  "2026-10-context-sources-and-evidence-records",
  "2026-10-context-claims-legacy-synced-revision",
  "2026-10-context-search-evidence-guard-index",
  "2026-10-note-revisions",
  "2026-10-calendar-accounts-caldav",
  "2026-10-semantic-memory-outbox-v1",
  "2026-10-semantic-memory-first-restore-trigger",
  "2026-10-semantic-memory-cross-workspace-invalidation",
  "2026-10-mail-gmail-readonly-v1",
  "2026-10-mail-account-workspace-lifecycle",
  "2026-10-mail-oauth-claim-through-completion",
  "2026-10-mail-v4-optin-metadata-sync",
  "2026-10-mail-v4-partial-event-checkpoint",
  "2026-10-mail-v4-reconciliation-status",
  "2026-10-mail-v4-discovery-checkpoints",
  "2026-10-mail-v4-fixed-discovery-cutoff",
  "2026-10-project-context-from-goal"
]);
const MODIFIED_FIELDS = ["updated_at", "changed_at", "last_sync_at", "last_seen_at", "created_at", "recorded_at", "started_at"];
const quote = name => '"' + name.replaceAll('"', '""') + '"';

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
  // The app's unset AI_EXECUTIVE_DATA_DIR resolves to <cwd>/.data.
  // Protect it even when the CLI inherits no production environment variables.
  // This guard is a defense-in-depth check, not proof that any input is offline.
  const liveCandidates = [
    path.resolve(process.cwd(), ".data"),
    process.env.AI_EXECUTIVE_DATA_DIR,
    process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY,
  ];
  for (const candidate of liveCandidates) {
    if (!candidate) continue;
    if (!path.isAbsolute(candidate)) throw Error("live directory config must be absolute");
    const live = existsSync(candidate) ? realpathSync(candidate) : path.resolve(candidate);
    if (within(src, live) || within(live, src) || within(dst, live) || within(live, dst))
      throw Error("known live data overlap refused");
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
  // Do not materialize entire private JSON payloads in process memory.
  // Multiple SQLite read-only cursor passes use the same copied database snapshot.
  const MAX_ENTITY_ROWS = 200_000, MAX_ENTITY_BYTES = 16 * 1024 * 1024;
  const stmt = db.prepare("SELECT payload FROM entities");
  let entityCount = 0;
  const workspaceSet = new Set();
  function parseEntity(payload) {
    if (Buffer.byteLength(String(payload)) > MAX_ENTITY_BYTES) throw Error("oversized entity payload");
    let value;
    try { value = JSON.parse(String(payload)); } catch { return { workspace: null, kind: "other" }; }
    return {
      kind: ENTITY_KINDS.has(value?.type) ? value.type : "other",
      workspace: typeof value?.workspaceId === "string" && value.workspaceId ? value.workspaceId : null,
    };
  }
  for (const row of stmt.iterate()) {
    if (++entityCount > MAX_ENTITY_ROWS) throw Error("entity count exceeds safe inventory cap");
    const parsed = parseEntity(row.payload);
    if (parsed.workspace) workspaceSet.add(parsed.workspace);
  }
  const workspaceNames = [...workspaceSet].sort();
  const aliases = new Map(workspaceNames.map((id, i) => [id, "workspace_" + (i + 1)]));
  const byKind = {}, byWorkspace = {};
  for (const row of stmt.iterate()) {
    const e = parseEntity(row.payload);
    const workspaceLabel = aliases.get(e.workspace) || "workspace_unknown";
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
    icloudSync: { accounts: unavailableIcloudGroup(), calendars: unavailableIcloudGroup() },
    // "absent" must not mean "not inspected"; status only describes the
    // account checkpoint schema, not whether Gmail is fully synchronized.
    sync: { status: "not_available", neverSynced: null, everSynced: null, pending: null,
      recoveryPending: null, reconciliationPending: null,
      lastSyncedAt: { earliest: null, latest: null } },
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

  // iCloud's stored account and CalDAV source states are separate from Gmail.
  // Status strings and account/source identities are private input data: report
  // ONLY allowlisted status counters and clean integer timestamp ranges.
  // A missing table/column means not_available, not an empty or healthy state.
  const accountRequired = ["provider", "status", "last_success_at"];
  const sourceRequired = ["provider", "account_id", "status", "last_success_at"];
  const accountCols = found.has("calendar_accounts")
    ? new Set(db.prepare("PRAGMA table_info(calendar_accounts)").all().map(row => row.name))
    : new Set();
  const sourceCols = found.has("calendar_sources")
    ? new Set(db.prepare("PRAGMA table_info(calendar_sources)").all().map(row => row.name))
    : new Set();
  const accountSchemaReady = accountRequired.every(col => accountCols.has(col));
  if (accountSchemaReady) {
    const counts = icloudStatusCounts(db.prepare(
      "SELECT status, COUNT(*) AS n FROM calendar_accounts WHERE provider='icloud' GROUP BY status"
    ).all());
    const ranges = db.prepare(
      "SELECT MIN(last_success_at) AS earliest, MAX(last_success_at) AS latest " +
      "FROM calendar_accounts WHERE provider='icloud'"
    ).get();
    mail.icloudSync.accounts = {
      schema: "available", total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      byStatus: counts,
      lastSuccessAt: { earliest: cleanInt(ranges.earliest), latest: cleanInt(ranges.latest) },
    };
  }
  // Only linked CalDAV sources belonging to real iCloud account rows count.
  // Do not mix generic ICS sources or unlinked calendar rows into iCloud health.
  if (accountSchemaReady && sourceRequired.every(col => sourceCols.has(col))) {
    const linked = "FROM calendar_sources s INNER JOIN calendar_accounts a " +
      "ON s.account_id=a.id WHERE a.provider='icloud' AND s.provider='caldav'";
    const accountIdsAvailable = accountCols.has("id");
    if (accountIdsAvailable) {
      const counts = icloudStatusCounts(db.prepare(
        "SELECT s.status AS status, COUNT(*) AS n " + linked + " GROUP BY s.status"
      ).all());
      const ranges = db.prepare(
        "SELECT MIN(s.last_success_at) AS earliest, MAX(s.last_success_at) AS latest " + linked
      ).get();
      mail.icloudSync.calendars = {
        schema: "available", total: Object.values(counts).reduce((sum, n) => sum + n, 0),
        byStatus: counts,
        lastSuccessAt: { earliest: cleanInt(ranges.earliest), latest: cleanInt(ranges.latest) },
      };
    }
  }

  // Gmail reconciliation is stored in *message* rows, independently of the
  // history and discovery checkpoints in mail_sync_accounts. A cleared cursor
  // must never imply that stale indexed messages have been reconciled.
  // "null" means an older/unavailable schema; zero means explicitly inspected.
  let reconciliationPending = null;
  if (found.has("mail_sync_messages")) {
    const messageCols = new Set(db.prepare("PRAGMA table_info(mail_sync_messages)").all().map(row => row.name));
    if (messageCols.has("needs_reconcile")) {
      reconciliationPending = Number(db.prepare(
        "SELECT COUNT(*) AS n FROM mail_sync_messages WHERE needs_reconcile=1"
      ).get().n);
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
        reconciliationPending,
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
  // Actual app migrations are named and applied in registration order.
  // A strict prefix is a recognized older release; unknown IDs or gaps remain
  // UNKNOWN, even if the total count happens to match a known version.
  const expected = migrations === null ? null
    : KNOWN_LEGACY_MIGRATIONS.slice(0, migrations.length).sort();
  const recognized = migrations !== null && migrations.length <= KNOWN_LEGACY_MIGRATIONS.length
    && migrations.every((id, i) => id === expected[i]);
  const migrationIdentity = migrations === null ? "unavailable"
    : !recognized ? "unknown"
    : migrations.length === KNOWN_LEGACY_MIGRATIONS.length ? "known_current" : "known_older";
  const knownSchemaVersion = recognized ? "legacy-migrations-" + migrations.length : null;
  const backupsDir = path.join(source, "backups");
  let backupFiles = 0;
  const backupEntry = lstatSyncMaybe(backupsDir);
  if (backupEntry?.isSymbolicLink()) throw Error("unsafe symlink to backups");
  if (backupEntry?.isDirectory()) {
    for (const item of readdirSync(backupsDir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw Error("unsafe backup symlink");
      if (item.isFile()) backupFiles += 1;
      // Nested backup trees are inventoried by the full-directory rehearsal.
    }
  }
  return {
    format: "lumi-r4-content-free-inventory-v1", integrity: "ok", schema: {
      sqliteUserVersion: userVersion, migrationRows: migrations?.length ?? null,
      appliedMigrationsSha256: migrationsSha256,
      migrationIdentity, knownSchemaVersion,
      expectedMigrationCount: KNOWN_LEGACY_MIGRATIONS.length,
    },
    entities: { count: entityCount, byKind, byWorkspace },
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
  // An explicit human/operator assertion is required, but cannot itself prove
  // a coherent or detached offline capture.
  if (args.pop() !== "--offline-confirmed") throw Error("offline source confirmation required");
  if (!(args.length === 2 || (args.length === 4 && args[2] === "--integration-token-present" &&
      (args[3] === "true" || args[3] === "false"))))
    throw Error("usage: inventory <offline-copy> <new-output> [--integration-token-present true|false] --offline-confirmed");
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
    "iCloud account states inspected: " + report.connectors.icloudSync.accounts.schema,
    "iCloud CalDAV states inspected: " + report.connectors.icloudSync.calendars.schema,
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
