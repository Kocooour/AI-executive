/**
 * R1-only, explicitly invoked bootstrap for a NEW isolated target SQLite store.
 *
 * This file is deliberately not wired to startup, requests, the legacy store or Dexie.
 * It never opens, migrates, resets, or copies the current production database.
 * R2 must provide authenticated, per-item server commands before this store is used.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-dir";

export const TARGET_STORE_SCHEMA_VERSION = 1;
export const TARGET_STORE_FILENAME = "lumi-target.sqlite";

export interface TargetStoreBootstrapOptions {
  /** Absolute path for a directory which MUST NOT exist yet. Its parent must exist. */
  stagingDirectory: string;
  /** A stable, explicitly chosen local owner identity. Not an auth/session token. */
  ownerUserId: string;
}

export interface TargetStoreBootstrapResult {
  directory: string;
  databasePath: string;
  ownerUserId: string;
  personalWorkspaceId: string;
  unassignedAreaId: string;
  restoreGeneration: string;
  schemaVersion: number;
}

function containsPath(ancestor: string, candidate: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

/** Resolve the nearest existing parent before comparing symlink-aware paths. */
function canonicalProspectivePath(input: string): string {
  const absolute = path.resolve(input);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error("Cannot resolve a safe staging path");
  return path.join(canonicalProspectivePath(parent), path.basename(absolute));
}

/**
 * Deliberately accepts no existing directory. This fails closed even if the existing
 * directory is an abandoned bootstrap: recovery requires a new staging directory.
 */
export function verifyTargetStagingPath(stagingDirectory: string): string {
  if (typeof stagingDirectory !== "string" || !path.isAbsolute(stagingDirectory)) {
    throw new Error("R1 staging directory must be absolute");
  }
  // A lexical alias or existing symlink must never be accepted as an empty new directory.
  if (existsSync(stagingDirectory)) throw new Error("R1 staging directory already exists");
  const directory = path.resolve(stagingDirectory);
  // Require its immediate parent to exist, so mkdir cannot invent a directory tree.
  const parent = realpathSync(path.dirname(directory));
  const destination = path.join(parent, path.basename(directory));
  const production = canonicalProspectivePath(resolveDataDirectory());
  if (containsPath(production, destination) || containsPath(destination, production)) {
    throw new Error("R1 staging directory overlaps the current legacy data directory");
  }
  if (existsSync(destination)) throw new Error("R1 staging directory already exists");
  return destination;
}

const TARGET_SCHEMA_SQL = `
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE identities (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0)
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('personal', 'shared')),
  owner_user_id TEXT NOT NULL REFERENCES identities(id),
  UNIQUE (id, kind, owner_user_id)
);
CREATE UNIQUE INDEX one_personal_workspace_per_user ON workspaces(owner_user_id) WHERE kind = 'personal';

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  kind TEXT NOT NULL CHECK(kind IN ('private', 'shared')),
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  system_key TEXT CHECK(system_key IS NULL OR system_key = 'unassigned'),
  workspace_kind TEXT GENERATED ALWAYS AS (
    CASE kind WHEN 'private' THEN 'personal' ELSE 'shared' END
  ) STORED,
  FOREIGN KEY (workspace_id, workspace_kind, owner_user_id)
    REFERENCES workspaces(id, kind, owner_user_id),
  CHECK(kind = 'private' OR system_key IS NULL)
);
CREATE UNIQUE INDEX one_area_per_shared_workspace ON areas(workspace_id) WHERE kind = 'shared';
CREATE UNIQUE INDEX one_private_unassigned_per_owner ON areas(owner_user_id)
  WHERE system_key = 'unassigned';

CREATE TABLE area_members (
  area_id TEXT NOT NULL REFERENCES areas(id),
  user_id TEXT NOT NULL REFERENCES identities(id),
  role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'admin')),
  PRIMARY KEY(area_id, user_id)
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  area_id TEXT REFERENCES areas(id),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  assignee_user_id TEXT REFERENCES identities(id),
  CHECK ((project_id IS NULL AND area_id IS NOT NULL) OR (project_id IS NOT NULL AND area_id IS NULL))
);
CREATE INDEX tasks_by_project ON tasks(project_id);
CREATE INDEX tasks_by_area ON tasks(area_id);
CREATE VIEW task_effective_areas AS
  SELECT t.id AS task_id, COALESCE(t.area_id, p.area_id) AS effective_area_id,
         t.assignee_user_id AS assignee_user_id
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id;

CREATE TRIGGER shared_members_only_insert BEFORE INSERT ON area_members
WHEN NOT EXISTS(SELECT 1 FROM areas WHERE id = NEW.area_id AND kind = 'shared')
BEGIN SELECT RAISE(ABORT, 'membership requires a shared area'); END;
CREATE TRIGGER shared_members_only_update BEFORE UPDATE OF area_id ON area_members
WHEN NOT EXISTS(SELECT 1 FROM areas WHERE id = NEW.area_id AND kind = 'shared')
BEGIN SELECT RAISE(ABORT, 'membership requires a shared area'); END;

CREATE TRIGGER task_assignee_insert BEFORE INSERT ON tasks
WHEN NEW.assignee_user_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM areas a JOIN area_members m ON m.area_id = a.id
   WHERE a.id = COALESCE(NEW.area_id, (SELECT area_id FROM projects WHERE id = NEW.project_id))
     AND a.kind = 'shared' AND m.user_id = NEW.assignee_user_id AND m.role IN ('editor','admin')
)
BEGIN SELECT RAISE(ABORT, 'assignee must be a shared-area editor or admin'); END;
CREATE TRIGGER task_assignee_update BEFORE UPDATE ON tasks
WHEN NEW.assignee_user_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM areas a JOIN area_members m ON m.area_id = a.id
   WHERE a.id = COALESCE(NEW.area_id, (SELECT area_id FROM projects WHERE id = NEW.project_id))
     AND a.kind = 'shared' AND m.user_id = NEW.assignee_user_id AND m.role IN ('editor','admin')
)
BEGIN SELECT RAISE(ABORT, 'assignee must be a shared-area editor or admin'); END;
CREATE TRIGGER project_area_assignment_guard BEFORE UPDATE OF area_id ON projects
WHEN EXISTS(
  SELECT 1 FROM tasks t WHERE t.project_id = NEW.id AND t.assignee_user_id IS NOT NULL
    AND NOT EXISTS(
      SELECT 1 FROM areas a JOIN area_members m ON m.area_id = a.id
      WHERE a.id = NEW.area_id AND a.kind = 'shared'
        AND m.user_id = t.assignee_user_id AND m.role IN ('editor','admin')
    )
)
BEGIN SELECT RAISE(ABORT, 'project move would invalidate an assignee'); END;
CREATE TRIGGER member_revocation_guard BEFORE DELETE ON area_members
WHEN EXISTS(
  SELECT 1 FROM task_effective_areas t
  WHERE t.effective_area_id = OLD.area_id AND t.assignee_user_id = OLD.user_id
)
BEGIN SELECT RAISE(ABORT, 'unassign tasks before removing membership'); END;
CREATE TRIGGER member_role_downgrade_guard BEFORE UPDATE OF role ON area_members
WHEN NEW.role = 'viewer' AND OLD.role IN ('editor','admin') AND EXISTS(
  SELECT 1 FROM task_effective_areas t
  WHERE t.effective_area_id = OLD.area_id AND t.assignee_user_id = OLD.user_id
)
BEGIN SELECT RAISE(ABORT, 'unassign tasks before downgrading membership'); END;
CREATE TRIGGER immutable_area_boundary BEFORE UPDATE OF kind, workspace_id, owner_user_id, system_key ON areas
BEGIN SELECT RAISE(ABORT, 'Area security boundary is immutable in R1'); END;
CREATE TRIGGER immutable_workspace_boundary BEFORE UPDATE OF kind, owner_user_id ON workspaces
BEGIN SELECT RAISE(ABORT, 'workspace security boundary is immutable in R1'); END;
CREATE TRIGGER protected_private_fallback BEFORE DELETE ON areas
WHEN OLD.system_key = 'unassigned'
BEGIN SELECT RAISE(ABORT, 'cannot delete private Unassigned'); END;
`;

/**
 * Create a stage-only schema and initial private 'Nezařazeno' Area. Explicit caller
 * approval to *create a new directory* is distinct from permission for cutover.
 *
 * There is intentionally NO API for loading legacy snapshots or promoting this DB.
 */
export function bootstrapIsolatedTargetStore(
  options: TargetStoreBootstrapOptions,
): TargetStoreBootstrapResult {
  const owner = options.ownerUserId;
  if (typeof owner !== "string" || owner.length > 120 || !/^[A-Za-z0-9_.:@-]+$/.test(owner)) {
    throw new Error("R1 bootstrap requires a nonempty, stable owner user ID");
  }
  const directory = verifyTargetStagingPath(options.stagingDirectory);
  mkdirSync(directory, { mode: 0o700 });
  const databasePath = path.join(directory, TARGET_STORE_FILENAME);
  const personalWorkspaceId = `workspace:personal:${owner}`;
  const unassignedAreaId = `area:unassigned:${owner}`;
  const restoreGeneration = randomUUID();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
    try {
      db.exec(TARGET_SCHEMA_SQL);
      const meta = db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
      meta.run("schema_version", String(TARGET_STORE_SCHEMA_VERSION));
      meta.run("write_protocol", "per-item-only");
      meta.run("activated", "false");
      meta.run("restore_generation", restoreGeneration);
      db.prepare("INSERT INTO identities(id) VALUES (?)").run(owner);
      db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?, 'personal', ?)")
        .run(personalWorkspaceId, owner);
      db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?, 'Nezařazeno', 'private', ?, ?, 'unassigned')")
        .run(unassignedAreaId, personalWorkspaceId, owner);
      if (db.pragma("foreign_key_check").length !== 0) throw new Error("R1 foreign-key validation failed");
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
  return {
    directory, databasePath, ownerUserId: owner, personalWorkspaceId,
    unassignedAreaId, restoreGeneration, schemaVersion: TARGET_STORE_SCHEMA_VERSION,
  };
}
