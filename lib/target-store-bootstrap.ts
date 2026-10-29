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

// v7 (issue #155) tracks monotonic per-Area task-content epochs for efficient,
// ACL-scoped cursor revisions. v8 (R2c.1) adds durable content-free task/project
// tombstones, the append-only trigger-written change log and the task delete
// audit. Older isolated staging stores are never migrated: preflight rejects
// them; use a NEW test-only staging directory instead.
export const TARGET_STORE_SCHEMA_VERSION = 8;
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
/**
 * R2c.1 task-delete receipts live in a SEPARATE metadata namespace with their
 * own cap (same value, counted independently): title and delete commands do not
 * starve each other, and total receipt metadata stays bounded (2 x 4096). The
 * cap is also bounded by the tombstone and delete-audit caps below.
 */
export const TARGET_STAGING_DELETE_RECEIPT_PREFIX = "r2:task-delete-receipt-v1:";
/** Per-table cap for task_tombstones and project_tombstones; fails closed. */
export const TARGET_STAGING_MAX_TOMBSTONES = 4096;
/** Provisional, isolated-staging audit policy; production retention is not approved. */
export const TARGET_STAGING_AUDIT_MAX_EVENTS = 4096;
export const TARGET_STAGING_AUDIT_RETENTION_DAYS = 90;
/**
 * R2-ID.1 durable staging sessions. A session is a short-lived server-side
 * credential for a synthetic test identity, stored only as a SHA-256 token hash.
 * Provisional staging limits; production lifetime and retention are not approved.
 */
export const TARGET_STAGING_SESSION_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const TARGET_STAGING_SESSION_MAX_ROWS = 4096;
export const TARGET_STAGING_SESSION_RETENTION_DAYS = 90;

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
-- Every table whose invariants rely on triggers is WITHOUT ROWID (or has an
-- INTEGER PRIMARY KEY alias guarded in BEFORE INSERT): INSERT OR REPLACE with an
-- explicit rowid would otherwise delete a different row without DELETE triggers.
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE identities (
  id TEXT PRIMARY KEY CHECK(length(trim(id)) > 0),
  -- Monotonic sign-out-everywhere counter. A durable session is live only while
  -- its issue-time epoch still equals this value.
  revocation_epoch INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revocation_epoch)='integer' AND revocation_epoch >= 0 AND revocation_epoch < 9007199254740991)
) WITHOUT ROWID;
-- Durable staging sessions (R2-ID.1). Only the SHA-256 hash of a random
-- 256-bit token is stored; the raw token is returned once at issuance and
-- cannot be recovered. A rowid-less PK prevents REPLACE through a hidden rowid.
CREATE TABLE staging_sessions (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  user_id TEXT NOT NULL REFERENCES identities(id),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms)='integer'
    AND expires_at_ms > created_at_ms
    AND expires_at_ms - created_at_ms <= ${TARGET_STAGING_SESSION_MAX_LIFETIME_MS}),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR (typeof(revoked_at_ms)='integer' AND revoked_at_ms > 0)),
  revocation_epoch INTEGER NOT NULL CHECK(typeof(revocation_epoch)='integer' AND revocation_epoch >= 0)
) WITHOUT ROWID;
CREATE INDEX staging_sessions_by_user ON staging_sessions(user_id);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('personal', 'shared')),
  owner_user_id TEXT NOT NULL REFERENCES identities(id),
  UNIQUE (id, kind, owner_user_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX one_personal_workspace_per_user ON workspaces(owner_user_id) WHERE kind = 'personal';

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  kind TEXT NOT NULL CHECK(kind IN ('private', 'shared')),
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  system_key TEXT CHECK(system_key IS NULL OR system_key = 'unassigned'),
  policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(policy_revision)='integer' AND policy_revision >= 0 AND policy_revision < 9007199254740991),
  content_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(content_revision)='integer' AND content_revision >= 0 AND content_revision < 9007199254740991),
  workspace_kind TEXT GENERATED ALWAYS AS (
    CASE kind WHEN 'private' THEN 'personal' ELSE 'shared' END
  ) STORED,
  FOREIGN KEY (workspace_id, workspace_kind, owner_user_id)
    REFERENCES workspaces(id, kind, owner_user_id),
  CHECK(kind = 'private' OR system_key IS NULL)
) WITHOUT ROWID;
-- At most one Area per shared workspace. An orphan workspace is a staging-only
-- intermediate state; R2 must validate a complete 1:1 mapping and active admin
-- membership before activation or any actor-accessible write.
CREATE UNIQUE INDEX one_area_per_shared_workspace ON areas(workspace_id) WHERE kind = 'shared';
CREATE UNIQUE INDEX one_private_unassigned_per_owner ON areas(owner_user_id)
  WHERE system_key = 'unassigned';
-- Cursor revision candidates must be selected by the current private owner,
-- without inspecting other users' Areas on every page.
CREATE INDEX areas_by_owner_kind ON areas(owner_user_id, kind);

CREATE TABLE area_members (
  area_id TEXT NOT NULL REFERENCES areas(id),
  user_id TEXT NOT NULL REFERENCES identities(id),
  role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'admin')),
  PRIMARY KEY(area_id, user_id)
) WITHOUT ROWID;
-- The primary key is Area-first. Listing an actor's shared Areas needs a
-- reverse lookup independent of all other users' memberships.
CREATE INDEX area_members_by_user_area ON area_members(user_id, area_id);
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
-- Contributing-Area EXISTS checks must seek by Area/project, not rehash tasks.
CREATE INDEX projects_by_area ON projects(area_id);
CREATE INDEX tasks_by_project_assignee ON tasks(project_id, assignee_user_id);
CREATE INDEX tasks_by_area_assignee ON tasks(area_id, assignee_user_id);

-- R2c.1 durable tombstones. A tombstone is the content-free proof that an opaque
-- task/project ID existed and was deleted: ID, Area at deletion, the revision
-- the deletion advanced the row to, the change_log sequence of its 'tombstone'
-- entry and a timestamp, never a title or other content. They are immutable
-- (no UPDATE), never deletable (no DELETE, not even after a retention window)
-- and replace-guarded in BEFORE INSERT (INSERT OR REPLACE skips DELETE triggers).
-- Rowid-less, so a hidden rowid cannot be used to replace a different row.
-- A tombstone may only be created for a LIVE row, at exactly revision + 1 and in
-- its current effective Area, and carries the change_log sequence which the
-- row's DELETE will receive next (see task_tombstones_consistency): the DELETE
-- is then the only thing that can complete it. Staging capacity fails closed.
CREATE TABLE task_tombstones (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision > 0 AND revision < 9007199254740991),
  change_seq INTEGER NOT NULL UNIQUE CHECK(typeof(change_seq)='integer' AND change_seq > 0),
  deleted_at_ms INTEGER NOT NULL CHECK(typeof(deleted_at_ms)='integer' AND deleted_at_ms > 0)
) WITHOUT ROWID;
CREATE TABLE project_tombstones (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision > 0 AND revision < 9007199254740991),
  change_seq INTEGER NOT NULL UNIQUE CHECK(typeof(change_seq)='integer' AND change_seq > 0),
  deleted_at_ms INTEGER NOT NULL CHECK(typeof(deleted_at_ms)='integer' AND deleted_at_ms > 0)
) WITHOUT ROWID;

-- R2c.1 append-only, content-free change log, the monotonic per-store sequence
-- for the R2c.2 feed. Rows are written ONLY by the triggers below, in the same
-- transaction as the change itself, so direct staging SQL is logged too. There
-- is no content column: tasks/projects carry only the opaque ID, Area and
-- revision, memberships only the Area, user ID and role after the change.
CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(typeof(seq)='integer' AND seq > 0),
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('task', 'project', 'membership')),
  entity_id TEXT NOT NULL,
  area_id TEXT NOT NULL REFERENCES areas(id),
  op TEXT NOT NULL CHECK(op IN ('upsert', 'leave', 'tombstone', 'member_add', 'member_remove', 'member_role')),
  revision INTEGER CHECK(revision IS NULL OR (typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991)),
  member_user_id TEXT REFERENCES identities(id),
  member_role TEXT CHECK(member_role IS NULL OR member_role IN ('viewer', 'editor', 'admin')),
  CHECK((entity_kind IN ('task', 'project') AND op IN ('upsert', 'leave', 'tombstone')
      AND revision IS NOT NULL AND member_user_id IS NULL AND member_role IS NULL)
    OR (entity_kind = 'membership' AND entity_id = area_id
      AND op IN ('member_add', 'member_remove', 'member_role')
      AND revision IS NULL AND member_user_id IS NOT NULL
      AND ((op = 'member_remove' AND member_role IS NULL) OR (op <> 'member_remove' AND member_role IS NOT NULL))))
);
-- The R2c.2 feed reads per Area in sequence order; tombstone entries are
-- countable cheaply by preflight.
CREATE INDEX change_log_by_area ON change_log(area_id, seq);
CREATE INDEX change_log_tombstones ON change_log(seq) WHERE op = 'tombstone';
-- Preflight reconciles the latest entry per entity with the live state; these
-- checks must be index-driven (latest upsert/tombstone of one task/project/membership).
CREATE INDEX change_log_by_entity ON change_log(entity_kind, entity_id, seq);
CREATE TRIGGER change_log_no_update BEFORE UPDATE ON change_log
BEGIN SELECT RAISE(ABORT, 'change log is append-only'); END;
CREATE TRIGGER change_log_no_delete BEFORE DELETE ON change_log
BEGIN SELECT RAISE(ABORT, 'change log is append-only'); END;
-- INSERT OR REPLACE deletes a row without DELETE triggers. In BEFORE INSERT NEW.seq
-- is the explicit value, or not a stored value (-1) when the ID is automatic.
CREATE TRIGGER change_log_replace_guard BEFORE INSERT ON change_log
WHEN EXISTS(SELECT 1 FROM change_log WHERE seq = NEW.seq)
BEGIN SELECT RAISE(ABORT, 'change log replacement is forbidden'); END;
-- Sequences strictly increase: an explicit seq must exceed every stored one
-- (automatic ones always do). Checked AFTER insert, once the final seq is known;
-- the statement rolls back as a whole.
CREATE TRIGGER change_log_monotonic AFTER INSERT ON change_log
WHEN EXISTS(SELECT 1 FROM change_log WHERE seq > NEW.seq)
BEGIN SELECT RAISE(ABORT, 'change log sequence must increase'); END;

CREATE TRIGGER task_tombstones_no_update BEFORE UPDATE ON task_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are immutable'); END;
CREATE TRIGGER task_tombstones_no_delete BEFORE DELETE ON task_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are permanent'); END;
CREATE TRIGGER task_tombstones_replace_guard BEFORE INSERT ON task_tombstones
WHEN EXISTS(SELECT 1 FROM task_tombstones WHERE id = NEW.id OR change_seq = NEW.change_seq)
BEGIN SELECT RAISE(ABORT, 'tombstone replacement is forbidden'); END;
-- change_seq is NOT a placeholder: it must be exactly the next change_log
-- sequence, which task_delete_log (AFTER DELETE ON tasks) then inserts
-- explicitly as this tombstone's change_seq. The monotonic check rejects the
-- DELETE if anything else was logged in between, so tombstone and log entry
-- cannot disagree; preflight re-verifies the pair for every tombstone.
CREATE TRIGGER task_tombstones_consistency BEFORE INSERT ON task_tombstones
WHEN NOT EXISTS(
    SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.id = NEW.id AND t.revision + 1 = NEW.revision
       AND COALESCE(t.area_id, p.area_id) = NEW.area_id)
  OR NEW.change_seq <> COALESCE((SELECT MAX(seq) FROM change_log), 0) + 1
BEGIN SELECT RAISE(ABORT, 'tombstone must match the deleted task and next change sequence'); END;
CREATE TRIGGER task_tombstones_capacity BEFORE INSERT ON task_tombstones
WHEN (SELECT COUNT(*) FROM task_tombstones) >= ${TARGET_STAGING_MAX_TOMBSTONES}
BEGIN SELECT RAISE(ABORT, 'tombstone capacity reached'); END;
CREATE TRIGGER project_tombstones_no_update BEFORE UPDATE ON project_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are immutable'); END;
CREATE TRIGGER project_tombstones_no_delete BEFORE DELETE ON project_tombstones
BEGIN SELECT RAISE(ABORT, 'tombstones are permanent'); END;
CREATE TRIGGER project_tombstones_replace_guard BEFORE INSERT ON project_tombstones
WHEN EXISTS(SELECT 1 FROM project_tombstones WHERE id = NEW.id OR change_seq = NEW.change_seq)
BEGIN SELECT RAISE(ABORT, 'tombstone replacement is forbidden'); END;
CREATE TRIGGER project_tombstones_consistency BEFORE INSERT ON project_tombstones
WHEN NOT EXISTS(
    SELECT 1 FROM projects p
     WHERE p.id = NEW.id AND p.revision + 1 = NEW.revision AND p.area_id = NEW.area_id)
  OR NEW.change_seq <> COALESCE((SELECT MAX(seq) FROM change_log), 0) + 1
BEGIN SELECT RAISE(ABORT, 'tombstone must match the deleted project and next change sequence'); END;
CREATE TRIGGER project_tombstones_capacity BEFORE INSERT ON project_tombstones
WHEN (SELECT COUNT(*) FROM project_tombstones) >= ${TARGET_STAGING_MAX_TOMBSTONES}
BEGIN SELECT RAISE(ABORT, 'tombstone capacity reached'); END;

-- Internal, content-free audit of committed title mutations only. The same
-- transaction writes the task, idempotency receipt and this row. No API is
-- exposed for reading historical data under a member's current Area ACL.
CREATE TABLE task_title_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  -- No FK to tasks: a deleted task (tombstone) keeps its content-free audit rows.
  task_id TEXT NOT NULL,
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

-- R2c.1 internal, content-free, append-only audit of committed task deletions.
-- Written in the same transaction as the tombstone, the DELETE, its change_log
-- entry and the idempotency receipt. task_id has no FK: the task row is gone.
CREATE TABLE task_delete_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  task_id TEXT NOT NULL,
  area_id TEXT NOT NULL REFERENCES areas(id),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision >= 0),
  revision_before INTEGER NOT NULL CHECK(typeof(revision_before)='integer' AND revision_before >= 0),
  tombstone_revision INTEGER NOT NULL CHECK(typeof(tombstone_revision)='integer' AND tombstone_revision = revision_before + 1),
  change_seq INTEGER NOT NULL CHECK(typeof(change_seq)='integer' AND change_seq > 0),
  expected_revision TEXT NOT NULL CHECK(length(expected_revision)=64),
  restore_generation TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms > 0)
);
CREATE INDEX task_delete_audit_task_sequence ON task_delete_audit(task_id, id);
CREATE TRIGGER task_delete_audit_no_update BEFORE UPDATE ON task_delete_audit
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER task_delete_audit_retention BEFORE DELETE ON task_delete_audit
WHEN strftime('%s','now') IS NULL OR OLD.committed_at_ms > (CAST(strftime('%s','now') AS INTEGER) * 1000 - ${TARGET_STAGING_AUDIT_RETENTION_DAYS} * 86400000)
BEGIN SELECT RAISE(ABORT, 'audit retention window is active'); END;
CREATE TRIGGER task_delete_audit_replace_guard BEFORE INSERT ON task_delete_audit
WHEN EXISTS(SELECT 1 FROM task_delete_audit WHERE id=NEW.id OR receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT, 'audit replacement is forbidden'); END;
CREATE TRIGGER task_delete_audit_capacity BEFORE INSERT ON task_delete_audit
WHEN (SELECT COUNT(*) FROM task_delete_audit) >= ${TARGET_STAGING_AUDIT_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'audit capacity reached'); END;

-- R2-ID.2a membership command ledger (staging only). A receipt is keyed by the
-- opaque SHA-256 of (actor, Area, command UUID); it stores only a payload digest
-- and the committed result, never task content. An exact retry returns the
-- stored result; a different payload under the same key is a conflict.
CREATE TABLE area_membership_receipts (
  receipt_key TEXT PRIMARY KEY CHECK(length(receipt_key) = 64 AND receipt_key NOT GLOB '*[^0-9a-f]*'),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('applied', 'noop')),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision >= 0),
  unassigned_tasks INTEGER NOT NULL CHECK(typeof(unassigned_tasks)='integer' AND unassigned_tasks >= 0),
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms > 0)
) WITHOUT ROWID;
CREATE TRIGGER area_membership_receipts_no_update BEFORE UPDATE ON area_membership_receipts
BEGIN SELECT RAISE(ABORT, 'membership receipts are immutable'); END;
CREATE TRIGGER area_membership_receipts_retention BEFORE DELETE ON area_membership_receipts
WHEN strftime('%s','now') IS NULL OR OLD.committed_at_ms > (CAST(strftime('%s','now') AS INTEGER) * 1000 - ${TARGET_STAGING_AUDIT_RETENTION_DAYS} * 86400000)
BEGIN SELECT RAISE(ABORT, 'membership receipt retention window is active'); END;
CREATE TRIGGER area_membership_receipts_replace_guard BEFORE INSERT ON area_membership_receipts
WHEN EXISTS(SELECT 1 FROM area_membership_receipts WHERE receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT, 'membership receipt replacement is forbidden'); END;
CREATE TRIGGER area_membership_receipts_capacity BEFORE INSERT ON area_membership_receipts
WHEN (SELECT COUNT(*) FROM area_membership_receipts) >= ${TARGET_STAGING_MAX_RECEIPTS}
BEGIN SELECT RAISE(ABORT, 'membership receipt capacity reached'); END;

-- Internal, content-free, append-only audit of committed membership changes
-- (no-ops are receipted but not audited). No read API exposes it.
CREATE TABLE area_membership_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE REFERENCES area_membership_receipts(receipt_key),
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  area_id TEXT NOT NULL REFERENCES areas(id),
  target_user_id TEXT NOT NULL REFERENCES identities(id),
  action TEXT NOT NULL CHECK(action IN ('add', 'remove', 'set_role')),
  role_before TEXT CHECK(role_before IS NULL OR role_before IN ('viewer', 'editor', 'admin')),
  role_after TEXT CHECK(role_after IS NULL OR role_after IN ('viewer', 'editor', 'admin')),
  policy_revision_before INTEGER NOT NULL CHECK(typeof(policy_revision_before)='integer' AND policy_revision_before >= 0),
  policy_revision_after INTEGER NOT NULL CHECK(typeof(policy_revision_after)='integer' AND policy_revision_after = policy_revision_before + 1),
  restore_generation TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms > 0),
  CHECK((action = 'add' AND role_before IS NULL AND role_after IS NOT NULL)
    OR (action = 'remove' AND role_before IS NOT NULL AND role_after IS NULL)
    OR (action = 'set_role' AND role_before IS NOT NULL AND role_after IS NOT NULL AND role_before <> role_after))
);
CREATE INDEX area_membership_audit_by_area ON area_membership_audit(area_id, id);
CREATE TRIGGER area_membership_audit_no_update BEFORE UPDATE ON area_membership_audit
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER area_membership_audit_retention BEFORE DELETE ON area_membership_audit
WHEN strftime('%s','now') IS NULL OR OLD.committed_at_ms > (CAST(strftime('%s','now') AS INTEGER) * 1000 - ${TARGET_STAGING_AUDIT_RETENTION_DAYS} * 86400000)
BEGIN SELECT RAISE(ABORT, 'audit retention window is active'); END;
CREATE TRIGGER area_membership_audit_replace_guard BEFORE INSERT ON area_membership_audit
WHEN EXISTS(SELECT 1 FROM area_membership_audit WHERE id=NEW.id OR receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT, 'audit replacement is forbidden'); END;
CREATE TRIGGER area_membership_audit_capacity BEFORE INSERT ON area_membership_audit
WHEN (SELECT COUNT(*) FROM area_membership_audit) >= ${TARGET_STAGING_AUDIT_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'audit capacity reached'); END;

-- A shared Area must keep at least one admin, even against raw SQL. REPLACE
-- bypasses DELETE triggers, so it is checked in BEFORE INSERT as well.
CREATE TRIGGER last_admin_delete_guard BEFORE DELETE ON area_members
WHEN OLD.role = 'admin' AND NOT EXISTS(
  SELECT 1 FROM area_members m WHERE m.area_id = OLD.area_id AND m.role = 'admin' AND m.user_id <> OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'a shared Area needs at least one admin'); END;
CREATE TRIGGER last_admin_demotion_guard BEFORE UPDATE OF role ON area_members
WHEN OLD.role = 'admin' AND NEW.role <> 'admin' AND NOT EXISTS(
  SELECT 1 FROM area_members m WHERE m.area_id = OLD.area_id AND m.role = 'admin' AND m.user_id <> OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'a shared Area needs at least one admin'); END;
CREATE TRIGGER last_admin_replace_guard BEFORE INSERT ON area_members
WHEN NEW.role <> 'admin' AND EXISTS(
  SELECT 1 FROM area_members o WHERE o.area_id = NEW.area_id AND o.user_id = NEW.user_id AND o.role = 'admin')
  AND NOT EXISTS(
  SELECT 1 FROM area_members m WHERE m.area_id = NEW.area_id AND m.role = 'admin' AND m.user_id <> NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'a shared Area needs at least one admin'); END;

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
-- Cursor epochs are incremented in the same transaction as every task change.
-- The existing task_revision_bump advances t.revision for changed list fields;
-- update the NEW effective Area exactly once when that revision advances,
-- including a direct SQL revision-only increment. A move between Areas also
-- invalidates the OLD effective Area (whose tasks have lost this row), and a
-- DELETE (task_delete_log) invalidates the Area the task left.
-- Separate triggers avoid the double bump caused by cascading revision UPDATEs.
--
-- The same triggers append the change_log entries (R2c.1), so each change logs
-- exactly once: INSERT -> one 'upsert'; every revision advance (the nested
-- UPDATE of task_revision_bump, or a direct increment) -> one 'upsert' in the
-- NEW effective Area; a move between Areas additionally -> one 'leave' for the
-- OLD Area from task_area_content_move_old. This move trigger runs BEFORE the
-- outer UPDATE, so its 'leave' is always recorded BEFORE any AFTER trigger
-- (including task_revision_bump's nested revision update) records the new Area's
-- 'upsert'. The move increments the task revision exactly once, so
-- OLD.revision + 1 is the revision of both events. The nested revision-only
-- UPDATE does not match "UPDATE OF project_id, area_id", preventing duplicates.
-- A task whose
-- project does not exist (no effective Area) is not logged, so the statement
-- still fails with its FOREIGN KEY error instead of a log constraint.
CREATE TRIGGER task_area_content_insert AFTER INSERT ON tasks
BEGIN
  UPDATE areas SET content_revision = content_revision + 1
    WHERE id = COALESCE(NEW.area_id, (SELECT area_id FROM projects WHERE id = NEW.project_id));
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    SELECT 'task', NEW.id, e.area_id, 'upsert', NEW.revision FROM (
      SELECT COALESCE(NEW.area_id, (SELECT area_id FROM projects WHERE id = NEW.project_id)) AS area_id
    ) e WHERE e.area_id IS NOT NULL;
END;
CREATE TRIGGER task_area_content_revision AFTER UPDATE OF revision ON tasks
WHEN NEW.revision IS NOT OLD.revision
BEGIN
  UPDATE areas SET content_revision = content_revision + 1
    WHERE id = COALESCE(NEW.area_id, (SELECT area_id FROM projects WHERE id = NEW.project_id));
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    SELECT 'task', NEW.id, e.area_id, 'upsert', NEW.revision FROM (
      SELECT COALESCE(NEW.area_id, (SELECT area_id FROM projects WHERE id = NEW.project_id)) AS area_id
    ) e WHERE e.area_id IS NOT NULL;
END;
-- BEFORE ensures a moved task's 'leave' precedes the new Area's 'upsert'
-- regardless of the firing order of independent AFTER UPDATE triggers.
CREATE TRIGGER task_area_content_move_old BEFORE UPDATE OF project_id, area_id ON tasks
WHEN COALESCE(OLD.area_id, (SELECT area_id FROM projects WHERE id = OLD.project_id))
  IS NOT COALESCE(NEW.area_id, (SELECT area_id FROM projects WHERE id = NEW.project_id))
BEGIN
  UPDATE areas SET content_revision = content_revision + 1
    WHERE id = COALESCE(OLD.area_id, (SELECT area_id FROM projects WHERE id = OLD.project_id));
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    VALUES ('task', OLD.id,
      COALESCE(OLD.area_id, (SELECT area_id FROM projects WHERE id = OLD.project_id)),
      'leave', OLD.revision + 1);
END;
-- A deletion is only possible after its tombstone exists (task_deletion_guard).
-- The log row takes the tombstone's pre-verified change_seq explicitly, so the
-- tombstone, the log entry and the DELETE can never disagree. The OLD Area's
-- cursor epoch advances in the same transaction: every page that contained the
-- task is invalidated.
CREATE TRIGGER task_delete_log AFTER DELETE ON tasks
BEGIN
  INSERT INTO change_log(seq, entity_kind, entity_id, area_id, op, revision)
    SELECT ts.change_seq, 'task', ts.id, ts.area_id, 'tombstone', ts.revision
      FROM task_tombstones ts WHERE ts.id = OLD.id;
  UPDATE areas SET content_revision = content_revision + 1
    WHERE id = (SELECT area_id FROM task_tombstones WHERE id = OLD.id);
END;
-- Projects: every insert/revision advance is an 'upsert'. A project Area move is
-- forbidden today (project_area_assignment_guard); this trigger exists so that,
-- IF the guard is ever lifted by a confirmed move command, the move is logged
-- for the project AND each child task (their effective Area changes although
-- their revision does not: current revisions are recorded) and both Areas'
-- cursor epochs advance exactly once.
CREATE TRIGGER project_change_log_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    VALUES ('project', NEW.id, NEW.area_id, 'upsert', NEW.revision);
END;
CREATE TRIGGER project_change_log_revision AFTER UPDATE OF revision ON projects
WHEN NEW.revision IS NOT OLD.revision
BEGIN
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    VALUES ('project', NEW.id, NEW.area_id, 'upsert', NEW.revision);
END;
CREATE TRIGGER project_change_log_move AFTER UPDATE OF area_id ON projects
WHEN NEW.area_id <> OLD.area_id
BEGIN
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    VALUES ('project', OLD.id, OLD.area_id, 'leave', NEW.revision);
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    VALUES ('project', NEW.id, NEW.area_id, 'upsert', NEW.revision);
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    SELECT 'task', t.id, OLD.area_id, 'leave', t.revision FROM tasks t
     WHERE t.project_id = NEW.id ORDER BY t.rowid;
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    SELECT 'task', t.id, NEW.area_id, 'upsert', t.revision FROM tasks t
     WHERE t.project_id = NEW.id ORDER BY t.rowid;
  UPDATE areas SET content_revision = content_revision + 1 WHERE id = OLD.area_id;
  UPDATE areas SET content_revision = content_revision + 1 WHERE id = NEW.area_id;
END;
CREATE TRIGGER project_delete_log AFTER DELETE ON projects
BEGIN
  INSERT INTO change_log(seq, entity_kind, entity_id, area_id, op, revision)
    SELECT ts.change_seq, 'project', ts.id, ts.area_id, 'tombstone', ts.revision
      FROM project_tombstones ts WHERE ts.id = OLD.id;
  UPDATE areas SET content_revision = content_revision + 1
    WHERE id = (SELECT area_id FROM project_tombstones WHERE id = OLD.id);
END;
CREATE TRIGGER area_policy_member_insert AFTER INSERT ON area_members
BEGIN
  UPDATE areas SET policy_revision = policy_revision + 1 WHERE id = NEW.area_id;
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, member_user_id, member_role)
    VALUES ('membership', NEW.area_id, NEW.area_id, 'member_add', NEW.user_id, NEW.role);
END;
CREATE TRIGGER area_policy_member_delete AFTER DELETE ON area_members
BEGIN
  UPDATE areas SET policy_revision = policy_revision + 1 WHERE id = OLD.area_id;
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, member_user_id, member_role)
    VALUES ('membership', OLD.area_id, OLD.area_id, 'member_remove', OLD.user_id, NULL);
END;
CREATE TRIGGER area_policy_member_role AFTER UPDATE OF role ON area_members
WHEN NEW.role IS NOT OLD.role
BEGIN
  UPDATE areas SET policy_revision = policy_revision + 1 WHERE id = NEW.area_id;
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, member_user_id, member_role)
    VALUES ('membership', NEW.area_id, NEW.area_id, 'member_role', NEW.user_id, NEW.role);
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
CREATE TRIGGER area_content_revision_guard BEFORE UPDATE OF content_revision ON areas
WHEN NEW.content_revision <> OLD.content_revision + 1
BEGIN SELECT RAISE(ABORT, 'Area content revision must increment by one'); END;
-- tasks stays a rowid table (the read model orders by rowid as a tie-break), so an
-- explicit rowid which collides with a DIFFERENT task must be rejected as well.
-- A tombstoned ID is never reusable: re-creating it would reset the revision
-- (ABA) and resurrect a deleted task for clients holding the tombstone.
CREATE TRIGGER task_conflict_guard BEFORE INSERT ON tasks
WHEN EXISTS(SELECT 1 FROM tasks WHERE id = NEW.id)
  OR EXISTS(SELECT 1 FROM tasks WHERE rowid = NEW.rowid)
  OR EXISTS(SELECT 1 FROM task_tombstones WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'task replacement is not allowed'); END;
-- In a BEFORE INSERT trigger NEW.rowid is -1 whenever no rowid was supplied, so
-- the guard above cannot tell an automatic rowid from an explicit -1, and a stored
-- row with rowid -1 would make every later automatic insert collide with it
-- (self-DoS). Automatic rowids are always >= 1: reject any explicit rowid <= 0
-- AFTER insertion (the statement rolls back as a whole).
CREATE TRIGGER task_rowid_positive AFTER INSERT ON tasks
WHEN NEW.rowid <= 0
BEGIN SELECT RAISE(ABORT, 'task rowid must be positive'); END;
-- UPDATE OR REPLACE tasks SET rowid=<other> would delete the other task without
-- task_deletion_guard (REPLACE does not fire DELETE triggers). Rowids are fixed.
CREATE TRIGGER task_rowid_immutable BEFORE UPDATE ON tasks
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT, 'task rowid is immutable'); END;
-- A same-ID replacement can also be staged by renaming the original task's
-- primary key, then inserting a new row with revision 0 under its old ID.
-- Tombstones now exist, but a rename would still bypass them: the old ID would
-- be freed without a tombstone and the new one never was tombstoned. IDs stay fixed.
CREATE TRIGGER immutable_task_id BEFORE UPDATE OF id ON tasks
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'task ID is immutable (renaming would bypass tombstones)'); END;
-- A task may be deleted only after its tombstone exists at exactly the next
-- revision, in the task's current effective Area. A plain delete + insert would
-- otherwise reset revision 0 and allow ABA; the tombstone also forbids ID reuse.
CREATE TRIGGER task_deletion_guard BEFORE DELETE ON tasks
WHEN NOT EXISTS(
  SELECT 1 FROM task_tombstones ts
   WHERE ts.id = OLD.id AND ts.revision = OLD.revision + 1
     AND ts.area_id = COALESCE(OLD.area_id, (SELECT area_id FROM projects WHERE id = OLD.project_id)))
BEGIN SELECT RAISE(ABORT, 'task deletion requires tombstone protocol'); END;
-- Project ID recycling would reset the epoch and could revive an old cursor.
-- Same rule as tasks; additionally a project with tasks is never deleted. There
-- is no project delete command yet: this is the raw-SQL boundary only.
CREATE TRIGGER project_deletion_guard BEFORE DELETE ON projects
WHEN NOT EXISTS(
  SELECT 1 FROM project_tombstones ts
   WHERE ts.id = OLD.id AND ts.revision = OLD.revision + 1 AND ts.area_id = OLD.area_id)
  OR EXISTS(SELECT 1 FROM tasks WHERE project_id = OLD.id)
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
) OR EXISTS(SELECT 1 FROM project_tombstones WHERE id = NEW.id)
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
-- Tombstones exist, but a rename would still bypass their ID-reuse protection.
CREATE TRIGGER immutable_project_id BEFORE UPDATE OF id ON projects
WHEN NEW.id <> OLD.id
BEGIN SELECT RAISE(ABORT, 'project ID is immutable in R1'); END;
-- Never recycle an Area ID/epoch while cursors can still reference it.
-- Area deletion requires a future tombstone protocol and revision redesign.
CREATE TRIGGER area_deletion_guard BEFORE DELETE ON areas
BEGIN SELECT RAISE(ABORT, 'Area deletion requires tombstone protocol'); END;
CREATE TRIGGER protected_private_fallback BEFORE DELETE ON areas
WHEN OLD.system_key = 'unassigned'
BEGIN SELECT RAISE(ABORT, 'cannot delete private Unassigned'); END;

-- Identity epoch and durable session guards (R2-ID.1). Revocation is one-way:
-- a revoked session cannot be revived, an epoch cannot decrease, and a session
-- cannot be re-pointed at another user, token or lifetime.
CREATE TRIGGER immutable_identity_id BEFORE UPDATE OF id ON identities
WHEN NEW.id <> OLD.id
BEGIN SELECT RAISE(ABORT, 'identity ID is immutable in R1'); END;
CREATE TRIGGER identity_conflict_guard BEFORE INSERT ON identities
WHEN EXISTS(SELECT 1 FROM identities WHERE id = NEW.id) OR NEW.revocation_epoch <> 0
BEGIN SELECT RAISE(ABORT, 'identity replacement is not allowed'); END;
-- Deleting then re-inserting an identity would reset its epoch to 0 and could
-- resurrect sessions revoked by sign-out-everywhere; this holds even with
-- foreign_keys OFF, where the session FK would not block the delete.
CREATE TRIGGER identity_deletion_guard BEFORE DELETE ON identities
BEGIN SELECT RAISE(ABORT, 'identity deletion requires tombstone protocol'); END;
CREATE TRIGGER identity_revocation_epoch_guard BEFORE UPDATE OF revocation_epoch ON identities
WHEN NEW.revocation_epoch <> OLD.revocation_epoch + 1
BEGIN SELECT RAISE(ABORT, 'revocation epoch must increment by one'); END;
CREATE TRIGGER staging_session_conflict_guard BEFORE INSERT ON staging_sessions
WHEN EXISTS(SELECT 1 FROM staging_sessions WHERE id = NEW.id OR token_hash = NEW.token_hash)
  OR NEW.revoked_at_ms IS NOT NULL
  OR NEW.revocation_epoch <> (SELECT revocation_epoch FROM identities WHERE id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'session replacement or stale issuance is not allowed'); END;
CREATE TRIGGER staging_session_capacity BEFORE INSERT ON staging_sessions
WHEN (SELECT COUNT(*) FROM staging_sessions) >= ${TARGET_STAGING_SESSION_MAX_ROWS}
BEGIN SELECT RAISE(ABORT, 'session capacity reached'); END;
CREATE TRIGGER staging_session_immutable BEFORE UPDATE OF id, user_id, token_hash, created_at_ms, expires_at_ms, revocation_epoch ON staging_sessions
BEGIN SELECT RAISE(ABORT, 'session identity, token and lifetime are immutable'); END;
CREATE TRIGGER staging_session_no_unrevoke BEFORE UPDATE OF revoked_at_ms ON staging_sessions
WHEN OLD.revoked_at_ms IS NOT NULL OR NEW.revoked_at_ms IS NULL
BEGIN SELECT RAISE(ABORT, 'session revocation is irreversible'); END;
-- Deleting a revoked row would erase the revocation; only long-expired rows
-- may be removed (provisional retention, not an automatic purge).
CREATE TRIGGER staging_session_retention BEFORE DELETE ON staging_sessions
WHEN strftime('%s','now') IS NULL OR OLD.expires_at_ms > (CAST(strftime('%s','now') AS INTEGER) * 1000 - ${TARGET_STAGING_SESSION_RETENTION_DAYS} * 86400000)
BEGIN SELECT RAISE(ABORT, 'session retention window is active'); END;
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
