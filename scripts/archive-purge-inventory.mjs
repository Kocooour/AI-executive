#!/usr/bin/env node
// #501 D-1: read-only inventory of an externally verified isolated SQLite copy.
// The manifest binds bytes to an operator attestation; it does NOT prove the
// backup process was trustworthy. This script has no destructive command.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const KNOWN_TABLES = Object.freeze([
  "entities", "relations", "tombstones",
  "pact_context", "pact_agents", "pact_tool_permissions", "pact_agent_runs",
  "context_subjects", "context_claims", "context_review_events",
  "context_change_events", "context_sources", "context_evidence",
  "note_revisions", "work_sessions", "work_session_intervals",
  "work_session_events", "attention_states", "attention_history",
  "calendar_sources", "calendar_accounts", "mail_accounts",
  "mail_sync_accounts", "mail_sync_messages", "ai_action_history",
  "passkey_credentials", "passkey_challenges", "push_subscriptions",
  "notification_deliveries", "security_events", "security_alerts",
  "schema_migrations", "metadata", "context_commands",
  "work_session_commands", "ai_proposals", "calendar_events",
  "semantic_index_outbox", "mail_oauth_pending",
]);
const ENTITY_KINDS = ["task", "note", "project", "area", "workspace"];
const WORKSPACE_TABLES = [
  "attention_states", "attention_history", "calendar_sources", "calendar_events",
  "pact_context", "context_subjects", "context_claims", "context_review_events",
  "context_change_events", "context_commands", "work_sessions",
  "work_session_intervals", "work_session_commands", "work_session_events",
  "pact_tool_permissions", "pact_agent_runs", "ai_proposals", "ai_action_history",
  "context_sources", "context_evidence", "note_revisions", "semantic_index_outbox",
  "mail_accounts", "mail_oauth_pending", "mail_sync_accounts", "mail_sync_messages",
];
const TASK_TABLES = ["work_sessions", "work_session_intervals", "work_session_events"];
const ENTITY_REFERENCES = {
  attention_states: "subject_id", notification_deliveries: "entity_id",
  ai_action_history: "entity_id",
};
const REQUIRED_COLUMNS = {
  entities: { id: "TEXT", payload: "TEXT!", updated_at: "INTEGER!" },
  relations: { id: "TEXT", payload: "TEXT!" },
  tombstones: { id: "TEXT", deleted_at: "INTEGER!" },
  work_sessions: { task_id: "TEXT!", state: "TEXT!", workspace_id: "TEXT!" },
  work_session_intervals: { task_id: "TEXT!", workspace_id: "TEXT!", session_id: "TEXT!" },
  work_session_events: { task_id: "TEXT!", workspace_id: "TEXT!", session_id: "TEXT!" },
  attention_states: { subject_id: "TEXT!", workspace_id: "TEXT!" },
  notification_deliveries: { entity_id: "TEXT!" },
  ai_action_history: { entity_id: "TEXT!", workspace_id: "TEXT!" },
  context_subjects: { canonical_entity_id: "TEXT", workspace_id: "TEXT!" },
  metadata: { key: "TEXT", value: "TEXT!" },
};
const EXPECTED_TRIGGERS = Object.freeze([
  ...["entities", "context_claims", "context_subjects", "context_sources", "context_evidence"]
    .flatMap((name) => ["insert", "update", "delete"].map((op) => "semantic_outbox_" + name + "_" + op)),
  "semantic_outbox_restore_generation", "semantic_outbox_first_restore_generation",
  ...["evidence_claim", "source_claim"].flatMap((name) =>
    ["insert", "update", "delete"].map((op) => "semantic_outbox_" + name + "_" + op)),
  "semantic_outbox_bound_queue", "mail_workspace_deleted",
  "mail_workspace_identity_changed", "mail_sync_disconnected", "mail_sync_consent_removed",
]);
function quote(name) { return '"' + name.replaceAll('"', '""') + '"'; }
function count(db, table) {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM " + quote(table)).get().count);
}
function safeColumn(cols, name, contract) {
  const found = cols?.get(name);
  return Boolean(found && String(found.type).toUpperCase() === contract.replace("!", "") &&
    (!contract.endsWith("!") || Number(found.notnull) === 1));
}
function fileHash(file) {
  const hash = createHash("sha256"), fd = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1 << 20);
  try {
    for (let size; (size = readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, size));
    }
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
function standalone(file) {
  if (!file || !path.isAbsolute(file)) throw new Error("invalid-path");
  const s = lstatSync(file);
  // nlink > 1 is a hard-link alias that could be a live production database.
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error("unsafe-file");
  return { file: realpathSync(file), dev: s.dev, ino: s.ino, bytes: s.size };
}
function pathExists(file) {
  try { lstatSync(file); return true; } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
function refCount(db, table, column, types) {
  const kinds = types.map((kind) => "'" + kind + "'").join(", ");
  const row = db.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN EXISTS (" +
    "SELECT 1 FROM entities e WHERE e.id = t." + quote(column) +
    " AND json_valid(e.payload) AND json_extract(e.payload, '$.type') IN (" + kinds +
    ")) THEN 1 ELSE 0 END), 0) AS linked FROM " + quote(table) + " t"
  ).get();
  return { total: Number(row.total), linkedToArchive: Number(row.linked),
    notMatchedInArchive: Number(row.total) - Number(row.linked) };
}
function workspaceRefs(db, table) {
  // The internal entity id need not equal "workspace:" + workspace_id.
  const row = db.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN EXISTS (" +
    "SELECT 1 FROM entities e WHERE json_valid(e.payload) " +
    "AND json_extract(e.payload, '$.type') = 'workspace' " +
    "AND json_extract(e.payload, '$.workspaceId') = t.workspace_id" +
    ") THEN 1 ELSE 0 END), 0) AS linked FROM " + quote(table) + " t"
  ).get();
  return { total: Number(row.total), linkedToLegacyWorkspace: Number(row.linked),
    withoutMatchingLegacyWorkspace: Number(row.total) - Number(row.linked) };
}
function sessionMatrix(db) {
  const matrix = {};
  const rows = db.prepare(
    "SELECT state, COUNT(*) AS total, COALESCE(SUM(CASE WHEN EXISTS(" +
    "SELECT 1 FROM entities e WHERE e.id = s.task_id AND json_valid(e.payload) " +
    "AND json_extract(e.payload, '$.type') = 'task'" +
    ") THEN 1 ELSE 0 END), 0) AS linked FROM work_sessions s GROUP BY state"
  ).all();
  for (const row of rows) {
    const state = ["running", "paused", "completed"].includes(row.state) ? row.state : "other";
    const obj = matrix[state] || { total: 0, linkedToArchiveTask: 0, notMatchedInArchive: 0 };
    obj.total += Number(row.total);
    obj.linkedToArchiveTask += Number(row.linked);
    obj.notMatchedInArchive += Number(row.total) - Number(row.linked);
    matrix[state] = obj;
  }
  return matrix;
}
export function inventoryDatabase(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => String(row.name));
  const present = new Set(tables);
  const missingTables = KNOWN_TABLES.filter((name) => !present.has(name));
  const unknownTableCount = tables.filter((name) => !KNOWN_TABLES.includes(name)).length;
  // Only known, compile-time table names can appear as JSON keys.
  const tableCounts = Object.fromEntries(KNOWN_TABLES.filter((name) => present.has(name))
    .map((name) => [name, count(db, name)]));
  const columns = new Map();
  for (const name of KNOWN_TABLES.filter((n) => present.has(n))) {
    columns.set(name, new Map(db.prepare("PRAGMA table_info(" + quote(name) + ")")
      .all().map((row) => [String(row.name), row])));
  }
  const invalidColumns = [];
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    for (const [name, specification] of Object.entries(required)) {
      if (!safeColumn(columns.get(table), name, specification)) invalidColumns.push(table + "." + name);
    }
  }
  for (const table of WORKSPACE_TABLES) {
    if (!safeColumn(columns.get(table), "workspace_id", "TEXT!") &&
      !invalidColumns.includes(table + ".workspace_id")) {
      invalidColumns.push(table + ".workspace_id");
    }
  }
  const triggers = db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger'"
  ).all();
  const names = new Set(triggers.map((r) => String(r.name)));
  const missingTriggerCount = EXPECTED_TRIGGERS.filter((n) => !names.has(n)).length;
  const unknownTriggerCount = triggers.filter((r) => !EXPECTED_TRIGGERS.includes(String(r.name))).length;
  // Content-free digest detects edited bodies against an independently reviewed baseline.
  const triggerDigest = createHash("sha256").update(JSON.stringify(triggers
    .map((r) => [r.name, r.tbl_name, r.sql]).sort((a,b) => a[0].localeCompare(b[0]))))
    .digest("hex");
  // Full DDL digest covers columns, constraints, indexes and same-name altered triggers.
  // Must be compared against an independently approved schema reference in the manifest.
  const schemaDigest = createHash("sha256").update(JSON.stringify(db.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master " +
    "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
  ).all())).digest("hex");

  const entityCounts = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, 0]));
  let malformedEntityRows = 0, unrecognizedEntityRows = 0;
  const canInspect = missingTables.length === 0 && invalidColumns.length === 0;
  if (canInspect) {
    malformedEntityRows = Number(db.prepare(
      "SELECT COUNT(*) AS count FROM entities WHERE NOT json_valid(payload)"
    ).get().count);
    for (const row of db.prepare(
      "SELECT json_extract(payload, '$.type') AS kind, COUNT(*) AS count " +
      "FROM entities WHERE json_valid(payload) GROUP BY kind"
    ).all()) {
      if (ENTITY_KINDS.includes(row.kind)) entityCounts[row.kind] = Number(row.count);
      else unrecognizedEntityRows += Number(row.count);
    }
  }
  const taskLinks = {}, workspaceLinks = {}, derivedLinks = {};
  let sessionsByState = {};
  if (canInspect && malformedEntityRows === 0 && unrecognizedEntityRows === 0) {
    for (const table of TASK_TABLES) taskLinks[table] = refCount(db, table, "task_id", ["task"]);
    for (const table of WORKSPACE_TABLES) workspaceLinks[table] = workspaceRefs(db, table);
    for (const [table, col] of Object.entries(ENTITY_REFERENCES)) {
      derivedLinks[table] = refCount(db, table, col, ENTITY_KINDS);
    }
    sessionsByState = sessionMatrix(db);
  }
  const integrity = db.prepare("PRAGMA integrity_check").all();
  const integrityOk = integrity.length === 1 && Object.values(integrity[0])[0] === "ok";
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  const blockers = [];
  if (!integrityOk) blockers.push("sqlite-integrity");
  if (foreignKeyViolations) blockers.push("sqlite-foreign-keys");
  if (missingTables.length) blockers.push("missing-schema-tables");
  if (unknownTableCount) blockers.push("unclassified-schema-tables");
  if (invalidColumns.length) blockers.push("invalid-schema-columns");
  if (missingTriggerCount) blockers.push("missing-triggers");
  if (unknownTriggerCount) blockers.push("unclassified-triggers");
  if (malformedEntityRows) blockers.push("malformed-entities");
  if (unrecognizedEntityRows) blockers.push("unknown-entity-types");
  return {
    format: "lumi-archive-inventory-v2", diagnosticOnly: true,
    destructiveActionsAllowed: false, integrityOk, foreignKeyViolations,
    entityCounts, malformedEntityRows, unrecognizedEntityRows, tableCounts,
    sessionsByState, taskLinks, workspaceLinks, derivedLinks,
    missingTables, unknownTableCount, invalidColumns, missingTriggerCount,
    unknownTriggerCount, triggerDigest, schemaDigest, blockers, inventoryComplete: blockers.length === 0,
  };
}
function readManifest(file) {
  const s = standalone(file);
  const manifest = JSON.parse(readFileSync(s.file, "utf8"));
  if (manifest.format !== "lumi-archive-isolated-copy-v1" ||
      manifest.method !== "sqlite-backup" || manifest.consistent !== true ||
      !/^[0-9a-f]{64}$/.test(manifest.sourceStoreIdentity || "") ||
      !/^[0-9a-f]{64}$/.test(manifest.sha256 || "") ||
      !/^[0-9a-f]{64}$/.test(manifest.referenceSchemaSha256 || "") ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) {
    throw new Error("invalid-manifest");
  }
  return manifest;
}
export function inventoryCopy(file, manifestFile) {
  const s = standalone(file);
  if (!manifestFile || !path.isAbsolute(manifestFile)) throw new Error("manifest-required");
  const manifest = readManifest(manifestFile);
  const protectedDirs = ["/var/lib/ai-executive", process.env.AI_EXECUTIVE_DATA_DIR]
    .filter(Boolean).map((dir) => path.resolve(dir));
  if (protectedDirs.some((dir) => s.file === dir || s.file.startsWith(dir + path.sep))) {
    throw new Error("live-database-refused");
  }
  // Including a dangling symlink. Do not silently omit uncheckpointed WAL data.
  if (pathExists(s.file + "-wal") || pathExists(s.file + "-shm")) {
    throw new Error("sqlite-sidecars-refused");
  }
  if (manifest.bytes !== s.bytes || manifest.sha256 !== fileHash(s.file)) {
    throw new Error("manifest-mismatch");
  }
  const db = new DatabaseSync(s.file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const result = inventoryDatabase(db);
    if (result.schemaDigest !== manifest.referenceSchemaSha256) {
      result.blockers.push("schema-manifest-drift");
      result.inventoryComplete = false;
    }
    const after = statSync(s.file);
    if (after.dev !== s.dev || after.ino !== s.ino ||
        after.nlink !== 1 || after.size !== s.bytes ||
        fileHash(s.file) !== manifest.sha256) {
      throw new Error("snapshot-changed");
    }
    return { ...result, copyHashMatched: true, provenance: "operator-attested" };
  } finally {
    db.close();
    if (pathExists(s.file + "-wal") || pathExists(s.file + "-shm")) {
      throw new Error("sqlite-sidecars-refused");
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6 || process.argv[2] !== "--db-copy" ||
      process.argv[4] !== "--manifest") {
    console.error("Usage: node scripts/archive-purge-inventory.mjs --db-copy /absolute/isolated.sqlite --manifest /absolute/provenance.json");
    process.exitCode = 2;
  } else {
    try {
      const result = inventoryCopy(process.argv[3], process.argv[5]);
      console.log(JSON.stringify(result));
      if (!result.inventoryComplete) process.exitCode = 1;
    } catch {
      console.error("Archive inventory refused: unverified or unsupported isolated copy");
      process.exitCode = 2;
    }
  }
}
