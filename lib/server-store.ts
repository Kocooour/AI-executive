import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
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
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  chmodSync(dataDirectory, 0o700);
  const database = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
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
    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      actor_hash TEXT NOT NULL,
      details TEXT NOT NULL
    );
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
  const challengeColumns = database
    .prepare("PRAGMA table_info(passkey_challenges)")
    .all()
    .map((row) => String((row as { name?: string }).name));
  if (!challengeColumns.includes("binding")) {
    database.exec(
      "ALTER TABLE passkey_challenges ADD COLUMN binding TEXT NOT NULL DEFAULT ''",
    );
  }
  for (const sqliteCompanion of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(sqliteCompanion)) chmodSync(sqliteCompanion, 0o600);
  }
  migrateLegacyStore(database);
  ensureDefaultWorkspace(database);
  return database;
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

function summarizeBackup(name: string, snapshot: StoreSnapshot): BackupSummary {
  return {
    name,
    createdAt: statSync(path.join(backupDirectory, name)).mtimeMs,
    entityCount: snapshot.entities.length,
      relationCount: snapshot.relations.length,
  };
}

export function createBackup(label = "manual") {
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  const snapshot = readSnapshot();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = label.replace(/[^a-z-]/gi, "").toLowerCase() || "manual";
  const name = `${stamp}-${safeLabel}.json`;
  writeFileSync(path.join(backupDirectory, name), JSON.stringify(snapshot, null, 2), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    const backups = readdirSync(backupDirectory)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        const backupPath = path.join(backupDirectory, entry);
        chmodSync(backupPath, 0o600);
        return { entry, modifiedAt: statSync(backupPath).mtimeMs };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    const retentionClass = (entry: string) => {
      if (entry.endsWith("-daily.json")) return "daily";
      if (entry.endsWith("-manual.json")) return "manual";
      if (
        entry.endsWith("-before-restore.json") ||
        entry.endsWith("-json-migration.json") ||
        entry.endsWith("-pre-sqlite.json")
      ) {
        return "safety";
      }
      return "other";
    };
    const limits: Record<string, number> = { daily: 30, manual: 20, safety: 20, other: 10 };
    const seen: Record<string, number> = { daily: 0, manual: 0, safety: 0, other: 0 };
    const expired = backups.filter(({ entry }) => {
      const category = retentionClass(entry);
      seen[category] += 1;
      return seen[category] > limits[category];
    });
    for (const backup of expired) unlinkSync(path.join(backupDirectory, backup.entry));
  } catch (error) {
    console.error("Backup retention cleanup failed", error);
  }
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
      entities: restored.entities.some(
        (entity) => entity.id === "workspace:personal",
      )
        ? restored.entities
        : [defaultWorkspaceEntity(), ...restored.entities],
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
