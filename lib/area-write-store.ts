// 2a part 4 for the server paths that write SQLite rows directly (Inbox batch, AI actions, work-session
// occurrences) instead of going through replaceSnapshot. Call `readAreaRows` inside the write transaction
// BEFORE the mutation and `enforceAreaWritesInTransaction` after it, still inside the transaction.
import type { DatabaseSync } from "node:sqlite";
import type { Entity, Relation } from "./db";
import { enforceAreaWriteInvariants, type AreaWriteReport } from "./area-write-invariants";

export interface AreaRows {
  entities: Entity[];
  relations: Relation[];
}

export function readAreaRows(database: DatabaseSync): AreaRows {
  const parse = <T>(rows: unknown[]) => rows.map((row) => JSON.parse(String((row as { payload: string }).payload)) as T);
  return {
    entities: parse<Entity>(database.prepare("SELECT payload FROM entities").all()),
    relations: parse<Relation>(database.prepare("SELECT payload FROM relations").all()),
  };
}

/** Writes the corrections the invariants make to this transaction's changes. Returns a content-free report. */
export function enforceAreaWritesInTransaction(
  database: DatabaseSync,
  before: AreaRows,
  now: number,
): AreaWriteReport & { changed: boolean } {
  const after = readAreaRows(database);
  const tombstones = (database.prepare("SELECT id FROM tombstones").all() as Array<{ id: string }>)
    .map((row) => ({ id: String(row.id) }));
  const result = enforceAreaWriteInvariants({ current: before, next: after, tombstones, now });
  if (result.changed) {
    const stored = new Map(after.entities.map((entity) => [entity.id, JSON.stringify(entity)]));
    const upsert = database.prepare(`INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`);
    for (const entity of result.entities) {
      const payload = JSON.stringify(entity);
      if (stored.get(entity.id) !== payload) upsert.run(entity.id, payload, entity.updatedAt || 0);
    }
    const removeRelation = database.prepare("DELETE FROM relations WHERE id = ?");
    const tombstone = database.prepare(`INSERT INTO tombstones (id, deleted_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at`);
    for (const id of result.droppedRelationIds) {
      removeRelation.run(id);
      tombstone.run(id, now);
    }
    const known = new Set(after.relations.map((relation) => relation.id));
    const insertRelation = database.prepare("INSERT INTO relations (id, payload, created_at) VALUES (?, ?, ?)");
    for (const relation of result.relations) {
      if (!known.has(relation.id)) insertRelation.run(relation.id, JSON.stringify(relation), relation.createdAt || 0);
    }
  }
  return { ...result.report, changed: result.changed };
}
