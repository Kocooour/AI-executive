import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Entity, Relation } from "./db";

export interface StoreSnapshot {
  revision: number;
  entities: Entity[];
  relations: Relation[];
  tombstones: Array<{ id: string; deletedAt: number }>;
  updatedAt: number;
}

export interface BackupSummary {
  name: string;
  createdAt: number;
  entityCount: number;
  relationCount: number;
  error?: string;
}

const dataDirectory =
  process.env.AI_EXECUTIVE_DATA_DIR || path.join(process.cwd(), ".data");
const backupDirectory = path.join(dataDirectory, "backups");
const databasePath = path.join(dataDirectory, "store.sqlite");
const legacyStorePath = path.join(dataDirectory, "store.json");
let databaseInstance: DatabaseSync | null = null;

export function getDatabase() {
  if (databaseInstance) return databaseInstance;
  mkdirSync(dataDirectory, { recursive: true });
  const database = new DatabaseSync(databasePath);
  databaseInstance = database;
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
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
  `);
  migrateLegacyStore(database);
  return database;
}

const readMetadata = (database: DatabaseSync, key: string, fallback = "0") =>
  String(
    (
      database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
        | { value?: string }
        | undefined
    )?.value ?? fallback,
  );

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

export function replaceSnapshot(
  baseRevision: number,
  entities: Entity[],
  relations: Relation[],
  deletedIds: string[] = [],
  revivedIds: string[] = [],
) {
  const currentBeforeWrite = readSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  if (
    currentBeforeWrite.entities.length &&
    !listBackups().some(
      (backup) => backup.name.startsWith(today) && backup.name.endsWith("-daily.json"),
    )
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
    const tombstones = new Map(
      (current.tombstones || []).map((item) => [item.id, item]),
    );
    for (const id of revivedIds) {
      if (typeof id === "string" && id) tombstones.delete(id);
    }
    for (const id of deletedIds) {
      if (typeof id === "string" && id) {
        tombstones.set(id, { id, deletedAt: Date.now() });
      }
    }
    const tombstonedIds = new Set(tombstones.keys());
    const liveEntities = entities.filter((entity) => !tombstonedIds.has(entity.id));
    const liveEntityIds = new Set(liveEntities.map((entity) => entity.id));
    const next: StoreSnapshot = {
      revision: current.revision + 1,
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
    database.exec("COMMIT");
    return { conflict: false as const, snapshot: next };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function safeBackupName(name: string) {
  if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z(?:-[a-z-]+)?\.json$/.test(name)) {
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
  for (const entity of value.entities) {
    if (
      !entity ||
      typeof entity.id !== "string" ||
      typeof entity.type !== "string" ||
      typeof entity.title !== "string" ||
      typeof entity.workspaceId !== "string" ||
      typeof entity.updatedAt !== "number"
    ) {
      throw new Error("Snapshot contains an invalid entity");
    }
    if (entityIds.has(entity.id)) throw new Error("Snapshot contains duplicate entity IDs");
    entityIds.add(entity.id);
  }
  const relationIds = new Set<string>();
  for (const relation of value.relations) {
    if (
      !relation ||
      typeof relation.id !== "string" ||
      typeof relation.sourceEntityId !== "string" ||
      typeof relation.targetEntityId !== "string" ||
      typeof relation.relationType !== "string"
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
    relationIds.add(relation.id);
  }
}

function summarizeBackup(name: string, snapshot: StoreSnapshot): BackupSummary {
  return {
    name,
    createdAt: statSync(path.join(backupDirectory, name)).mtimeMs,
    entityCount: snapshot.entities.length,
      relationCount: snapshot.relations.length,
  };
}

export function createBackup(label = "manual") {
  mkdirSync(backupDirectory, { recursive: true });
  const snapshot = readSnapshot();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = label.replace(/[^a-z-]/gi, "").toLowerCase() || "manual";
  const name = `${stamp}-${safeLabel}.json`;
  writeFileSync(path.join(backupDirectory, name), JSON.stringify(snapshot, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });
  return summarizeBackup(name, snapshot);
}

export function listBackups(): BackupSummary[] {
  if (!existsSync(backupDirectory)) return [];
  return readdirSync(backupDirectory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        const snapshot = JSON.parse(
          readFileSync(path.join(backupDirectory, name), "utf8"),
        ) as StoreSnapshot;
        validateSnapshot(snapshot);
        return summarizeBackup(name, snapshot);
      } catch (error) {
        return {
          name,
          createdAt: statSync(path.join(backupDirectory, name)).mtimeMs,
          entityCount: 0,
          relationCount: 0,
          error: error instanceof Error ? error.message : "Invalid backup",
        };
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function restoreBackup(name: string) {
  const restored = JSON.parse(
    readFileSync(path.join(backupDirectory, safeBackupName(name)), "utf8"),
  ) as StoreSnapshot;
  validateSnapshot(restored);
  createBackup("before-restore");
  const database = getDatabase();
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = readSnapshot();
    const restoredIds = new Set(restored.entities.map((entity) => entity.id));
    const tombstones = new Map(
      (current.tombstones || []).map((item) => [item.id, item]),
    );
    for (const id of restoredIds) tombstones.delete(id);
    for (const entity of current.entities) {
      if (!restoredIds.has(entity.id)) {
        tombstones.set(entity.id, { id: entity.id, deletedAt: Date.now() });
      }
    }
    const next: StoreSnapshot = {
      revision: current.revision + 1,
      entities: restored.entities,
      relations: restored.relations,
      tombstones: [...tombstones.values()],
      updatedAt: Date.now(),
    };
    replaceUnchecked(database, next);
    database.exec("COMMIT");
    return next;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateLegacyStore(database: DatabaseSync) {
  const current = readSnapshot();
  if (current.revision !== 0 || current.entities.length || !existsSync(legacyStorePath)) return;
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
    database.exec("COMMIT");
    createBackup("json-migration");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    console.error("Legacy store migration failed", error);
  }
}
