/**
 * R1-only, explicitly invoked bootstrap for a NEW isolated target SQLite store.
 *
 * This file is deliberately not wired to startup, requests, the legacy store or Dexie.
 * It never opens, migrates, resets, or copies the current production database.
 * R2 must provide authenticated, per-item server commands before this store is used.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-dir";

export const TARGET_STORE_SCHEMA_VERSION = 4;
export const TARGET_STORE_FILENAME = "lumi-target.sqlite";
/**
 * Staging-only R2 receipt namespace in the existing metadata table. No schema
 * migration or production activation: receipts are committed atomically with
 * their task mutation and are scoped by authenticated actor, task and command ID.
 */
// Actor-only receipts from #138 cannot prove their original task ACL. Old staging
// databases intentionally fail preflight; recreate test-only staging stores.
export const TARGET_STAGING_RECEIPT_PREFIX = "r2:task-title-receipt-v2:";
export const TARGET_STAGING_MAX_RECEIPTS = 4096;
/** Provisional, isolated-staging audit policy; production retention is not approved. */
export const TARGET_STAGING_AUDIT_MAX_EVENTS = 4096;
export const TARGET_STAGING_AUDIT_RETENTION_DAYS = 90;

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

/**
 * Walk components in filesystem order. path.resolve (and realpathSync on a whole
 * path) normalize `link/..` before following `link`, which can change its meaning.
 * Preserve a non-existing suffix for the legacy directory without creating it.
 */
function canonicalProspectivePath(input: string): string {
  if (!path.isAbsolute(input)) throw new Error("Cannot resolve a safe staging path");
  let current = path.parse(input).root;
  for (const part of input.slice(current.length).split(path.sep)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, part);
    try {
      lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = next;
      continue;
    }
    // A dangling symlink must fail closed, not appear absent.
    current = realpathSync(next);
  }
  return current;
}

function rejectLegacyOverlap(destination: string): void {
  const production = canonicalProspectivePath(resolveDataDirectory());
  if (containsPath(production, destination) || containsPath(destination, production)) {
    throw new Error("R1 staging directory overlaps the current legacy data directory");
  }
}

/** Existing-directory counterpart used by the read-only preflight. */
export function verifyExistingTargetStagingPath(stagingDirectory: string): string {
  if (typeof stagingDirectory !== "string" || !path.isAbsolute(stagingDirectory)) {
    throw new Error("R1 staging directory must be absolute");
  }
  if (!statSync(stagingDirectory).isDirectory()) throw new Error("R1 staging path is not a directory");
  const destination = canonicalProspectivePath(stagingDirectory);
  rejectLegacyOverlap(destination);
  return destination;
}

/**
 * Deliberately accepts no existing directory. This fails closed even if the existing
 * directory is an abandoned bootstrap: recovery requires a new staging directory.
 */
export function verifyTargetStagingPath(stagingDirectory: string): string {
  if (typeof stagingDirectory !== "string" || !path.isAbsolute(stagingDirectory)) {
    throw new Error("R1 staging directory must be absolute");
  }
  // A missing component before `..` still makes the requested parent unusable;
  // do not silently create a different normalized destination instead.
  if (!existsSync(path.dirname(stagingDirectory))) throw new Error("R1 staging parent does not exist");
  const destination = canonicalProspectivePath(stagingDirectory);
  if (existsSync(destination)) throw new Error("R1 staging directory already exists");
  // Require its actual immediate parent to exist; never invent a directory tree.
  if (!existsSync(path.dirname(destination))) throw new Error("R1 staging parent does not exist");
  rejectLegacyOverlap(destination);
  return destination;
}

export const TARGET_SCHEMA_SQL = `
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
  policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(policy_revision)='integer' AND policy_revision >= 0 AND policy_revision < 9007199254740991),
  workspace_kind TEXT GENERATED ALWAYS AS (
    CASE kind WHEN 'private' THEN 'personal' ELSE 'shared' END
  ) STORED,
  FOREIGN KEY (workspace_id, workspace_kind, owner_user_id)
    REFERENCES workspaces(id, kind, owner_user_id),
  CHECK(kind = 'private' OR system_key IS NULL)
);
-- At most one Area per shared workspace. An orphan workspace is a staging-only
-- intermediate state; R2 must validate a complete 1:1 mapping and active admin
-- membership before activation or any actor-accessible write.
CREATE UNIQUE INDEX one_area_per_shared_workspace ON areas(workspace_id) WHERE kind = 'shared';
CREATE UNIQUE INDEX one_private_unassigned_per_owner ON areas(owner_user_id)
  WHERE system_key = 'unassigned';

CREATE TABLE area_members (
  area_id TEXT NOT NULL REFERENCES areas(id),
  user_id TEXT NOT NULL REFERENCES identities(id),
  role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'admin')),
  PRIMARY KEY(area_id, user_id)
);
-- A rowid-less PK prevents INSERT/UPDATE OR REPLACE from silently deleting a
-- different project through a hidden rowid collision (DELETE triggers may not fire).
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991)
) WITHOUT ROWID;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  area_id TEXT REFERENCES areas(id),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  assignee_user_id TEXT REFERENCES identities(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991),
  CHECK ((project_id IS NULL AND area_id IS NOT NULL) OR (project_id IS NOT NULL AND area_id IS NULL))
);
CREATE INDEX tasks_by_project ON tasks(project_id);
CREATE INDEX tasks_by_area ON tasks(area_id);

-- Internal, content-free audit of committed title mutations only. The same
-- transaction writes the task, idempotency receipt and this row. No API is
-- exposed for reading historical data under a member's current Area ACL.
CREATE TABLE task_title_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  area_id TEXT NOT NULL REFERENCES areas(id),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision >= 0),
  revision_before INTEGER NOT NULL CHECK(typeof(revision_before)='integer' AND revision_before >= 0),
  revision_after INTEGER NOT NULL CHECK(typeof(revision_after)='integer' AND revision_after = revision_before + 1),
  expected_revision TEXT NOT NULL CHECK(length(expected_revision)=64),
  restore_generation TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms > 0)
);
CREATE INDEX task_title_audit_task_sequence ON task_title_audit(task_id, id);
-- Rows may be removed only after the provisional 90-day minimum. This is not
-- an automatic purge or a production maximum-retention policy.
CREATE TRIGGER task_title_audit_no_update BEFORE UPDATE ON task_title_audit
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER task_title_audit_retention BEFORE DELETE ON task_title_audit
WHEN strftime('%s','now') IS NULL OR OLD.committed_at_ms > (CAST(strftime('%s','now') AS INTEGER) * 1000 - ${TARGET_STAGING_AUDIT_RETENTION_DAYS} * 86400000)
BEGIN SELECT RAISE(ABORT, 'audit retention window is active'); END;
-- SQLite REPLACE can bypass DELETE triggers; check every unique conflict
-- before insertion, including an explicitly supplied rowid.
CREATE TRIGGER task_title_audit_replace_guard BEFORE INSERT ON task_title_audit
WHEN EXISTS(SELECT 1 FROM task_title_audit WHERE id=NEW.id OR receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT, 'audit replacement is forbidden'); END;
CREATE TRIGGER task_title_audit_capacity BEFORE INSERT ON task_title_audit
WHEN (SELECT COUNT(*) FROM task_title_audit) >= ${TARGET_STAGING_AUDIT_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'audit capacity reached'); END;

CREATE VIEW task_effective_areas AS
  SELECT t.id AS task_id, COALESCE(t.area_id, p.area_id) AS effective_area_id,
         t.assignee_user_id AS assignee_user_id
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id;

-- Monotonic task and Area-policy epochs are maintained by SQLite, including
-- direct staging SQL changes. They make a reverted title/ACL policy (ABA)
-- distinguishable from the original state. Unrelated task changes cannot
-- invalidate a task's edit revision.
CREATE TRIGGER task_revision_bump AFTER UPDATE OF title, project_id, area_id, assignee_user_id ON tasks
WHEN NEW.title IS NOT OLD.title OR NEW.project_id IS NOT OLD.project_id
  OR NEW.area_id IS NOT OLD.area_id OR NEW.assignee_user_id IS NOT OLD.assignee_user_id
BEGIN
  UPDATE tasks SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
-- Project title ABA must advance a durable per-row epoch, even with direct staging SQL.
CREATE TRIGGER project_revision_bump AFTER UPDATE OF title ON projects
WHEN NEW.title IS NOT OLD.title
BEGIN
  UPDATE projects SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
CREATE TRIGGER area_policy_member_insert AFTER INSERT ON area_members
BEGIN
  UPDATE areas SET policy_revision = policy_revision + 1 WHERE id = NEW.area_id;
END;
CREATE TRIGGER area_policy_member_delete AFTER DELETE ON area_members
BEGIN
  UPDATE areas SET policy_revision = policy_revision + 1 WHERE id = OLD.area_id;
END;
CREATE TRIGGER area_policy_member_role AFTER UPDATE OF role ON area_members
WHEN NEW.role IS NOT OLD.role
BEGIN
  UPDATE areas SET policy_revision = policy_revision + 1 WHERE id = NEW.area_id;
END;

-- Guard monotonicity against manual counter resets and the SQLite REPLACE
-- behavior that otherwise deletes/reinserts a same-ID task with revision 0.
CREATE TRIGGER task_revision_guard BEFORE UPDATE OF revision ON tasks
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'task revision must increment by one'); END;
CREATE TRIGGER project_revision_guard BEFORE UPDATE OF revision ON projects
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'project revision must increment by one'); END;
CREATE TRIGGER area_policy_revision_guard BEFORE UPDATE OF policy_revision ON areas
WHEN NEW.policy_revision <> OLD.policy_revision + 1
BEGIN SELECT RAISE(ABORT, 'Area policy revision must increment by one'); END;
CREATE TRIGGER task_conflict_guard BEFORE INSERT ON tasks
WHEN EXISTS(SELECT 1 FROM tasks WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'task replacement is not allowed'); END;
-- A same-ID replacement can also be staged by renaming the original task's
-- primary key, then inserting a new row with revision 0 under its old ID.
-- Keep task identity stable until durable ID tombstones exist.
CREATE TRIGGER immutable_task_id BEFORE UPDATE OF id ON tasks
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'task ID is immutable until tombstones exist'); END;
-- Until deletion tombstones are available, do not allow task IDs to be
-- recycled: a delete + insert would reset revision 0 and allow ABA.
CREATE TRIGGER task_deletion_guard BEFORE DELETE ON tasks
BEGIN SELECT RAISE(ABORT, 'task deletion requires tombstone protocol'); END;
-- Project ID recycling would reset the epoch and could revive an old cursor.
CREATE TRIGGER project_deletion_guard BEFORE DELETE ON projects
BEGIN SELECT RAISE(ABORT, 'project deletion requires tombstone protocol'); END;

-- INSERT OR REPLACE deletes conflicting rows without invoking DELETE triggers when
-- recursive_triggers is OFF (SQLite's default). Reject boundary replacements in
-- BEFORE INSERT, including conflicts on alternate unique indexes.
CREATE TRIGGER workspace_conflict_guard BEFORE INSERT ON workspaces
WHEN EXISTS(SELECT 1 FROM workspaces WHERE id = NEW.id)
  OR (NEW.kind = 'personal' AND EXISTS(
    SELECT 1 FROM workspaces WHERE owner_user_id = NEW.owner_user_id AND kind = 'personal'))
BEGIN SELECT RAISE(ABORT, 'workspace replacement is not allowed in R1'); END;
CREATE TRIGGER area_conflict_guard BEFORE INSERT ON areas
WHEN EXISTS(SELECT 1 FROM areas WHERE id = NEW.id)
  OR (NEW.kind = 'shared' AND EXISTS(
    SELECT 1 FROM areas WHERE workspace_id = NEW.workspace_id AND kind = 'shared'))
  OR (NEW.system_key = 'unassigned' AND EXISTS(
    SELECT 1 FROM areas WHERE owner_user_id = NEW.owner_user_id AND system_key = 'unassigned'))
BEGIN SELECT RAISE(ABORT, 'Area replacement is not allowed in R1'); END;
CREATE TRIGGER member_conflict_guard BEFORE INSERT ON area_members
WHEN EXISTS(
  SELECT 1 FROM area_members m
  WHERE m.area_id = NEW.area_id AND m.user_id = NEW.user_id
    AND m.role IN ('editor','admin') AND NEW.role = 'viewer'
    AND EXISTS(SELECT 1 FROM task_effective_areas t
      WHERE t.effective_area_id = m.area_id AND t.assignee_user_id = m.user_id)
)
BEGIN SELECT RAISE(ABORT, 'unassign tasks before downgrading membership'); END;
CREATE TRIGGER project_conflict_guard BEFORE INSERT ON projects
WHEN EXISTS(
  SELECT 1 FROM projects p WHERE p.id = NEW.id AND p.area_id <> NEW.area_id
)
BEGIN SELECT RAISE(ABORT, 'project move requires R2 confirmation'); END;
CREATE TRIGGER project_replacement_guard BEFORE INSERT ON projects
WHEN EXISTS(
  SELECT 1 FROM projects p WHERE p.id = NEW.id AND p.area_id = NEW.area_id
)
BEGIN SELECT RAISE(ABORT, 'project replacement is not allowed'); END;

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
WHEN NEW.area_id <> OLD.area_id
BEGIN SELECT RAISE(ABORT, 'project move requires R2 confirmation'); END;
CREATE TRIGGER member_revocation_guard BEFORE DELETE ON area_members
WHEN EXISTS(
  SELECT 1 FROM task_effective_areas t
  WHERE t.effective_area_id = OLD.area_id AND t.assignee_user_id = OLD.user_id
)
BEGIN SELECT RAISE(ABORT, 'unassign tasks before removing membership'); END;
CREATE TRIGGER member_identity_or_area_move_guard BEFORE UPDATE OF area_id, user_id ON area_members
WHEN NEW.area_id <> OLD.area_id OR NEW.user_id <> OLD.user_id
BEGIN SELECT RAISE(ABORT, 'membership identity is immutable in R1'); END;
CREATE TRIGGER member_role_downgrade_guard BEFORE UPDATE OF role ON area_members
WHEN NEW.role = 'viewer' AND OLD.role IN ('editor','admin') AND EXISTS(
  SELECT 1 FROM task_effective_areas t
  WHERE t.effective_area_id = OLD.area_id AND t.assignee_user_id = OLD.user_id
)
BEGIN SELECT RAISE(ABORT, 'unassign tasks before downgrading membership'); END;
CREATE TRIGGER immutable_area_boundary BEFORE UPDATE OF kind, workspace_id, owner_user_id, system_key ON areas
BEGIN SELECT RAISE(ABORT, 'Area security boundary is immutable in R1'); END;
CREATE TRIGGER immutable_area_id BEFORE UPDATE OF id ON areas
WHEN NEW.id <> OLD.id
BEGIN SELECT RAISE(ABORT, 'Area ID is immutable in R1'); END;
CREATE TRIGGER immutable_workspace_boundary BEFORE UPDATE OF kind, owner_user_id ON workspaces
BEGIN SELECT RAISE(ABORT, 'workspace security boundary is immutable in R1'); END;
CREATE TRIGGER immutable_workspace_id BEFORE UPDATE OF id ON workspaces
WHEN NEW.id <> OLD.id
BEGIN SELECT RAISE(ABORT, 'workspace ID is immutable in R1'); END;
CREATE TRIGGER immutable_project_id BEFORE UPDATE OF id ON projects
WHEN NEW.id <> OLD.id
BEGIN SELECT RAISE(ABORT, 'project ID is immutable in R1'); END;
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
      if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("R1 foreign-key validation failed");
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
