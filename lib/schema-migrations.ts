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
