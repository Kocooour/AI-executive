// What a backup (and an export) contains. Every table of the schema must be named in exactly one of the lists
// below; tests/backups-v2.test.mjs fails when a table exists in the schema but is in neither, so a future table
// has to be classified when it is added.

// Owner data: copied into a backup and replaced on restore. `entities`, `relations` and `tombstones` are
// handled by the store itself (revision, tombstones so that clients do not resurrect data); the others are
// replaced table by table.
export const storeTables = ["entities", "relations", "tombstones"] as const;

export const includedTables = [
  ...storeTables,
  "pact_context", "pact_agents", "pact_tool_permissions", "pact_agent_runs",
  "context_subjects", "context_claims", "context_review_events", "context_change_events",
  "context_sources", "context_evidence", "note_revisions",
  "work_sessions", "work_session_intervals", "work_session_events",
  "attention_states", "attention_history",
  "calendar_sources", "ai_action_history",
] as const;

// Not owner data to carry around: removed from backup files and left as they are on restore. `metadata` also
// holds secrets (push keys); only the store revision and its time are kept in a file, for information.
export const excludedKeptTables = [
  "passkey_credentials", "passkey_challenges", "push_subscriptions", "notification_deliveries",
  "security_events", "security_alerts", "schema_migrations", "metadata",
  "calendar_events", // a cache of the calendars, fetched again
] as const;

// Removed from a backup file although they are excluded, except `schema_migrations`: the file needs the list of
// applied migrations to be brought to the current schema on restore (it holds ids and times, no owner data).
export const keptInFileTables = ["schema_migrations"] as const;

// Not in a backup, and emptied on restore: they refer to results or sessions from before the restore.
export const excludedClearedTables = ["context_commands", "work_session_commands", "ai_proposals"] as const;

export const excludedTables: readonly string[] = [...excludedKeptTables, ...excludedClearedTables];
export const emptiedInFileTables: readonly string[] = excludedTables.filter((table) => !(keptInFileTables as readonly string[]).includes(table));
export const replacedTables: readonly string[] = includedTables.filter((table) => !(storeTables as readonly string[]).includes(table));
export const metadataKeptKeys = ["revision", "updatedAt"] as const;

export function classifiedTables(): string[] {
  return [...includedTables, ...excludedTables];
}
