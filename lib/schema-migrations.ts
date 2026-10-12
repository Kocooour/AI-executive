import type { DatabaseSync } from "node:sqlite";

// Named, additive schema/data migrations. Each one runs exactly once per database, inside its
// own transaction together with the row that records it, so an interrupted run leaves no trace
// and the next start simply tries again. The older ad-hoc migrations in server-store keep
// working as they are; new migrations are registered here.

export interface SchemaMigration {
  id: string;
  up: (database: DatabaseSync) => void;
}

export const schemaMigrations: SchemaMigration[] = [
  {
    // Context Graph v2: claim sensitivity has three levels. The two-level "sensitive" becomes
    // "confidential"; stricter values are kept. Revisions and timestamps are not touched.
    id: "2026-10-context-claims-three-level-sensitivity",
    up(database) {
      database.exec("UPDATE context_claims SET sensitivity = 'confidential' WHERE sensitivity = 'sensitive'");
    },
  },
  {
    // Context Graph v2: durable Undo/Redo. Change events get a deterministic order (`sequence`), the
    // type of the changed object, a kind (change, undo or redo) and the event a reversal reverses.
    // The columns are added; what was recorded (payloads, revisions, times) is never rewritten.
    id: "2026-10-context-change-events-undo-linkage",
    up(database) {
      const columns = new Set((database.prepare("PRAGMA table_info(context_change_events)").all() as Array<{ name?: string }>)
        .map((row) => String(row.name)));
      if (!columns.has("sequence")) database.exec("ALTER TABLE context_change_events ADD COLUMN sequence INTEGER");
      if (!columns.has("object_type")) database.exec("ALTER TABLE context_change_events ADD COLUMN object_type TEXT");
      if (!columns.has("kind")) database.exec("ALTER TABLE context_change_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'change'");
      if (!columns.has("reverts_event_id")) database.exec("ALTER TABLE context_change_events ADD COLUMN reverts_event_id TEXT");
      database.exec(`UPDATE context_change_events SET object_type =
        CASE WHEN operation LIKE 'subject.%' THEN 'subject' ELSE 'claim' END WHERE object_type IS NULL`);
      let next = Number((database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM context_change_events").get() as { value: number }).value);
      const pending = database.prepare("SELECT rowid AS row FROM context_change_events WHERE sequence IS NULL ORDER BY created_at, rowid").all() as Array<{ row: number }>;
      const assign = database.prepare("UPDATE context_change_events SET sequence = ? WHERE rowid = ?");
      for (const { row } of pending) assign.run(++next, row);
      database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS context_change_events_sequence_idx ON context_change_events(sequence);
        CREATE INDEX IF NOT EXISTS context_change_events_workspace_sequence_idx ON context_change_events(workspace_id, sequence)`);
    },
  },
];

export function runSchemaMigrations(database: DatabaseSync, migrations: SchemaMigration[] = schemaMigrations) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied: string[] = [];
  for (const migration of migrations) {
    database.exec("BEGIN IMMEDIATE");
    try {
      // Checked after the write lock is held, so two processes starting together run it once.
      if (!database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migration.id)) {
        migration.up(database);
        database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
          .run(migration.id, new Date().toISOString());
        applied.push(migration.id);
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* the original error is the one that matters */ }
      throw error;
    }
  }
  return applied;
}
