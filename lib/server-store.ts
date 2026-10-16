import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { repairContextEventOrder, repairLegacySourceRecords, runSchemaMigrations, schemaMigrations } from "./schema-migrations";
import {
  backupFormatVersion, describeFile, prepareRestoreCopy, publish as publishFile, removeIfExists,
  replaceTablesFromAttached, writeCleanCopy, type BackupMeta,
} from "./backup-engine";
import { HttpInputError } from "./http-security";
import { excludedClearedTables, replacedTables } from "./backup-scope";
import type { Entity, Relation } from "./db";
import { resolveDataDirectory } from "./data-dir";
import { baselineNoteRevisions, recordNoteRevisions } from "./note-revisions";

export interface StoreSnapshot {
  revision: number;
  // Counts restores and imports of this server's data (metadata, never in a backup). A client's save carries the value it
  // knows; after a restore a save from before it is refused instead of merged back into the restored data.
  restoreGeneration?: number;
  entities: Entity[];
  relations: Relation[];
  tombstones: Array<{ id: string; deletedAt: number }>;
  updatedAt: number;
}

export interface BackupSummary {
  name: string;
  // "full": a database copy (format 2, everything in scope); "legacy": a JSON file of records and links only.
  format: "full" | "legacy";
  label: string;
  createdAt: number;
  entityCount: number;
  relationCount: number;
  claimCount: number;
  sourceCount: number;
  noteRevisionCount: number;
  workSessionCount: number;
  error?: string;
}

const dataDirectory = resolveDataDirectory();
const backupDirectory = path.join(dataDirectory, "backups");
const databasePath = path.join(dataDirectory, "store.sqlite");
const legacyStorePath = path.join(dataDirectory, "store.json");
let databaseInstance: DatabaseSync | null = null;

// Work that needs the Context modules (which themselves read through getDatabase) and so cannot be imported here: a module
// registers it, and it runs once the database is initialised (at once if that already happened).
const readyHooks: Array<() => void> = [];
function runHook(hook: () => void) {
  try { hook(); } catch (error) { console.error("Database start-up repair failed:", error instanceof Error ? error.message : error); }
}
function runReadyHooks() { for (const hook of readyHooks) runHook(hook); }
export function onDatabaseReady(hook: () => void) {
  readyHooks.push(hook);
  if (databaseInstance) runHook(hook);
}

export function getDatabase() {
  if (databaseInstance) return databaseInstance;
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const database = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  // Set before the setup below, because the legacy migration reads through getDatabase(). The setup is
  // synchronous, so no other caller can see the connection half-initialised; if it fails, the connection
  // is closed and forgotten, so the next call starts again and retries the migrations.
  databaseInstance = database;
  try {
    initialiseDatabase(database);
    removeLeftoverTemporaryFiles();
    repairBackupsDirectory();
    runReadyHooks();
  } catch (error) {
    databaseInstance = null;
    try { database.close(); } catch { /* the original error matters */ }
    throw error;
  }
  return database;
}

function initialiseDatabase(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
  for (const sqliteCompanion of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(sqliteCompanion)) chmodSync(sqliteCompanion, 0o600);
  }
  applySchema(database);
  migrateLegacyStore(database);
  ensureDefaultWorkspace(database);
}

// Tables, additive column changes, the named migrations and the start-up repairs. It runs on the live database and
// on the copy of a backup that is being restored (so an older backup is brought to the current schema through the
// same migrations); nothing here may depend on the live database or on its files.
export function applySchema(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attention_states (
      workspace_id TEXT NOT NULL,
      attention_key TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      state TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      snooze_until INTEGER,
      changed_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, attention_key)
    );
    CREATE TABLE IF NOT EXISTS attention_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      attention_key TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attention_history_key_idx
      ON attention_history(workspace_id, attention_key, changed_at);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      delivery_key TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      reminder_at TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER NOT NULL,
      sent_at INTEGER,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS calendar_sources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      encrypted_url TEXT NOT NULL,
      status TEXT NOT NULL,
      last_sync_at INTEGER,
      last_success_at INTEGER,
      last_error TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_id, occurrence_key)
    );
    CREATE INDEX IF NOT EXISTS calendar_events_range_idx
      ON calendar_events(workspace_id, start_at, end_at);
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      actor_hash TEXT NOT NULL,
      details TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS security_events_created_idx
      ON security_events(created_at);
    CREATE INDEX IF NOT EXISTS security_events_action_outcome_idx
      ON security_events(action, outcome, created_at);
    CREATE TABLE IF NOT EXISTS security_alerts (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      severity TEXT NOT NULL,
      rule TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      actor_hash TEXT NOT NULL,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      event_count INTEGER NOT NULL,
      hermes_enqueued_at INTEGER,
      push_sent_at INTEGER,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS security_alerts_created_idx
      ON security_alerts(first_at);
    CREATE TABLE IF NOT EXISTS pact_agents (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      version INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pact_context (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      provenance TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pact_context_scope_idx
      ON pact_context(workspace_id, scope, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS context_subjects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      canonical_entity_id TEXT,
      display_title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id, canonical_entity_id)
    );
    CREATE INDEX IF NOT EXISTS context_subjects_workspace_idx
      ON context_subjects(workspace_id, subject_type, updated_at DESC);
    CREATE TABLE IF NOT EXISTS context_claims (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      literal_type TEXT,
      literal_value TEXT,
      target_subject_id TEXT,
      review_status TEXT NOT NULL,
      freshness TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      provenance TEXT NOT NULL,
      valid_from TEXT,
      valid_to TEXT,
      source_metadata TEXT,
      evidence_metadata TEXT,
      revision INTEGER NOT NULL,
      archived_at INTEGER,
      recorded_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS context_claims_workspace_idx
      ON context_claims(workspace_id, review_status, freshness, archived_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS context_claims_subject_idx
      ON context_claims(subject_id, archived_at, updated_at DESC);
    CREATE TABLE IF NOT EXISTS context_review_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      claim_revision INTEGER NOT NULL,
      actor TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS context_review_events_claim_idx
      ON context_review_events(workspace_id, claim_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS context_change_events (
      id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      object_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      before_revision INTEGER,
      after_revision INTEGER,
      before_payload TEXT,
      after_payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS context_change_events_object_idx
      ON context_change_events(workspace_id, object_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS context_change_events_command_idx
      ON context_change_events(workspace_id, command_id);
    CREATE TABLE IF NOT EXISTS context_commands (
      workspace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS work_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','paused','completed')),
      revision INTEGER NOT NULL,
      accumulated_ms INTEGER NOT NULL DEFAULT 0,
      running_since INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      estimated_minutes INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_sessions_one_active_idx
      ON work_sessions(workspace_id) WHERE state IN ('running','paused');
    CREATE INDEX IF NOT EXISTS work_sessions_workspace_history_idx
      ON work_sessions(workspace_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS work_session_intervals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_session_one_open_interval_idx
      ON work_session_intervals(session_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS work_session_commands (
      workspace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS work_session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_session_events_history_idx
      ON work_session_events(workspace_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS pact_tool_permissions (
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      permission TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      PRIMARY KEY(agent_id, tool_name, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS pact_agent_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      trigger_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      input_summary TEXT NOT NULL,
      output_summary TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS pact_agent_runs_created_idx
      ON pact_agent_runs(agent_id, workspace_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ai_proposals (
      id TEXT PRIMARY KEY,
      session_binding TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_action_history (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE,
      session_binding TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_payload TEXT,
      after_payload TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ai_proposals_expiry_idx
      ON ai_proposals(expires_at);
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      credential_id TEXT PRIMARY KEY,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT NOT NULL,
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL,
      rp_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS passkey_challenges (
      challenge TEXT PRIMARY KEY,
      ceremony TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      binding TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  migrateContextChangeEventScope(database);
  const subjectColumns = database.prepare("PRAGMA table_info(context_subjects)").all()
    .map((row) => String((row as { name?: string }).name));
  if (!subjectColumns.includes("archived_at")) {
    database.exec("ALTER TABLE context_subjects ADD COLUMN archived_at INTEGER");
  }
  const workSessionColumns = database.prepare("PRAGMA table_info(work_sessions)").all()
    .map((row) => String((row as { name?: string }).name));
  if (!workSessionColumns.includes("estimated_minutes")) {
    database.exec("ALTER TABLE work_sessions ADD COLUMN estimated_minutes INTEGER");
  }
  const challengeColumns = database
    .prepare("PRAGMA table_info(passkey_challenges)")
    .all()
    .map((row) => String((row as { name?: string }).name));
  if (!challengeColumns.includes("binding")) {
    database.exec(
      "ALTER TABLE passkey_challenges ADD COLUMN binding TEXT NOT NULL DEFAULT ''",
    );
  }
  runSchemaMigrations(database);
  repairContextEventOrder(database);
  repairLegacySourceRecords(database);
}

function migrateContextChangeEventScope(database: DatabaseSync) {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='context_change_events'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || !/command_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE context_change_events RENAME TO context_change_events_legacy;
      CREATE TABLE context_change_events (
        id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        object_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        before_revision INTEGER,
        after_revision INTEGER,
        before_payload TEXT,
        after_payload TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO context_change_events
        SELECT id, command_id, workspace_id, actor, object_id, operation, before_revision,
          after_revision, before_payload, after_payload, created_at
        FROM context_change_events_legacy;
      DROP TABLE context_change_events_legacy;
      CREATE INDEX context_change_events_object_idx
        ON context_change_events(workspace_id, object_id, created_at DESC);
      CREATE UNIQUE INDEX context_change_events_command_idx
        ON context_change_events(workspace_id, command_id);
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export interface StoredPasskeyCredential {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  rpId: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const passkeyFromRow = (row: Record<string, unknown>): StoredPasskeyCredential => ({
  id: String(row.credential_id),
  publicKey: new Uint8Array(row.public_key as Uint8Array),
  counter: Number(row.counter),
  transports: JSON.parse(String(row.transports || "[]")),
  deviceType: String(row.device_type),
  backedUp: Boolean(row.backed_up),
  rpId: String(row.rp_id),
  label: String(row.label),
  createdAt: Number(row.created_at),
  lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
});

export function listPasskeys(rpId?: string) {
  const database = getDatabase();
  const rows = rpId
    ? database
        .prepare("SELECT * FROM passkey_credentials WHERE rp_id = ? ORDER BY created_at")
        .all(rpId)
    : database.prepare("SELECT * FROM passkey_credentials ORDER BY created_at").all();
  return rows.map((row) => passkeyFromRow(row as Record<string, unknown>));
}

export function getPasskey(id: string, rpId: string) {
  const row = getDatabase()
    .prepare("SELECT * FROM passkey_credentials WHERE credential_id = ? AND rp_id = ?")
    .get(id, rpId) as Record<string, unknown> | undefined;
  return row ? passkeyFromRow(row) : null;
}

export function savePasskey(credential: StoredPasskeyCredential) {
  getDatabase()
    .prepare(`
      INSERT INTO passkey_credentials (
        credential_id, public_key, counter, transports, device_type, backed_up,
        rp_id, label, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO NOTHING
    `)
    .run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports),
      credential.deviceType,
      credential.backedUp ? 1 : 0,
      credential.rpId,
      credential.label,
      credential.createdAt,
      credential.lastUsedAt,
    );
}

export function updatePasskeyUse(
  id: string,
  counter: number,
  backedUp: boolean,
) {
  getDatabase()
    .prepare(`
      UPDATE passkey_credentials
      SET counter = ?, backed_up = ?, last_used_at = ?
      WHERE credential_id = ?
    `)
    .run(counter, backedUp ? 1 : 0, Date.now(), id);
}

export function deletePasskey(id: string) {
  return Number(
    getDatabase()
      .prepare("DELETE FROM passkey_credentials WHERE credential_id = ?")
      .run(id).changes,
  );
}

export function savePasskeyChallenge(
  challenge: string,
  ceremony: "registration" | "authentication",
  rpId: string,
  origin: string,
  binding: string,
  expiresAt: number,
) {
  const database = getDatabase();
  database.prepare("DELETE FROM passkey_challenges WHERE expires_at <= ?").run(Date.now());
  database
    .prepare(`
      INSERT INTO passkey_challenges (challenge, ceremony, rp_id, origin, binding, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(challenge, ceremony, rpId, origin, binding, expiresAt);
}

export function consumePasskeyChallenge(
  challenge: string,
  ceremony: "registration" | "authentication",
  rpId: string,
  origin: string,
  binding: string,
) {
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database
      .prepare(`
        SELECT challenge FROM passkey_challenges
        WHERE challenge = ? AND ceremony = ? AND rp_id = ? AND origin = ?
          AND binding = ? AND expires_at > ?
      `)
      .get(challenge, ceremony, rpId, origin, binding, Date.now());
    database.prepare("DELETE FROM passkey_challenges WHERE challenge = ?").run(challenge);
    database.exec("COMMIT");
    return Boolean(row);
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function defaultWorkspaceEntity(now = Date.now()): Entity {
  return {
    id: "workspace:personal",
    type: "workspace",
    title: "Personal",
    status: "active",
    workspaceId: "personal",
    properties: {
      kind: "personal",
      role: "owner",
      members: [{ id: "owner", role: "owner" }],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function ensureDefaultWorkspace(database: DatabaseSync) {
  const exists = database
    .prepare("SELECT 1 FROM entities WHERE id = ?")
    .get("workspace:personal");
  if (exists) return;
  const now = Date.now();
  const workspace = defaultWorkspaceEntity(now);
  database
    .prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)")
    .run(workspace.id, JSON.stringify(workspace), now);
  const revision = Number(readMetadata(database, "revision")) + 1;
  const setMetadata = database.prepare(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  setMetadata.run("revision", String(revision));
  setMetadata.run("updatedAt", String(now));
}

const readMetadata = (database: DatabaseSync, key: string, fallback = "0") =>
  String(
    (
      database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
        | { value?: string }
        | undefined
    )?.value ?? fallback,
  );

function readRestoreGeneration(database: DatabaseSync) {
  return Number(readMetadata(database, "restoreGeneration", "0")) || 0;
}
// Inside the transaction of every restore and import.
function bumpRestoreGeneration(database: DatabaseSync) {
  database.prepare(`INSERT INTO metadata (key, value) VALUES ('restoreGeneration', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(readRestoreGeneration(database) + 1));
}

export function readSnapshot(): StoreSnapshot {
  const database = getDatabase();
  const entities = database
    .prepare("SELECT payload FROM entities ORDER BY updated_at, id")
    .all()
    .map((row) => JSON.parse(String((row as { payload: string }).payload)));
  const relations = database
    .prepare("SELECT payload FROM relations ORDER BY created_at, id")
    .all()
    .map((row) => JSON.parse(String((row as { payload: string }).payload)));
  const tombstones = database
    .prepare("SELECT id, deleted_at FROM tombstones ORDER BY deleted_at, id")
    .all()
    .map((row) => ({
      id: String((row as { id: string }).id),
      deletedAt: Number((row as { deleted_at: number }).deleted_at),
    }));
  return {
    revision: Number(readMetadata(database, "revision")),
    restoreGeneration: readRestoreGeneration(database),
    entities,
    relations,
    tombstones,
    updatedAt: Number(readMetadata(database, "updatedAt")),
  };
}

function replaceUnchecked(database: DatabaseSync, snapshot: StoreSnapshot) {
  const setMetadata = database.prepare(`
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const insertEntity = database.prepare(
    "INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)",
  );
  const insertRelation = database.prepare(
    "INSERT INTO relations (id, payload, created_at) VALUES (?, ?, ?)",
  );
  const insertTombstone = database.prepare(
    "INSERT INTO tombstones (id, deleted_at) VALUES (?, ?)",
  );
  database.exec("DELETE FROM relations; DELETE FROM entities; DELETE FROM tombstones;");
  for (const entity of snapshot.entities) {
    insertEntity.run(entity.id, JSON.stringify(entity), entity.updatedAt || 0);
  }
  for (const relation of snapshot.relations) {
    insertRelation.run(
      relation.id,
      JSON.stringify(relation),
      relation.createdAt || 0,
    );
  }
  for (const tombstone of snapshot.tombstones || []) {
    insertTombstone.run(tombstone.id, tombstone.deletedAt);
  }
  setMetadata.run("revision", String(snapshot.revision));
  setMetadata.run("updatedAt", String(snapshot.updatedAt));
}

// More than five records and more than a quarter of them gone without being named as deleted is
// not something the app does on purpose: every deletion it makes is announced. The same holds for
// links between records (task in a project, project in an area): the app removes them one at a
// time, or together with an announced record. Links whose two records both stay count here.
function dropsLarge(existing: number, dropped: number) {
  return dropped > 5 && dropped > existing / 4;
}

export function dropsTooMuch(current: StoreSnapshot, entities: Entity[], deletedIds: string[], relations: Relation[] = []) {
  const kept = new Set(entities.map((entity) => entity.id));
  const announced = new Set(deletedIds);
  const existing = current.entities.filter((entity) => entity.type !== "workspace");
  const droppedEntities = existing.filter((entity) => !kept.has(entity.id) && !announced.has(entity.id)).length;
  if (existing.length > 0 && dropsLarge(existing.length, droppedEntities)) return true;
  const keptRelations = new Set(relations.map((relation) => relation.id));
  const stillLinked = current.relations.filter((relation) =>
    kept.has(relation.sourceEntityId) && kept.has(relation.targetEntityId)
    && !announced.has(relation.sourceEntityId) && !announced.has(relation.targetEntityId));
  const droppedRelations = stillLinked.filter((relation) => !keptRelations.has(relation.id)).length;
  return current.relations.length > 0 && dropsLarge(current.relations.length, droppedRelations);
}

export function replaceSnapshot(
  baseRevision: number,
  entities: Entity[],
  relations: Relation[],
  deletedIds: string[] = [],
  revivedIds: string[] = [],
  restoreGeneration?: number,
) {
  const currentBeforeWrite = readSnapshot();
  // A save made against data that has been restored since (here or on another device) is refused whole: merging it would
  // put the replaced data back. The caller answers with the current snapshot and the client adopts it.
  if ((currentBeforeWrite.restoreGeneration ?? 0) > 0 && restoreGeneration !== currentBeforeWrite.restoreGeneration) {
    return { conflict: true as const, restored: true as const, snapshot: currentBeforeWrite };
  }
  const today = new Date().toISOString().slice(0, 10);
  if (
    currentBeforeWrite.entities.length &&
    !hasDailyBackup(today)
  ) {
    createBackup("daily");
  }
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readSnapshot();
    if (baseRevision !== current.revision) {
      database.exec("ROLLBACK");
      return { conflict: true as const, snapshot: current };
    }
    // Safety net. A save at the current revision replaces everything, so a device that lost or
    // never had its local copy could erase the store with one request. Records may disappear
    // only when the device names them as deleted. A save that silently drops a large part of
    // the store is answered like a conflict instead: the client merges with the copy it gets
    // back and sends again, and nothing is lost.
    if (dropsTooMuch(current, entities, deletedIds, relations)) {
      database.exec("ROLLBACK");
      return { conflict: true as const, snapshot: current };
    }
    const tombstones = new Map(
      (current.tombstones || []).map((item) => [item.id, item]),
    );
    for (const id of revivedIds) {
      if (typeof id === "string" && id) tombstones.delete(id);
    }
    for (const id of deletedIds) {
      if (typeof id === "string" && id && !id.startsWith("workspace:")) {
        tombstones.set(id, { id, deletedAt: Date.now() });
      }
    }
    const tombstonedIds = new Set(tombstones.keys());
    const normalizedEntities = entities.some(
      (entity) => entity.id === "workspace:personal",
    )
      ? entities
      : [defaultWorkspaceEntity(), ...entities];
    const liveEntities = normalizedEntities.filter(
      (entity) => !tombstonedIds.has(entity.id),
    );
    const liveEntityIds = new Set(liveEntities.map((entity) => entity.id));
    const next: StoreSnapshot = {
      revision: current.revision + 1,
      restoreGeneration: current.restoreGeneration,
      entities: liveEntities,
      relations: relations.filter(
        (relation) =>
          liveEntityIds.has(relation.sourceEntityId) &&
          liveEntityIds.has(relation.targetEntityId),
      ),
      tombstones: [...tombstones.values()],
      updatedAt: Date.now(),
    };
    replaceUnchecked(database, next);
    recordNoteRevisions(database, current.entities, next.entities, "edited", next.revision);
    database.exec("COMMIT");
    return { conflict: false as const, snapshot: next };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function safeBackupName(name: string) {
  if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-[a-z-]+)?\.(?:json|sqlite)$/.test(name)) {
    throw new Error("Invalid backup name");
  }
  return name;
}

export function validateSnapshot(snapshot: unknown): asserts snapshot is StoreSnapshot {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Invalid snapshot");
  const value = snapshot as Partial<StoreSnapshot>;
  if (!Array.isArray(value.entities) || !Array.isArray(value.relations)) {
    throw new Error("Snapshot does not contain entity and relation arrays");
  }
  const entityIds = new Set<string>();
  const allowedEntityTypes = new Set([
    "area",
    "project",
    "task",
    "note",
    "workspace",
  ]);
  for (const entity of value.entities) {
    if (
      !entity ||
      typeof entity.id !== "string" ||
      entity.id.length === 0 ||
      entity.id.length > 240 ||
      typeof entity.type !== "string" ||
      !allowedEntityTypes.has(entity.type) ||
      typeof entity.title !== "string" ||
      entity.title.length === 0 ||
      entity.title.length > 1000 ||
      (entity.content !== undefined &&
        (typeof entity.content !== "string" || entity.content.length > 100000)) ||
      typeof entity.status !== "string" ||
      entity.status.length > 40 ||
      typeof entity.workspaceId !== "string" ||
      entity.workspaceId.length > 120 ||
      !entity.properties ||
      typeof entity.properties !== "object" ||
      Array.isArray(entity.properties) ||
      JSON.stringify(entity.properties).length > 250000 ||
      typeof entity.createdAt !== "number" ||
      !Number.isFinite(entity.createdAt) ||
      typeof entity.updatedAt !== "number" ||
      !Number.isFinite(entity.updatedAt)
    ) {
      throw new Error("Snapshot contains an invalid entity");
    }
    if (entityIds.has(entity.id)) throw new Error("Snapshot contains duplicate entity IDs");
    entityIds.add(entity.id);
  }
  const workspaceIds = new Set(
    value.entities
      .filter((entity) => entity.type === "workspace")
      .map((entity) => entity.workspaceId),
  );
  const workspaceEntities = value.entities.filter(
    (entity) => entity.type === "workspace",
  );
  if (
    new Set(workspaceEntities.map((entity) => entity.workspaceId)).size !==
    workspaceEntities.length
  ) {
    throw new Error("Snapshot contains duplicate workspace IDs");
  }
  for (const workspace of workspaceEntities) {
    if (
      workspace.id !== `workspace:${workspace.workspaceId}` ||
      workspace.title.trim().length === 0 ||
      workspace.title.length > 120 ||
      !["personal", "shared"].includes(String(workspace.properties.kind)) ||
      workspace.properties.role !== "owner" ||
      !Array.isArray(workspace.properties.members)
    ) {
      throw new Error("Snapshot contains an invalid workspace");
    }
  }
  workspaceIds.add("personal");
  if (
    value.entities.some(
      (entity) =>
        entity.type !== "workspace" && !workspaceIds.has(entity.workspaceId),
    )
  ) {
    throw new Error("Snapshot contains an entity in an unknown workspace");
  }
  const entitiesById = new Map(
    value.entities.map((entity) => [entity.id, entity]),
  );
  const relationIds = new Set<string>();
  for (const relation of value.relations) {
    if (
      !relation ||
      typeof relation.id !== "string" ||
      relation.id.length === 0 ||
      relation.id.length > 240 ||
      typeof relation.sourceEntityId !== "string" ||
      relation.sourceEntityId.length > 240 ||
      typeof relation.targetEntityId !== "string" ||
      relation.targetEntityId.length > 240 ||
      typeof relation.relationType !== "string" ||
      relation.relationType.length === 0 ||
      relation.relationType.length > 120 ||
      typeof relation.workspaceId !== "string" ||
      relation.workspaceId.length > 120 ||
      typeof relation.createdAt !== "number" ||
      !Number.isFinite(relation.createdAt)
    ) {
      throw new Error("Snapshot contains an invalid relation");
    }
    if (relationIds.has(relation.id)) throw new Error("Snapshot contains duplicate relation IDs");
    if (
      !entityIds.has(relation.sourceEntityId) ||
      !entityIds.has(relation.targetEntityId)
    ) {
      throw new Error("Snapshot contains a relation to a missing entity");
    }
    const source = entitiesById.get(relation.sourceEntityId);
    const target = entitiesById.get(relation.targetEntityId);
    if (
      !source ||
      !target ||
      source.workspaceId !== target.workspaceId ||
      relation.workspaceId !== source.workspaceId
    ) {
      throw new Error("Snapshot contains a cross-workspace relation");
    }
    relationIds.add(relation.id);
  }
  if (value.tombstones !== undefined) {
    if (!Array.isArray(value.tombstones)) throw new Error("Snapshot tombstones are invalid");
    for (const tombstone of value.tombstones) {
      if (
        !tombstone ||
        typeof tombstone.id !== "string" ||
        tombstone.id.length === 0 ||
        tombstone.id.length > 240 ||
        typeof tombstone.deletedAt !== "number" ||
        !Number.isFinite(tombstone.deletedAt)
      ) {
        throw new Error("Snapshot contains an invalid tombstone");
      }
    }
  }
}

const backupExtensions = [".sqlite", ".json"] as const;
const backupStem = (name: string) => name.replace(/\.(sqlite|json)$/, "");
const sidecarName = (name: string) => `${backupStem(name)}.meta.json`;
const isBackupFile = (entry: string) => /^\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-[a-z-]+)?\.(sqlite|json)$/.test(entry);

function backupLabel(name: string) {
  const match = /^\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-([a-z-]+))?$/.exec(backupStem(name));
  return match?.[1] || "manual";
}

function legacySummary(name: string, snapshot: StoreSnapshot): BackupSummary {
  return {
    name,
    format: "legacy",
    label: backupLabel(name),
    createdAt: statSync(path.join(backupDirectory, name)).mtimeMs,
    entityCount: snapshot.entities.length,
    relationCount: snapshot.relations.length,
    claimCount: 0,
    sourceCount: 0,
    noteRevisionCount: 0,
    workSessionCount: 0,
  };
}

function fullSummary(name: string, meta: BackupMeta): BackupSummary {
  return {
    name,
    format: "full",
    label: backupLabel(name),
    createdAt: Date.parse(meta.createdAt) || statSync(path.join(backupDirectory, name)).mtimeMs,
    entityCount: meta.counts.entities ?? 0,
    relationCount: meta.counts.relations ?? 0,
    claimCount: meta.counts.context_claims ?? 0,
    sourceCount: meta.counts.context_sources ?? 0,
    noteRevisionCount: meta.counts.note_revisions ?? 0,
    workSessionCount: meta.counts.work_sessions ?? 0,
  };
}

function readSidecar(name: string): BackupMeta {
  let meta: BackupMeta;
  try {
    meta = JSON.parse(readFileSync(path.join(backupDirectory, sidecarName(name)), "utf8")) as BackupMeta;
  } catch {
    throw new HttpInputError("Invalid backup");
  }
  if (
    !meta || meta.format !== "lumi-backup" || meta.version !== backupFormatVersion ||
    typeof meta.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.sha256) ||
    !Number.isFinite(meta.bytes) || !Array.isArray(meta.migrations) || !meta.counts || typeof meta.counts !== "object"
  ) {
    throw new HttpInputError("Invalid backup");
  }
  return meta;
}

function backupRetentionClass(entry: string) {
  const stem = backupStem(entry);
  if (stem.endsWith("-daily")) return "daily";
  if (stem.endsWith("-manual")) return "manual";
  if (stem.endsWith("-before-restore") || stem.endsWith("-json-migration") || stem.endsWith("-pre-sqlite")) return "safety";
  return "other";
}

/** Writes a full backup (format 2): a consistent, cleaned SQLite copy plus its sidecar. */
export function createBackup(label = "manual") {
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  const database = getDatabase();
  const safeLabel = label.replace(/[^a-z-]/gi, "").toLowerCase() || "manual";
  // Two backups in the same millisecond must not collide: the later one is stamped a millisecond on.
  let createdAt = new Date();
  let stem = "";
  for (;;) {
    stem = `${createdAt.toISOString().replace(/[:.]/g, "-")}-${safeLabel}`;
    if (!backupExtensions.some((extension) => existsSync(path.join(backupDirectory, `${stem}${extension}`)))) break;
    createdAt = new Date(createdAt.getTime() + 1);
  }
  const name = `${stem}.sqlite`;
  const final = path.join(backupDirectory, name);
  const sidecar = path.join(backupDirectory, sidecarName(name));
  const sidecarPartial = path.join(backupDirectory, `.${sidecarName(name)}.tmp`);
  // The copy is made in the temporary folder, where start-up cleanup removes it if the process dies before it is
  // cleaned (right after VACUUM INTO it still holds passkeys, push endpoints, security logs and secrets), and only the
  // cleaned, vacuumed file is moved into the backups folder.
  const staging = temporaryFile("backup", ".sqlite");
  let meta: BackupMeta;
  try {
    const { counts, migrations } = writeCleanCopy(database, staging, crashAfterVacuumForTests ?? undefined);
    const { bytes, sha256 } = describeFile(staging);
    meta = { format: "lumi-backup", version: backupFormatVersion, createdAt: createdAt.toISOString(), label: safeLabel, migrations, counts, bytes, sha256 };
    // The sidecar is in place before the database file, so a published .sqlite always has its sidecar.
    writeFileSync(sidecarPartial, JSON.stringify(meta, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(sidecarPartial, sidecar);
    publishFile(staging, final);
  } catch (error) {
    removeIfExists(final);
    removeIfExists(sidecar);
    removeIfExists(sidecarPartial);
    throw error;
  } finally {
    releaseTemporaryFile(staging);
  }
  try {
    const backups = readdirSync(backupDirectory)
      .filter(isBackupFile)
      .map((entry) => {
        const backupPath = path.join(backupDirectory, entry);
        chmodSync(backupPath, 0o600);
        return { entry, modifiedAt: statSync(backupPath).mtimeMs };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt || (a.entry < b.entry ? 1 : -1));
    const limits: Record<string, number> = { daily: 30, manual: 20, safety: 20, other: 10 };
    const seen: Record<string, number> = { daily: 0, manual: 0, safety: 0, other: 0 };
    const expired = backups.filter(({ entry }) => {
      const category = backupRetentionClass(entry);
      seen[category] += 1;
      return seen[category] > limits[category];
    });
    for (const backup of expired) {
      unlinkSync(path.join(backupDirectory, backup.entry));
      if (backup.entry.endsWith(".sqlite")) removeIfExists(path.join(backupDirectory, sidecarName(backup.entry)));
    }
  } catch (error) {
    console.error("Backup retention cleanup failed", error);
  }
  return fullSummary(name, meta);
}

export function hasDailyBackup(day: string) {
  if (!existsSync(backupDirectory)) return false;
  return readdirSync(backupDirectory).some((entry) => {
    if (!entry.startsWith(day) || !isBackupFile(entry) || !backupStem(entry).endsWith("-daily")) return false;
    if (entry.endsWith(".json")) return true;
    // A database backup counts only with its sidecar and a file of the size the sidecar states.
    try {
      return statSync(path.join(backupDirectory, entry)).size === readSidecar(entry).bytes;
    } catch {
      return false;
    }
  });
}

/**
 * At start: staging files of older builds and sidecars without a database file go; a database file without a readable
 * sidecar (a crash between the two renames of an older build) is renamed to `<name>.incomplete`, which is neither listed
 * nor counted nor deleted, so nothing of the owner's is removed silently.
 */
export function repairBackupsDirectory() {
  try {
    if (!existsSync(backupDirectory)) return;
    const entries = readdirSync(backupDirectory);
    for (const entry of entries) {
      const file = path.join(backupDirectory, entry);
      if (entry.startsWith(".") && entry.endsWith(".tmp")) removeIfExists(file);
      else if (entry.endsWith(".meta.json") && !entries.includes(entry.replace(/\.meta\.json$/, ".sqlite"))) removeIfExists(file);
      else if (isBackupFile(entry) && entry.endsWith(".sqlite")) {
        let usable = true;
        try { readSidecar(entry); } catch { usable = false; }
        if (!usable) {
          renameSync(file, `${file}.incomplete`);
          removeIfExists(path.join(backupDirectory, sidecarName(entry))); // a damaged sidecar describes nothing
        }
      }
    }
  } catch (error) {
    console.error("Repairing the backups folder failed:", error instanceof Error ? error.message : error);
  }
}

export function listBackups(): BackupSummary[] {
  if (!existsSync(backupDirectory)) return [];
  return readdirSync(backupDirectory)
    .filter(isBackupFile)
    .map((name): BackupSummary => {
      const modifiedAt = statSync(path.join(backupDirectory, name)).mtimeMs;
      const failed = (error: unknown): BackupSummary => ({
        name,
        format: name.endsWith(".sqlite") ? "full" : "legacy",
        label: backupLabel(name),
        createdAt: modifiedAt,
        entityCount: 0, relationCount: 0, claimCount: 0, sourceCount: 0, noteRevisionCount: 0, workSessionCount: 0,
        // Only messages written for the owner are shown; a validation detail of a damaged file is not.
        error: error instanceof HttpInputError ? error.message : "Invalid backup",
      });
      try {
        if (name.endsWith(".sqlite")) {
          const meta = readSidecar(name);
          if (statSync(path.join(backupDirectory, name)).size !== meta.bytes) throw new HttpInputError("Invalid backup");
          return fullSummary(name, meta);
        }
        const snapshot = JSON.parse(readFileSync(path.join(backupDirectory, name), "utf8")) as StoreSnapshot;
        validateSnapshot(snapshot);
        return legacySummary(name, snapshot);
      } catch (error) {
        return failed(error);
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function restoreLegacyBackup(name: string) {
  let restored: StoreSnapshot;
  try {
    restored = JSON.parse(readFileSync(path.join(backupDirectory, name), "utf8")) as StoreSnapshot;
    validateSnapshot(restored);
  } catch {
    throw new HttpInputError("Invalid backup");
  }
  createBackup("before-restore");
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readSnapshot();
    const next = nextSnapshotAfterRestore(current, restored);
    replaceUnchecked(database, next);
    recordNoteRevisions(database, current.entities, next.entities, "backup_restore", next.revision);
    bumpRestoreGeneration(database);
    database.exec("COMMIT");
    return { ...next, restoreGeneration: readRestoreGeneration(database) };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// The store part of every restore: what the backup holds replaces entities and relations; every current record
// the backup does not have gets a tombstone and the revision moves on, so clients pull instead of writing
// their copies back.
function nextSnapshotAfterRestore(current: StoreSnapshot, restored: StoreSnapshot): StoreSnapshot {
  const restoredIds = new Set(restored.entities.map((entity) => entity.id));
  const tombstones = new Map((current.tombstones || []).map((item) => [item.id, item]));
  for (const id of restoredIds) tombstones.delete(id);
  for (const entity of current.entities) {
    if (!restoredIds.has(entity.id)) tombstones.set(entity.id, { id: entity.id, deletedAt: Date.now() });
  }
  return {
    revision: current.revision + 1,
    entities: restored.entities.some((entity) => entity.id === "workspace:personal")
      ? restored.entities
      : [defaultWorkspaceEntity(), ...restored.entities],
    relations: restored.relations,
    tombstones: [...tombstones.values()],
    updatedAt: Date.now(),
  };
}

let crashAfterVacuumForTests: (() => void) | null = null;
/** Tests only: runs between VACUUM INTO and the cleaning of the staging copy of a backup. */
export function stopBackupAfterVacuumForTests(hook: (() => void) | null) {
  if (hook !== null && !process.env.NODE_TEST_CONTEXT) throw new Error("Not available outside tests");
  crashAfterVacuumForTests = hook;
}
let restoreFaultForTests: string | null = null;
/** Tests only: makes a restore fail after the named table was replaced, to show that nothing stays changed. */
export function failRestoreAfterTableForTests(table: string | null) {
  // Only the test runner sets this; nothing in the app or its routes calls it.
  if (table !== null && !process.env.NODE_TEST_CONTEXT) throw new Error("Not available outside tests");
  restoreFaultForTests = table;
}

const temporaryDirectory = path.join(dataDirectory, "tmp");
// Files this feature creates there, by prefix. Anything of these in the folder that is not in use by a request of this
// process is left over from one that was killed, and goes at start and before the next file is made, whatever its age.
const temporaryPrefixes = ["restore-", "export-", "import-", "backup-"];
// Paths handed out and not yet released by their owner. Cleanup never touches one, whether or not the file exists yet.
const temporaryInUse = new Set<string>();
export function removeLeftoverTemporaryFiles() {
  try {
    if (!existsSync(temporaryDirectory)) return;
    for (const entry of readdirSync(temporaryDirectory)) {
      const file = path.join(temporaryDirectory, entry);
      if (!temporaryPrefixes.some((prefix) => entry.startsWith(prefix)) || temporaryInUse.has(file)) continue;
      removeIfExists(file);
    }
  } catch (error) {
    console.error("Cleaning temporary files failed:", error instanceof Error ? error.message : error);
  }
}
export function temporaryFile(prefix: string, extension: string) {
  if (!temporaryPrefixes.some((known) => prefix.startsWith(known.slice(0, -1)))) throw new Error("Unknown temporary file kind");
  mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  chmodSync(temporaryDirectory, 0o700);
  removeLeftoverTemporaryFiles();
  const file = path.join(temporaryDirectory, `${prefix}-${randomUUID()}${extension}`);
  temporaryInUse.add(file);
  return file;
}
/** The owner of a temporary file is done with it: the file is deleted and the path is no longer reserved. */
export function releaseTemporaryFile(file: string) {
  try { removeIfExists(file); } finally { temporaryInUse.delete(file); }
}

/**
 * Restores the owner data from a database file (a full backup or an imported package's database.sqlite): the file
 * is copied and brought to the current schema through the real migrations, a safety backup of the current state is
 * made, then everything is replaced in one transaction. A refused or failed restore leaves the live data as it was.
 */
export function restoreDatabaseFile(file: string) {
  const copy = temporaryFile("restore", ".sqlite");
  try {
    prepareRestoreCopy(file, copy, schemaMigrations.map((migration) => migration.id), applySchema);
    let restored: StoreSnapshot;
    const source = new DatabaseSync(copy, { readOnly: true });
    try {
      restored = {
        revision: 0,
        entities: (source.prepare("SELECT payload FROM entities ORDER BY updated_at, id").all() as Array<{ payload: string }>)
          .map((row) => JSON.parse(String(row.payload))),
        relations: (source.prepare("SELECT payload FROM relations ORDER BY created_at, id").all() as Array<{ payload: string }>)
          .map((row) => JSON.parse(String(row.payload))),
        tombstones: [],
        updatedAt: 0,
      };
      validateSnapshot(restored);
    } catch {
      throw new HttpInputError("Invalid backup");
    } finally {
      source.close();
    }
    createBackup("before-restore");
    const database = getDatabase();
    database.prepare("ATTACH DATABASE ? AS restore_source").run(copy);
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        const current = readSnapshot();
        const next = nextSnapshotAfterRestore(current, restored);
        replaceUnchecked(database, next);
        replaceTablesFromAttached(database, "restore_source", replacedTables, excludedClearedTables, (table) => {
          if (restoreFaultForTests === table) throw new Error("Restore failed (test)");
        });
        bumpRestoreGeneration(database);
        database.exec("COMMIT");
        return { ...next, restoreGeneration: readRestoreGeneration(database) };
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* the original error matters */ }
        throw error;
      }
    } finally {
      try { database.exec("DETACH DATABASE restore_source"); } catch (error) { console.error("Detaching the restore copy failed", error); }
      runReadyHooks();
    }
  } finally {
    releaseTemporaryFile(copy);
  }
}

function restoreFullBackup(name: string) {
  const file = path.join(backupDirectory, name);
  const meta = readSidecar(name);
  if (!existsSync(file)) throw new HttpInputError("Invalid backup");
  const actual = describeFile(file);
  if (actual.bytes !== meta.bytes || actual.sha256 !== meta.sha256) throw new HttpInputError("Backup does not match its checksum");
  return restoreDatabaseFile(file);
}

export function restoreBackup(name: string) {
  const safe = safeBackupName(name);
  if (safe.endsWith(".json")) return restoreLegacyBackup(safe);
  return restoreFullBackup(safe);
}

/** A cleaned copy of the live database for an export; the caller deletes it with `dispose`. */
export function createExportCopy() {
  const file = temporaryFile("export", ".sqlite");
  try {
    const { counts, migrations } = writeCleanCopy(getDatabase(), file);
    return { path: file, counts, migrations, dispose: () => releaseTemporaryFile(file) };
  } catch (error) {
    releaseTemporaryFile(file);
    throw error;
  }
}

function migrateLegacyStore(database: DatabaseSync) {
  // Without a legacy file there is nothing to look at (and the whole store is not read into memory at every start).
  if (!existsSync(legacyStorePath)) return;
  const current = readSnapshot();
  if (current.revision !== 0 || current.entities.length) return;
  try {
    const legacy = JSON.parse(readFileSync(legacyStorePath, "utf8")) as StoreSnapshot;
    if (!Array.isArray(legacy.entities) || !Array.isArray(legacy.relations)) return;
    database.exec("BEGIN IMMEDIATE");
    replaceUnchecked(database, {
      revision: Number(legacy.revision) || 0,
      entities: legacy.entities,
      relations: legacy.relations,
      tombstones: [],
      updatedAt: Number(legacy.updatedAt) || Date.now(),
    });
    // The migrations ran before this import: its notes get their baseline revision here.
    baselineNoteRevisions(database, Number(legacy.revision) || 0);
    database.exec("COMMIT");
    createBackup("json-migration");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    console.error("Legacy store migration failed", error);
  }
}
