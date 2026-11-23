#!/usr/bin/env node
// Milestone D / #501: non-destructive inventory of an ISOLATED legacy SQLite copy.
// This script does not support --apply, open the target store, or log item content.
// SQLite may touch -shm even when opened read-only: never point it at a live DB.
import { DatabaseSync } from "node:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function quote(name) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function count(database, sql) {
  return Number(database.prepare(sql).get().count);
}

function linkedReferences(database, table, idColumn, predicate) {
  const sql = "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN EXISTS (" +
    "SELECT 1 FROM entities e WHERE e.id = t." + quote(idColumn) +
    " AND json_valid(e.payload) AND json_extract(e.payload, '$.type') = " +
    "'" + predicate + "'" +
    ") THEN 1 ELSE 0 END), 0) AS linked FROM " + quote(table) + " t";
  const row = database.prepare(sql).get();
  return {
    total: Number(row.total),
    linkedToLegacy: Number(row.linked),
    withoutMatchingLegacy: Number(row.total) - Number(row.linked),
  };
}

function workspaceReferences(database, table) {
  const sql = "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN EXISTS (" +
    "SELECT 1 FROM entities e WHERE e.id = 'workspace:' || t.workspace_id" +
    " AND json_valid(e.payload) AND json_extract(e.payload, '$.type') = 'workspace'" +
    ") THEN 1 ELSE 0 END), 0) AS linked FROM " + quote(table) + " t";
  const row = database.prepare(sql).get();
  return {
    total: Number(row.total),
    linkedToLegacyWorkspace: Number(row.linked),
    withoutMatchingLegacyWorkspace: Number(row.total) - Number(row.linked),
  };
}

export function inventoryDatabase(database) {
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => String(row.name));
  const present = new Set(tables);
  const known = new Set(KNOWN_TABLES);
  const missingTables = KNOWN_TABLES.filter((name) => !present.has(name));
  const unknownTables = tables.filter((name) => !known.has(name));
  const tableCounts = {};
  for (const name of tables) {
    // A discovered table name is an identifier, never a SQL expression.
    tableCounts[name] = count(database, "SELECT COUNT(*) AS count FROM " + quote(name));
  }

  const entityCounts = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, 0]));
  let malformedEntityRows = 0;
  let unrecognizedEntityRows = 0;
  if (present.has("entities")) {
    malformedEntityRows = count(database,
      "SELECT COUNT(*) AS count FROM entities WHERE NOT json_valid(payload)");
    for (const row of database.prepare(
      "SELECT json_extract(payload, '$.type') AS kind, COUNT(*) AS count " +
      "FROM entities WHERE json_valid(payload) GROUP BY kind"
    ).all()) {
      if (ENTITY_KINDS.includes(row.kind)) entityCounts[row.kind] = Number(row.count);
      else unrecognizedEntityRows += Number(row.count);
    }
  }

  const workspaceLinks = {};
  const taskLinks = {};
  const derivedLinks = {};
  if (present.has("entities")) {
    for (const table of tables) {
      const columns = new Set(database.prepare("PRAGMA table_info(" + quote(table) + ")")
        .all().map((row) => String(row.name)));
      if (columns.has("workspace_id")) workspaceLinks[table] = workspaceReferences(database, table);
      if (["work_sessions", "work_session_intervals", "work_session_events"].includes(table) &&
        columns.has("task_id")) {
        taskLinks[table] = linkedReferences(database, table, "task_id", "task");
      }
      if (table === "attention_states" && columns.has("subject_id")) {
        derivedLinks[table] = linkedReferences(database, table, "subject_id", "task");
      }
      if (table === "notification_deliveries" && columns.has("entity_id")) {
        derivedLinks[table] = linkedReferences(database, table, "entity_id", "task");
      }
    }
  }

  const sessionsByState = {};
  if (present.has("work_sessions")) {
    const columns = new Set(database.prepare("PRAGMA table_info(work_sessions)")
      .all().map((row) => String(row.name)));
    if (columns.has("state")) {
      for (const row of database.prepare(
        "SELECT state, COUNT(*) AS count FROM work_sessions GROUP BY state"
      ).all()) {
        // Report status only when it is a literal schema-recognized value.
        const status = ["running", "paused", "completed"].includes(row.state) ?
          row.state : "other";
        sessionsByState[status] = (sessionsByState[status] || 0) + Number(row.count);
      }
    }
  }

  const integrity = database.prepare("PRAGMA integrity_check").all();
  const integrityOk = integrity.length === 1 && Object.values(integrity[0])[0] === "ok";
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
  const blockers = [];
  if (!integrityOk) blockers.push("sqlite-integrity");
  if (foreignKeyViolations) blockers.push("sqlite-foreign-keys");
  if (missingTables.length) blockers.push("missing-schema-tables");
  if (unknownTables.length) blockers.push("unclassified-schema-tables");
  if (malformedEntityRows) blockers.push("malformed-entities");
  if (unrecognizedEntityRows) blockers.push("unknown-entity-types");

  return {
    format: "lumi-archive-inventory-v1",
    diagnosticOnly: true,
    destructiveActionsAllowed: false,
    integrityOk,
    foreignKeyViolations,
    entityCounts,
    malformedEntityRows,
    unrecognizedEntityRows,
    tableCounts,
    sessionsByState,
    taskLinks,
    workspaceLinks,
    derivedLinks,
    missingTables,
    unknownTables,
    blockers,
    // Even with zero blockers this is an inventory, NOT a purge preflight.
    inventoryComplete: blockers.length === 0,
  };
}

export function inventoryCopy(file) {
  if (!file || !path.isAbsolute(file)) throw new Error("invalid-copy");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid-copy");
  const actual = realpathSync(file);
  const protectedDirs = ["/var/lib/ai-executive", process.env.AI_EXECUTIVE_DATA_DIR]
    .filter(Boolean).map((dir) => path.resolve(dir));
  if (protectedDirs.some((dir) => actual === dir || actual.startsWith(dir + path.sep))) {
    throw new Error("live-database-refused");
  }
  const database = new DatabaseSync(actual, { readOnly: true });
  try {
    return inventoryDatabase(database);
  } finally {
    database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--db-copy") {
    console.error("Usage: node scripts/archive-purge-inventory.mjs --db-copy /absolute/path/to/isolated/store.sqlite");
    process.exitCode = 2;
  } else {
    try {
      const result = inventoryCopy(process.argv[3]);
      console.log(JSON.stringify(result));
      if (!result.inventoryComplete) process.exitCode = 1;
    } catch {
      // Never echo exception messages: they may contain filenames or private DB content.
      console.error("Archive inventory refused: invalid or unreadable isolated copy");
      process.exitCode = 2;
    }
  }
}
