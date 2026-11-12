/**
 * R1-only, explicitly invoked bootstrap for a NEW isolated target SQLite store.
 *
 * This file is deliberately not wired to startup, requests, the legacy store or Dexie.
 * It never opens, migrates, resets, or copies the current production database.
 * R2 must provide authenticated, per-item server commands before this store is used.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, writeSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-dir";
import { TARGET_STAGING_JOURNAL_FILENAME, targetStagingJournalGenesis } from "./target-staging-anchor-journal";
import { bootstrapTargetStagingWitness } from "./target-staging-anchor-witness";

// v7 (issue #155) tracks monotonic per-Area task-content epochs for efficient,
// ACL-scoped cursor revisions. v8 (R2c.1) adds durable content-free task/project
// tombstones, the append-only trigger-written change log and the task delete
// audit. Older isolated staging stores are never migrated: preflight rejects
// them; use a NEW test-only staging directory instead. v9 (R2c.2b) adds the
// change_log commit timestamp, the own-membership index and the monotonic
// compaction floor with its guarded delete (no v8 migration, same rule). v10
// (R2c.4a) adds the monotonic anti-rollback anchor `anchor_seq` (mirrored by the
// append-only lumi-target.journal next to the database; no v9 migration, same rule). v11
// (R2c.4b) adds the append-only restore bookkeeping: the generation history and the sessions a
// restore superseded (the 401 code `session_restored`); no v10 migration, same rule.
// v12 (R2d.1b) adds a per-Area monotonic project-content epoch so project
// pagination never hashes all project rows. Existing staging v11 stores are
// deliberately NOT migrated; recreate a new isolated staging directory.
// v13 (R2d.2b) adds bounded, parent-exclusive notes with immutable IDs and
// monotonic revisions; old staging v12 stores are never migrated.
// v16 (R2d.2c.2f.2) adds immutable, receipt-backed note-delete audit.
// v17 (R2d.2c.2g.2b.1) adds immutable note-specific audit-triggered journal.
// Old staging v16 stores are deliberately rejected, never auto-migrated.
// v18 adds an Area-local monotonic note change witness for safe journal reads.
// Older isolated staging stores are rejected, not migrated.
// v19 adds audit-backed create/reparent/Area-move note journal entries.
// v20 (R2d.3d) adds checked task completion state, completion timestamp
// and an ISO calendar due date. These are shared task fields, distinct from
// actor-private today/when planning. Every metadata change bumps the existing
// task revision, Area content epoch and change feed atomically.
// v19 staging stores are rejected, never migrated; no HTTP/UI activation.
// v21 (R2d.3k.1) adds actor-private when_on plan rows, bounded independently
// and versioned by user-specific epochs, never through the shared task/Area log.
// Older staging stores are rejected, not silently migrated; no activation.
// v22 (R2d.5b.1) adds actor-private Attention lifecycle state (snooze/dismiss)
// with its own per-user epoch. Older staging stores are rejected, not migrated.
// v23 (R2d.5d.1) adds identity-bound push foundation: per-user notification
// settings (zone, quiet window, default-OFF), hashed device targets and a
// per-user announcement ledger. No sender; older stores are rejected.
// v25 reserves the original per-delivery target cohort atomically with a claim.
// A reserved target is unattempted (attempts=0) and is safe to resume after a
// crash. An explicit in-flight marker is committed BEFORE calling the sender;
// only an interrupted in-flight send becomes unknown (never retried).
// As with other schema revisions, old staging stores are intentionally rejected.
export const TARGET_STORE_SCHEMA_VERSION = 26;
export const TARGET_STORE_LEGACY_SCHEMA_VERSION = 25;
export const isSupportedTargetSchemaVersion = (value: unknown): boolean =>
  value === String(TARGET_STORE_SCHEMA_VERSION) || value === String(TARGET_STORE_LEGACY_SCHEMA_VERSION);
/** Capacities of the v23 push foundation in a fresh isolated store. */
export const TARGET_STAGING_MAX_PUSH_TARGETS = 4096;
export const TARGET_STAGING_MAX_PUSH_TARGETS_PER_USER = 64;
export const TARGET_STAGING_MAX_ATTENTION_DELIVERIES = 8192;
export const TARGET_STAGING_MAX_DEVICE_DELIVERIES = 32768;
/** Maximum active actor-private planned-day rows in a fresh isolated store. */
export const TARGET_STAGING_MAX_PERSONAL_PLANS = 4096;
/** Maximum actor-private Attention lifecycle rows in a fresh isolated store. */
export const TARGET_STAGING_MAX_ATTENTION_STATES = 4096;
/** Staging-only cap on live notes. */
export const TARGET_STAGING_MAX_NOTES = 4096;
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
/** Staging-only actor+command receipt for private standalone task CREATE. */
export const TARGET_STAGING_PRIVATE_TASK_CREATE_RECEIPT_PREFIX = "r3:private-task-create-receipt-v1:";
/** Content-free, actor+command keyed lookup for private CREATE recovery after reload.
 * Values contain only internal IDs and restore generation, never a task title. */
export const TARGET_STAGING_PRIVATE_TASK_CREATE_RECOVERY_PREFIX = "r3:private-task-create-recovery-v1:";
/** Actor-scoped immutable no-commit cancellation fence (same pinned lock as CREATE). */
export const TARGET_STAGING_PRIVATE_TASK_CREATE_CANCEL_PREFIX = "r3:private-task-create-cancel-v1:";
/** Actor-scoped receipt and content-free witness for private project / project-child CREATE. */
export const TARGET_STAGING_PRIVATE_STRUCTURE_CREATE_RECEIPT_PREFIX = "r3:private-structure-create-receipt-v1:";
export const TARGET_STAGING_PRIVATE_STRUCTURE_CREATE_RECOVERY_PREFIX = "r3:private-structure-create-recovery-v1:";
/** Maximum UTF-8 bytes of a content-free project/task CREATE recovery witness.
 * Existing project IDs allow up to 512 UTF-8 bytes; JSON escaping can double
 * their encoded size (quotes, backslashes, unpaired surrogates). 2048 also
 * covers all fixed fields and the maximum 120-byte Area ID. */
export const TARGET_STAGING_PRIVATE_STRUCTURE_CREATE_WITNESS_MAX_BYTES = 2048;
/** R2d.3h staging-only complete/reopen receipts; audited by the append-only anchor journal. */
export const TARGET_STAGING_TEMPORAL_STATUS_RECEIPT_PREFIX = "r2:task-temporal-status-receipt-v1:";
/** R2d.3i.1 isolated task dueOn mutation receipts; capped independently from status writes. */
export const TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX = "r2:task-temporal-due-on-receipt-v1:";
/** Actor-private whenOn receipts, kept separate from shared dueOn writes. */
export const TARGET_STAGING_PERSONAL_WHEN_RECEIPT_PREFIX = "r2:task-personal-when-receipt-v1:";
/** Actor-private Attention snooze/dismiss/restore receipts; capped independently. */
export const TARGET_STAGING_PERSONAL_ATTENTION_RECEIPT_PREFIX = "r2:task-personal-attention-receipt-v1:";
/** R2d.5d.2 personal notification settings receipts (actor-private, content-free hashes). */
export const TARGET_STAGING_PERSONAL_NOTIFICATION_RECEIPT_PREFIX = "r2:personal-notification-settings-receipt-v1:";
/** R2d.5d.2 push target register/revoke receipts (actor-private, content-free hashes). */
export const TARGET_STAGING_PERSONAL_PUSH_TARGET_RECEIPT_PREFIX = "r2:personal-push-target-receipt-v1:";
/** R2d.5d.2 per-identity push baseline marker: key suffix = sha256(user id), at most one per identity. */
export const TARGET_STAGING_PUSH_BASELINE_PREFIX = "r2:push-baseline:";
/** Actor/note/command-scoped staging note edit confirmations; never note content. */
export const TARGET_STAGING_NOTE_RECEIPT_PREFIX = "r2:note-edit-receipt-v1:";
/** Isolated actor/note/command receipts for the irreversible note deletion. */
export const TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX = "r2:note-delete-receipt-v1:";
/** Staging-only create/move receipts; never note titles or bodies. */
export const TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX = "r2:note-lifecycle-receipt-v1:";
/** R3 project-title cancellation fences: content-free, irreversible across reloads. */
export const TARGET_STAGING_PROJECT_TITLE_CANCEL_PREFIX = "r3:project-title-cancel-v1:";
/** Per-table cap for task, project and note tombstones; fails closed. */
export const TARGET_STAGING_MAX_TOMBSTONES = 4096;
/** Provisional, isolated-staging audit policy; production retention is not approved. */
export const TARGET_STAGING_AUDIT_MAX_EVENTS = 4096;
/** Maximum authenticated note edit + delete events in the isolated staging journal. */
export const TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS = 8192;
export const TARGET_STAGING_AUDIT_RETENTION_DAYS = 90;
/**
 * R2-ID.1 durable staging sessions. A session is a short-lived server-side
 * credential for a synthetic test identity, stored only as a SHA-256 token hash.
 * Provisional staging limits; production lifetime and retention are not approved.
 */
export const TARGET_STAGING_SESSION_MAX_LIFETIME_MS = 15 * 60 * 1000;
export const TARGET_STAGING_SESSION_MAX_ROWS = 4096;
export const TARGET_STAGING_SESSION_RETENTION_DAYS = 90;
/** R2c.4b staging bounds of the append-only restore bookkeeping tables. */
export const TARGET_STAGING_RESTORE_HISTORY_MAX = 256;
export const TARGET_STAGING_SUPERSEDED_SESSIONS_MAX = 16384;

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

export const TARGET_SCHEMA_V25_SQL = `
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
  project_content_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(project_content_revision)='integer' AND project_content_revision >= 0 AND project_content_revision < 9007199254740991),
  note_sync_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(note_sync_revision)='integer' AND note_sync_revision >= 0 AND note_sync_revision < 9007199254740991),
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
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
  completed_at_ms INTEGER DEFAULT NULL CHECK (
    completed_at_ms IS NULL OR
    (typeof(completed_at_ms)='integer' AND completed_at_ms >= 0
      AND completed_at_ms <= 9007199254740991)),
  -- Shared calendar deadline only. Personal today/when is actor-scoped and
  -- deliberately NOT stored on the shared task row.
  due_on TEXT DEFAULT NULL CHECK (
    due_on IS NULL OR
    (typeof(due_on)='text' AND length(due_on)=10 AND
      due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
      COALESCE(date(due_on, '+0 days')=due_on, 0))),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991),
  CHECK ((project_id IS NULL AND area_id IS NOT NULL) OR (project_id IS NOT NULL AND area_id IS NULL)),
  CHECK ((status='open' AND completed_at_ms IS NULL)
    OR (status='completed' AND completed_at_ms IS NOT NULL))
);
CREATE INDEX tasks_by_due_on_status ON tasks(due_on,status,id)
  WHERE due_on IS NOT NULL;

-- v21: actor-private planned day. Not a task column, shared Area epoch or
-- change-feed event. One monotonic cursor epoch for each identity.
CREATE TABLE personal_plan_epochs (
  user_id TEXT PRIMARY KEY REFERENCES identities(id),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991)
) WITHOUT ROWID;
CREATE TRIGGER personal_plan_epoch_on_identity AFTER INSERT ON identities BEGIN
  INSERT INTO personal_plan_epochs(user_id) VALUES (NEW.id);
END;
CREATE TRIGGER personal_plan_epoch_immutable BEFORE UPDATE OF user_id ON personal_plan_epochs
BEGIN SELECT RAISE(ABORT,'plan epoch user immutable'); END;
CREATE TRIGGER personal_plan_epoch_monotonic BEFORE UPDATE OF revision ON personal_plan_epochs
WHEN NEW.revision <> OLD.revision+1
BEGIN SELECT RAISE(ABORT,'plan epoch must increment by one'); END;
CREATE TRIGGER personal_plan_epoch_no_replace BEFORE INSERT ON personal_plan_epochs
WHEN EXISTS(SELECT 1 FROM personal_plan_epochs WHERE user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'plan epoch replacement forbidden'); END;
CREATE TRIGGER personal_plan_epoch_no_delete BEFORE DELETE ON personal_plan_epochs
BEGIN SELECT RAISE(ABORT,'plan epoch deletion forbidden'); END;

CREATE TABLE personal_task_plans (
  user_id TEXT NOT NULL REFERENCES identities(id),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  when_on TEXT NOT NULL CHECK(
    typeof(when_on)='text' AND length(when_on)=10 AND
    when_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
    CAST(substr(when_on,1,4) AS INTEGER) BETWEEN 1 AND 9999 AND
    COALESCE(date(when_on,'+0 days')=when_on,0)),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991),
  PRIMARY KEY(user_id,task_id)
) WITHOUT ROWID;
CREATE INDEX personal_task_plans_by_day ON personal_task_plans(user_id,when_on,task_id);
CREATE TRIGGER personal_task_plan_insert_guard BEFORE INSERT ON personal_task_plans
WHEN NOT EXISTS (
  SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
    JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
    LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=NEW.user_id
   WHERE t.id=NEW.task_id AND t.status='open' AND
    ((a.kind='private' AND a.owner_user_id=NEW.user_id) OR
     (a.kind='shared' AND t.assignee_user_id=NEW.user_id AND m.role IN ('editor','admin')))
)
BEGIN SELECT RAISE(ABORT,'plan requires owned or assigned editable task'); END;
CREATE TRIGGER personal_task_plan_update_guard BEFORE UPDATE ON personal_task_plans
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.task_id IS NOT OLD.task_id OR
  NOT EXISTS (
    SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
      JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
      LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=NEW.user_id
     WHERE t.id=NEW.task_id AND t.status='open' AND
       ((a.kind='private' AND a.owner_user_id=NEW.user_id) OR
        (a.kind='shared' AND t.assignee_user_id=NEW.user_id AND m.role IN ('editor','admin')))
  )
BEGIN SELECT RAISE(ABORT,'plan owner or task ACL invalid'); END;
CREATE TRIGGER personal_task_plan_revision_guard BEFORE UPDATE OF revision ON personal_task_plans
WHEN NEW.revision <> OLD.revision+1
BEGIN SELECT RAISE(ABORT,'plan revision must increment by one'); END;
CREATE TRIGGER personal_task_plan_no_replace BEFORE INSERT ON personal_task_plans
WHEN EXISTS(SELECT 1 FROM personal_task_plans WHERE user_id=NEW.user_id AND task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT,'plan replacement forbidden'); END;
CREATE TRIGGER personal_task_plan_capacity BEFORE INSERT ON personal_task_plans
WHEN (SELECT COUNT(*) FROM personal_task_plans) >= 4096
BEGIN SELECT RAISE(ABORT,'plan capacity reached'); END;
CREATE TRIGGER personal_task_plan_insert_epoch AFTER INSERT ON personal_task_plans BEGIN
  UPDATE personal_plan_epochs SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER personal_task_plan_update_epoch AFTER UPDATE OF when_on ON personal_task_plans
WHEN NEW.when_on IS NOT OLD.when_on
BEGIN
  UPDATE personal_task_plans SET revision=OLD.revision+1
    WHERE user_id=NEW.user_id AND task_id=NEW.task_id;
  UPDATE personal_plan_epochs SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER personal_task_plan_delete_epoch AFTER DELETE ON personal_task_plans BEGIN
  UPDATE personal_plan_epochs SET revision=revision+1 WHERE user_id=OLD.user_id;
END;
-- Revoked assignment or completed task must not resurrect stale personal plan.
CREATE TRIGGER personal_task_plan_task_reconcile AFTER UPDATE OF
  assignee_user_id,status,project_id,area_id ON tasks
BEGIN
  DELETE FROM personal_task_plans WHERE task_id=NEW.id AND
    (NEW.status<>'open' OR NOT EXISTS (
      SELECT 1 FROM areas a LEFT JOIN area_members m
        ON m.area_id=a.id AND m.user_id=personal_task_plans.user_id
       WHERE a.id=COALESCE(NEW.area_id,
         (SELECT area_id FROM projects WHERE id=NEW.project_id))
         AND ((a.kind='private' AND a.owner_user_id=personal_task_plans.user_id)
           OR (a.kind='shared' AND NEW.assignee_user_id=personal_task_plans.user_id
               AND m.role IN ('editor','admin')))
    ));
END;
CREATE TRIGGER personal_task_plan_membership_delete AFTER DELETE ON area_members BEGIN
  DELETE FROM personal_task_plans WHERE user_id=OLD.user_id
    AND task_id IN (SELECT task_id FROM task_effective_areas
      WHERE effective_area_id=OLD.area_id);
END;
CREATE TRIGGER personal_task_plan_membership_downgrade AFTER UPDATE OF role ON area_members
WHEN NEW.role='viewer' AND OLD.role IN ('editor','admin')
BEGIN
  DELETE FROM personal_task_plans WHERE user_id=NEW.user_id
    AND task_id IN (SELECT task_id FROM task_effective_areas
      WHERE effective_area_id=NEW.area_id);
END;
-- Project moves remain forbidden, but future code must not retain plans after
-- an authorized change to inherited Area.
CREATE TRIGGER personal_task_plan_project_move AFTER UPDATE OF area_id ON projects
WHEN NEW.area_id IS NOT OLD.area_id
BEGIN
  DELETE FROM personal_task_plans WHERE task_id IN (
    SELECT t.id FROM tasks t WHERE t.project_id=NEW.id AND NOT EXISTS (
      SELECT 1 FROM areas a LEFT JOIN area_members m
        ON m.area_id=a.id AND m.user_id=personal_task_plans.user_id
       WHERE a.id=NEW.area_id AND
         ((a.kind='private' AND a.owner_user_id=personal_task_plans.user_id)
         OR (a.kind='shared' AND t.assignee_user_id=personal_task_plans.user_id
             AND m.role IN ('editor','admin')))
    ));
END;

-- v22 (R2d.5b.1): actor-private Attention lifecycle. Absence of a row means
-- "active"; resolved/superseded are derived (the candidate no longer exists and
-- reconcile triggers delete the row). Separate epoch so snoozing never
-- invalidates My Plan paging. Never part of shared task/Area epochs or log.
CREATE TABLE personal_attention_epochs (
  user_id TEXT PRIMARY KEY REFERENCES identities(id),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991)
) WITHOUT ROWID;
CREATE TRIGGER personal_attention_epoch_on_identity AFTER INSERT ON identities BEGIN
  INSERT INTO personal_attention_epochs(user_id) VALUES (NEW.id);
END;
CREATE TRIGGER personal_attention_epoch_immutable BEFORE UPDATE OF user_id ON personal_attention_epochs
BEGIN SELECT RAISE(ABORT,'attention epoch user immutable'); END;
CREATE TRIGGER personal_attention_epoch_monotonic BEFORE UPDATE OF revision ON personal_attention_epochs
WHEN NEW.revision <> OLD.revision+1
BEGIN SELECT RAISE(ABORT,'attention epoch must increment by one'); END;
CREATE TRIGGER personal_attention_epoch_no_replace BEFORE INSERT ON personal_attention_epochs
WHEN EXISTS(SELECT 1 FROM personal_attention_epochs WHERE user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'attention epoch replacement forbidden'); END;
CREATE TRIGGER personal_attention_epoch_no_delete BEFORE DELETE ON personal_attention_epochs
BEGIN SELECT RAISE(ABORT,'attention epoch deletion forbidden'); END;

CREATE TABLE personal_attention_states (
  user_id TEXT NOT NULL REFERENCES identities(id),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL CHECK(rule_id IN ('deadline_overdue','deadline_soon','planned_date_passed')),
  occurrence_on TEXT NOT NULL CHECK(
    typeof(occurrence_on)='text' AND length(occurrence_on)=10 AND
    occurrence_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
    CAST(substr(occurrence_on,1,4) AS INTEGER) BETWEEN 1 AND 9999 AND
    COALESCE(date(occurrence_on,'+0 days')=occurrence_on,0)),
  state TEXT NOT NULL CHECK(state IN ('snoozed','dismissed')),
  snoozed_until_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991),
  PRIMARY KEY(user_id,task_id,rule_id,occurrence_on),
  CHECK((state='snoozed' AND typeof(snoozed_until_ms)='integer'
         AND snoozed_until_ms > 0 AND snoozed_until_ms <= 9007199254740991)
     OR (state='dismissed' AND snoozed_until_ms IS NULL))
) WITHOUT ROWID;
CREATE INDEX personal_attention_states_by_task ON personal_attention_states(user_id,task_id);
CREATE TRIGGER personal_attention_state_insert_guard BEFORE INSERT ON personal_attention_states
WHEN NEW.revision IS NOT 0 OR NOT EXISTS (
  SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
    JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
    LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=NEW.user_id
   WHERE t.id=NEW.task_id AND t.status='open' AND
    ((a.kind='private' AND a.owner_user_id=NEW.user_id) OR
     (a.kind='shared' AND t.assignee_user_id=NEW.user_id AND m.role IN ('editor','admin')))
    AND ((NEW.rule_id IN ('deadline_overdue','deadline_soon') AND t.due_on = NEW.occurrence_on)
      OR (NEW.rule_id='planned_date_passed' AND EXISTS (
        SELECT 1 FROM personal_task_plans pl WHERE pl.user_id=NEW.user_id
          AND pl.task_id=NEW.task_id AND pl.when_on=NEW.occurrence_on)))
)
BEGIN SELECT RAISE(ABORT,'attention state requires eligible task occurrence'); END;
CREATE TRIGGER personal_attention_state_update_guard BEFORE UPDATE ON personal_attention_states
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.task_id IS NOT OLD.task_id OR
  NEW.rule_id IS NOT OLD.rule_id OR NEW.occurrence_on IS NOT OLD.occurrence_on OR
  NOT EXISTS (
    SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
      JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
      LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=NEW.user_id
     WHERE t.id=NEW.task_id AND t.status='open' AND
      ((a.kind='private' AND a.owner_user_id=NEW.user_id) OR
       (a.kind='shared' AND t.assignee_user_id=NEW.user_id AND m.role IN ('editor','admin')))
      AND ((NEW.rule_id IN ('deadline_overdue','deadline_soon') AND t.due_on = NEW.occurrence_on)
        OR (NEW.rule_id='planned_date_passed' AND EXISTS (
          SELECT 1 FROM personal_task_plans pl WHERE pl.user_id=NEW.user_id
            AND pl.task_id=NEW.task_id AND pl.when_on=NEW.occurrence_on)))
  )
BEGIN SELECT RAISE(ABORT,'attention state identity or task ACL invalid'); END;
CREATE TRIGGER personal_attention_state_revision_guard BEFORE UPDATE OF revision ON personal_attention_states
WHEN NEW.revision <> OLD.revision+1
BEGIN SELECT RAISE(ABORT,'attention state revision must increment by one'); END;
CREATE TRIGGER personal_attention_state_no_replace BEFORE INSERT ON personal_attention_states
WHEN EXISTS(SELECT 1 FROM personal_attention_states WHERE user_id=NEW.user_id
  AND task_id=NEW.task_id AND rule_id=NEW.rule_id AND occurrence_on=NEW.occurrence_on)
BEGIN SELECT RAISE(ABORT,'attention state replacement forbidden'); END;
CREATE TRIGGER personal_attention_state_capacity BEFORE INSERT ON personal_attention_states
WHEN (SELECT COUNT(*) FROM personal_attention_states) >= 4096
BEGIN SELECT RAISE(ABORT,'attention state capacity reached'); END;
CREATE TRIGGER personal_attention_state_insert_epoch AFTER INSERT ON personal_attention_states BEGIN
  UPDATE personal_attention_epochs SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER personal_attention_state_update_epoch AFTER UPDATE OF state,snoozed_until_ms ON personal_attention_states
WHEN NEW.state IS NOT OLD.state OR NEW.snoozed_until_ms IS NOT OLD.snoozed_until_ms
BEGIN
  UPDATE personal_attention_states SET revision=OLD.revision+1
    WHERE user_id=NEW.user_id AND task_id=NEW.task_id
      AND rule_id=NEW.rule_id AND occurrence_on=NEW.occurrence_on;
  UPDATE personal_attention_epochs SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER personal_attention_state_delete_epoch AFTER DELETE ON personal_attention_states BEGIN
  UPDATE personal_attention_epochs SET revision=revision+1 WHERE user_id=OLD.user_id;
END;
-- Reconcile: resolved (task completed), lost access and superseded occurrences
-- delete the state; re-assignment or re-planning never restores it.
CREATE TRIGGER personal_attention_state_task_reconcile AFTER UPDATE OF
  assignee_user_id,status,project_id,area_id ON tasks
BEGIN
  DELETE FROM personal_attention_states WHERE task_id=NEW.id AND
    (NEW.status<>'open' OR NOT EXISTS (
      SELECT 1 FROM areas a LEFT JOIN area_members m
        ON m.area_id=a.id AND m.user_id=personal_attention_states.user_id
       WHERE a.id=COALESCE(NEW.area_id,
         (SELECT area_id FROM projects WHERE id=NEW.project_id))
         AND ((a.kind='private' AND a.owner_user_id=personal_attention_states.user_id)
           OR (a.kind='shared' AND NEW.assignee_user_id=personal_attention_states.user_id
               AND m.role IN ('editor','admin')))
    ));
END;
CREATE TRIGGER personal_attention_state_due_reconcile AFTER UPDATE OF due_on ON tasks
WHEN NEW.due_on IS NOT OLD.due_on
BEGIN
  DELETE FROM personal_attention_states WHERE task_id=NEW.id
    AND rule_id IN ('deadline_overdue','deadline_soon')
    AND occurrence_on IS NOT NEW.due_on;
END;
CREATE TRIGGER personal_attention_state_plan_reconcile AFTER UPDATE OF when_on ON personal_task_plans
WHEN NEW.when_on IS NOT OLD.when_on
BEGIN
  DELETE FROM personal_attention_states WHERE user_id=NEW.user_id AND task_id=NEW.task_id
    AND rule_id='planned_date_passed' AND occurrence_on<>NEW.when_on;
END;
CREATE TRIGGER personal_attention_state_plan_delete AFTER DELETE ON personal_task_plans
BEGIN
  DELETE FROM personal_attention_states WHERE user_id=OLD.user_id AND task_id=OLD.task_id
    AND rule_id='planned_date_passed';
END;
CREATE TRIGGER personal_attention_state_membership_delete AFTER DELETE ON area_members BEGIN
  DELETE FROM personal_attention_states WHERE user_id=OLD.user_id
    AND task_id IN (SELECT task_id FROM task_effective_areas
      WHERE effective_area_id=OLD.area_id);
END;
CREATE TRIGGER personal_attention_state_membership_downgrade AFTER UPDATE OF role ON area_members
WHEN NEW.role='viewer' AND OLD.role IN ('editor','admin')
BEGIN
  DELETE FROM personal_attention_states WHERE user_id=NEW.user_id
    AND task_id IN (SELECT task_id FROM task_effective_areas
      WHERE effective_area_id=NEW.area_id);
END;
CREATE TRIGGER personal_attention_state_project_move AFTER UPDATE OF area_id ON projects
WHEN NEW.area_id IS NOT OLD.area_id
BEGIN
  DELETE FROM personal_attention_states WHERE task_id IN (
    SELECT t.id FROM tasks t WHERE t.project_id=NEW.id AND NOT EXISTS (
      SELECT 1 FROM areas a LEFT JOIN area_members m
        ON m.area_id=a.id AND m.user_id=personal_attention_states.user_id
       WHERE a.id=NEW.area_id AND
         ((a.kind='private' AND a.owner_user_id=personal_attention_states.user_id)
         OR (a.kind='shared' AND t.assignee_user_id=personal_attention_states.user_id
             AND m.role IN ('editor','admin')))
    ));
END;

-- v23 (R2d.5d.1): identity-bound push foundation. Staging only: no sender, no
-- raw subscription payload (endpoint hash only), no HTTP. Everything is keyed
-- by user_id and never part of shared task/Area epochs or the change log.
CREATE TABLE personal_notification_epochs (
  user_id TEXT PRIMARY KEY REFERENCES identities(id),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991)
) WITHOUT ROWID;
CREATE TRIGGER personal_notification_epoch_immutable BEFORE UPDATE OF user_id ON personal_notification_epochs
BEGIN SELECT RAISE(ABORT,'notification epoch user immutable'); END;
CREATE TRIGGER personal_notification_epoch_monotonic BEFORE UPDATE OF revision ON personal_notification_epochs
WHEN NEW.revision <> OLD.revision+1
BEGIN SELECT RAISE(ABORT,'notification epoch must increment by one'); END;
CREATE TRIGGER personal_notification_epoch_no_replace BEFORE INSERT ON personal_notification_epochs
WHEN EXISTS(SELECT 1 FROM personal_notification_epochs WHERE user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'notification epoch replacement forbidden'); END;
CREATE TRIGGER personal_notification_epoch_no_delete BEFORE DELETE ON personal_notification_epochs
BEGIN SELECT RAISE(ABORT,'notification epoch deletion forbidden'); END;

-- One settings row per identity, default OFF. time_zone is the zone used for
-- this user's quiet hours; IANA validity is enforced by the writer/preflight.
CREATE TABLE personal_notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES identities(id),
  time_zone TEXT NOT NULL CHECK(typeof(time_zone)='text' AND length(time_zone) BETWEEN 1 AND 64),
  attention_push INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attention_push)='integer' AND attention_push IN (0,1)),
  quiet_start TEXT NOT NULL DEFAULT '22:00' CHECK(typeof(quiet_start)='text' AND length(quiet_start)=5
    AND quiet_start GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(quiet_start,1,2) <= '23'),
  quiet_end TEXT NOT NULL DEFAULT '08:00' CHECK(typeof(quiet_end)='text' AND length(quiet_end)=5
    AND quiet_end GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(quiet_end,1,2) <= '23'),
  daily_limit INTEGER NOT NULL DEFAULT 3 CHECK(typeof(daily_limit)='integer' AND daily_limit BETWEEN 0 AND 10),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(typeof(paused)='integer' AND paused IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991)
) WITHOUT ROWID;
CREATE TRIGGER personal_notification_on_identity AFTER INSERT ON identities BEGIN
  INSERT INTO personal_notification_epochs(user_id) VALUES (NEW.id);
  INSERT INTO personal_notification_settings(user_id,time_zone) VALUES (NEW.id,'UTC');
END;
CREATE TRIGGER personal_notification_settings_insert_guard BEFORE INSERT ON personal_notification_settings
WHEN NEW.revision IS NOT 0 OR EXISTS(SELECT 1 FROM personal_notification_settings WHERE user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT,'notification settings replacement forbidden'); END;
CREATE TRIGGER personal_notification_settings_user_immutable BEFORE UPDATE OF user_id ON personal_notification_settings
BEGIN SELECT RAISE(ABORT,'notification settings user immutable'); END;
CREATE TRIGGER personal_notification_settings_revision_guard BEFORE UPDATE OF revision ON personal_notification_settings
WHEN NEW.revision <> OLD.revision+1
BEGIN SELECT RAISE(ABORT,'notification settings revision must increment by one'); END;
CREATE TRIGGER personal_notification_settings_no_delete BEFORE DELETE ON personal_notification_settings
BEGIN SELECT RAISE(ABORT,'notification settings deletion forbidden'); END;
CREATE TRIGGER personal_notification_settings_update_epoch
AFTER UPDATE OF time_zone,attention_push,quiet_start,quiet_end,daily_limit,paused ON personal_notification_settings
WHEN NEW.time_zone IS NOT OLD.time_zone OR NEW.attention_push IS NOT OLD.attention_push OR
  NEW.quiet_start IS NOT OLD.quiet_start OR NEW.quiet_end IS NOT OLD.quiet_end OR
  NEW.daily_limit IS NOT OLD.daily_limit OR NEW.paused IS NOT OLD.paused
BEGIN
  UPDATE personal_notification_settings SET revision=OLD.revision+1 WHERE user_id=NEW.user_id;
  UPDATE personal_notification_epochs SET revision=revision+1 WHERE user_id=NEW.user_id;
END;

-- Device endpoints. Only a SHA-256 hash of the endpoint is kept in staging
-- (no raw subscription, no keys). One endpoint belongs to exactly one identity.
-- No delete: revoking sets revoked_at_ms once. Revoked rows keep counting
-- towards capacity (64 per user, 4096 total).
CREATE TABLE personal_push_targets (
  user_id TEXT NOT NULL REFERENCES identities(id),
  target_id TEXT NOT NULL CHECK(typeof(target_id)='text' AND length(target_id)=35
    AND substr(target_id,1,3)='pt_' AND substr(target_id,4) NOT GLOB '*[^0-9a-f]*'),
  endpoint_hash TEXT NOT NULL UNIQUE CHECK(typeof(endpoint_hash)='text' AND length(endpoint_hash)=64
    AND endpoint_hash NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK(typeof(created_at_ms)='integer' AND created_at_ms > 0
    AND created_at_ms <= 9007199254740991),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR (typeof(revoked_at_ms)='integer'
    AND revoked_at_ms >= created_at_ms AND revoked_at_ms <= 9007199254740991)),
  PRIMARY KEY(user_id,target_id)
) WITHOUT ROWID;
CREATE TRIGGER personal_push_target_insert_guard BEFORE INSERT ON personal_push_targets
WHEN NEW.revoked_at_ms IS NOT NULL
  OR EXISTS(SELECT 1 FROM personal_push_targets WHERE endpoint_hash=NEW.endpoint_hash
    OR target_id=NEW.target_id)
BEGIN SELECT RAISE(ABORT,'push target must be new and unrevoked'); END;
-- Opaque target IDs are globally unique, so no writer can address another
-- user's device by target_id alone.
CREATE UNIQUE INDEX personal_push_targets_by_target ON personal_push_targets(target_id);
CREATE TRIGGER personal_push_target_capacity BEFORE INSERT ON personal_push_targets
WHEN (SELECT COUNT(*) FROM personal_push_targets WHERE user_id=NEW.user_id) >= 64
  OR (SELECT COUNT(*) FROM personal_push_targets) >= 4096
BEGIN SELECT RAISE(ABORT,'push target capacity reached'); END;
CREATE TRIGGER personal_push_target_update_guard BEFORE UPDATE ON personal_push_targets
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.target_id IS NOT OLD.target_id
  OR NEW.endpoint_hash IS NOT OLD.endpoint_hash OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR OLD.revoked_at_ms IS NOT NULL OR NEW.revoked_at_ms IS NULL
BEGIN SELECT RAISE(ABORT,'push target may only be revoked once'); END;
CREATE TRIGGER personal_push_target_no_delete BEFORE DELETE ON personal_push_targets
BEGIN SELECT RAISE(ABORT,'push target deletion forbidden'); END;
CREATE TRIGGER personal_push_target_insert_epoch AFTER INSERT ON personal_push_targets BEGIN
  UPDATE personal_notification_epochs SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER personal_push_target_revoke_epoch AFTER UPDATE OF revoked_at_ms ON personal_push_targets BEGIN
  UPDATE personal_notification_epochs SET revision=revision+1 WHERE user_id=NEW.user_id;
END;

-- Announcement ledger per user and deterministic delivery key
-- ('tad1:' + sha256 of [ruleId, taskId, occurrenceOn]). Only tasks the user
-- can currently act on may have a row; access loss deletes it (reconcile below).
CREATE TABLE personal_attention_deliveries (
  user_id TEXT NOT NULL REFERENCES identities(id),
  delivery_key TEXT NOT NULL CHECK(typeof(delivery_key)='text' AND length(delivery_key)=69
    AND substr(delivery_key,1,5)='tad1:' AND substr(delivery_key,6) NOT GLOB '*[^0-9a-f]*'),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL CHECK(rule_id IN ('deadline_overdue','deadline_soon')),
  occurrence_on TEXT NOT NULL CHECK(
    typeof(occurrence_on)='text' AND length(occurrence_on)=10 AND
    occurrence_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
    CAST(substr(occurrence_on,1,4) AS INTEGER) BETWEEN 1 AND 9999 AND
    COALESCE(date(occurrence_on,'+0 days')=occurrence_on,0)),
  status TEXT NOT NULL CHECK(status IN ('baseline','pending','sent','partial','failed','undelivered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts)='integer' AND attempts BETWEEN 0 AND 3),
  last_attempt_at_ms INTEGER NOT NULL CHECK(typeof(last_attempt_at_ms)='integer'
    AND last_attempt_at_ms > 0 AND last_attempt_at_ms <= 9007199254740991),
  sent_at_ms INTEGER CHECK(sent_at_ms IS NULL OR (typeof(sent_at_ms)='integer'
    AND sent_at_ms > 0 AND sent_at_ms <= 9007199254740991)),
  PRIMARY KEY(user_id,delivery_key),
  CHECK((status IN ('sent','partial')) = (sent_at_ms IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX personal_attention_deliveries_by_task ON personal_attention_deliveries(user_id,task_id);
CREATE TRIGGER personal_attention_delivery_insert_guard BEFORE INSERT ON personal_attention_deliveries
WHEN EXISTS(SELECT 1 FROM personal_attention_deliveries WHERE user_id=NEW.user_id AND delivery_key=NEW.delivery_key)
  OR NOT EXISTS (
  SELECT 1 FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
    JOIN areas a ON a.id=COALESCE(t.area_id,p.area_id)
    LEFT JOIN area_members m ON m.area_id=a.id AND m.user_id=NEW.user_id
   WHERE t.id=NEW.task_id AND t.status='open' AND t.due_on = NEW.occurrence_on AND
    ((a.kind='private' AND a.owner_user_id=NEW.user_id) OR
     (a.kind='shared' AND t.assignee_user_id=NEW.user_id AND m.role IN ('editor','admin'))))
BEGIN SELECT RAISE(ABORT,'attention delivery requires eligible task occurrence'); END;
CREATE TRIGGER personal_attention_delivery_capacity BEFORE INSERT ON personal_attention_deliveries
WHEN (SELECT COUNT(*) FROM personal_attention_deliveries) >= 8192
BEGIN SELECT RAISE(ABORT,'attention delivery capacity reached'); END;
CREATE TRIGGER personal_attention_delivery_update_guard BEFORE UPDATE ON personal_attention_deliveries
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.delivery_key IS NOT OLD.delivery_key
  OR NEW.task_id IS NOT OLD.task_id OR NEW.rule_id IS NOT OLD.rule_id
  OR NEW.occurrence_on IS NOT OLD.occurrence_on
  OR OLD.status IN ('baseline','sent','undelivered')
  -- baseline only on first enable; a reached device is never "un-sent".
  OR (NEW.status='baseline' AND OLD.status IS NOT 'baseline')
  OR (OLD.status='partial' AND NEW.status NOT IN ('partial','sent'))
  OR (OLD.sent_at_ms IS NOT NULL AND NEW.sent_at_ms IS NOT OLD.sent_at_ms)
  OR NEW.attempts < OLD.attempts OR NEW.last_attempt_at_ms < OLD.last_attempt_at_ms
BEGIN SELECT RAISE(ABORT,'attention delivery identity or transition invalid'); END;
CREATE TRIGGER personal_attention_delivery_delete_children AFTER DELETE ON personal_attention_deliveries BEGIN
  DELETE FROM personal_attention_device_deliveries WHERE user_id=OLD.user_id AND delivery_key=OLD.delivery_key;
END;

CREATE TABLE personal_attention_device_deliveries (
  user_id TEXT NOT NULL,
  delivery_key TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','inflight','unknown','sent','failed','gone')),
  attempts INTEGER NOT NULL CHECK(typeof(attempts)='integer' AND attempts BETWEEN 0 AND 3),
  last_attempt_at_ms INTEGER NOT NULL CHECK(typeof(last_attempt_at_ms)='integer'
    AND last_attempt_at_ms > 0 AND last_attempt_at_ms <= 9007199254740991),
  PRIMARY KEY(user_id,delivery_key,target_id),
  FOREIGN KEY(user_id,delivery_key) REFERENCES personal_attention_deliveries(user_id,delivery_key) ON DELETE CASCADE,
  FOREIGN KEY(user_id,target_id) REFERENCES personal_push_targets(user_id,target_id),
  CHECK((status='reserved' AND attempts=0) OR
    (status IN ('inflight','unknown') AND attempts BETWEEN 0 AND 2) OR
    (status IN ('sent','failed','gone') AND attempts BETWEEN 1 AND 3))
) WITHOUT ROWID;
CREATE TRIGGER personal_attention_device_insert_guard BEFORE INSERT ON personal_attention_device_deliveries
WHEN EXISTS(SELECT 1 FROM personal_attention_device_deliveries WHERE user_id=NEW.user_id
    AND delivery_key=NEW.delivery_key AND target_id=NEW.target_id)
  OR (SELECT COUNT(*) FROM personal_attention_device_deliveries) >= 32768
  OR NOT EXISTS(SELECT 1 FROM personal_attention_deliveries WHERE user_id=NEW.user_id AND delivery_key=NEW.delivery_key)
  OR NOT EXISTS(SELECT 1 FROM personal_push_targets WHERE user_id=NEW.user_id
    AND target_id=NEW.target_id AND revoked_at_ms IS NULL)
BEGIN SELECT RAISE(ABORT,'attention device delivery requires own delivery and live target'); END;
CREATE TRIGGER personal_attention_device_update_guard BEFORE UPDATE ON personal_attention_device_deliveries
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.delivery_key IS NOT OLD.delivery_key
  OR NEW.target_id IS NOT OLD.target_id OR OLD.status IN ('sent','gone','unknown')
  OR (OLD.status='reserved' AND (NEW.status<>'inflight' OR NEW.attempts<>0))
  OR (OLD.status='failed' AND (NEW.status<>'inflight' OR NEW.attempts<>OLD.attempts
    OR OLD.attempts>=3))
  OR (OLD.status='inflight' AND (
    (NEW.status='unknown' AND NEW.attempts<>OLD.attempts) OR
    (NEW.status IN ('sent','failed','gone') AND NEW.attempts<>OLD.attempts+1) OR
    NEW.status NOT IN ('sent','failed','gone','unknown')))
  OR NEW.attempts < OLD.attempts OR NEW.last_attempt_at_ms < OLD.last_attempt_at_ms
BEGIN SELECT RAISE(ABORT,'attention device delivery identity or transition invalid'); END;

-- Reconcile: a user who loses access to a task (unassign, membership removal or
-- downgrade, project move, completion) or whose occurrence is superseded keeps
-- no delivery rows for it; other users' rows are untouched.
CREATE TRIGGER personal_attention_delivery_task_reconcile AFTER UPDATE OF
  assignee_user_id,status,project_id,area_id ON tasks
BEGIN
  DELETE FROM personal_attention_deliveries WHERE task_id=NEW.id AND
    (NEW.status<>'open' OR NOT EXISTS (
      SELECT 1 FROM areas a LEFT JOIN area_members m
        ON m.area_id=a.id AND m.user_id=personal_attention_deliveries.user_id
       WHERE a.id=COALESCE(NEW.area_id,
         (SELECT area_id FROM projects WHERE id=NEW.project_id))
         AND ((a.kind='private' AND a.owner_user_id=personal_attention_deliveries.user_id)
           OR (a.kind='shared' AND NEW.assignee_user_id=personal_attention_deliveries.user_id
               AND m.role IN ('editor','admin')))
    ));
END;
CREATE TRIGGER personal_attention_delivery_due_reconcile AFTER UPDATE OF due_on ON tasks
WHEN NEW.due_on IS NOT OLD.due_on
BEGIN
  DELETE FROM personal_attention_deliveries WHERE task_id=NEW.id
    AND occurrence_on IS NOT NEW.due_on;
END;
CREATE TRIGGER personal_attention_delivery_membership_delete AFTER DELETE ON area_members BEGIN
  DELETE FROM personal_attention_deliveries WHERE user_id=OLD.user_id
    AND task_id IN (SELECT task_id FROM task_effective_areas
      WHERE effective_area_id=OLD.area_id);
END;
CREATE TRIGGER personal_attention_delivery_membership_downgrade AFTER UPDATE OF role ON area_members
WHEN NEW.role='viewer' AND OLD.role IN ('editor','admin')
BEGIN
  DELETE FROM personal_attention_deliveries WHERE user_id=NEW.user_id
    AND task_id IN (SELECT task_id FROM task_effective_areas
      WHERE effective_area_id=NEW.area_id);
END;
CREATE TRIGGER personal_attention_delivery_project_move AFTER UPDATE OF area_id ON projects
WHEN NEW.area_id IS NOT OLD.area_id
BEGIN
  DELETE FROM personal_attention_deliveries WHERE task_id IN (
    SELECT t.id FROM tasks t WHERE t.project_id=NEW.id AND NOT EXISTS (
      SELECT 1 FROM areas a LEFT JOIN area_members m
        ON m.area_id=a.id AND m.user_id=personal_attention_deliveries.user_id
       WHERE a.id=NEW.area_id AND
         ((a.kind='private' AND a.owner_user_id=personal_attention_deliveries.user_id)
         OR (a.kind='shared' AND t.assignee_user_id=personal_attention_deliveries.user_id
             AND m.role IN ('editor','admin')))
    ));
END;

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
  -- R2c.2b: commit time (ms, second resolution) stamped automatically for trigger
  -- inserts; compaction retention is measured against it.
  committed_at_ms INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
    CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms > 0),
  CHECK((entity_kind IN ('task', 'project') AND op IN ('upsert', 'leave', 'tombstone')
      AND revision IS NOT NULL AND member_user_id IS NULL AND member_role IS NULL)
    OR (entity_kind = 'membership' AND entity_id = area_id
      AND op IN ('member_add', 'member_remove', 'member_role')
      AND revision IS NULL AND member_user_id IS NOT NULL
      AND ((op = 'member_remove' AND member_role IS NULL) OR (op <> 'member_remove' AND member_role IS NOT NULL))))
);
-- The R2c.2 feed reads per Area in sequence order; tombstone entries are
-- countable cheaply by preflight.
-- R2c.2b: the feed's per-Area interval reads touch only task/project entries; a partial
-- index keeps other users' membership rows out of that walk.
CREATE INDEX change_log_content_by_area ON change_log(area_id, seq) WHERE entity_kind <> 'membership';
CREATE INDEX change_log_tombstones ON change_log(seq) WHERE op = 'tombstone';
-- Preflight reconciles the latest entry per entity with the live state, and compaction
-- looks for a later row of the same key; both seek the FULL key. Membership rows use the
-- Area as entity_id, so (kind, entity_id) alone would walk every member of the Area.
CREATE INDEX change_log_by_key ON change_log(entity_kind, entity_id, member_user_id, seq);
-- R2c.2b: the own-membership lookup of the feed seeks by (kind, user) instead of
-- scanning every membership row of the log.
CREATE INDEX change_log_by_member ON change_log(entity_kind, member_user_id, seq);
CREATE TRIGGER change_log_no_update BEFORE UPDATE ON change_log
BEGIN SELECT RAISE(ABORT, 'change log is append-only'); END;
-- R2c.2b compaction. Rows are never deleted freely: a row may go only when it lies
-- at or below the compaction floor (metadata 'change_log_floor') AND a LATER row of
-- the same key (task/project: kind+ID; membership: Area+user) also lies at or below
-- the floor. So the last row <= floor of every key and every row above the floor
-- stay; tombstone rows are the last row of their key and therefore never go.
CREATE TRIGGER change_log_guarded_delete BEFORE DELETE ON change_log
WHEN OLD.seq > COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key = 'change_log_floor'), 0)
  OR NOT EXISTS(SELECT 1 FROM change_log x
    WHERE x.entity_kind = OLD.entity_kind AND x.entity_id = OLD.entity_id
      AND x.member_user_id IS OLD.member_user_id AND x.seq > OLD.seq
      AND x.seq <= COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key = 'change_log_floor'), 0))
BEGIN SELECT RAISE(ABORT, 'change log rows may only be compacted below the floor'); END;
-- The floor is a canonical decimal integer which only ever increases, never above
-- the newest sequence, and exists exactly once: no delete, rename or replace.
CREATE TRIGGER change_log_floor_update BEFORE UPDATE ON metadata
WHEN OLD.key = 'change_log_floor' AND (NEW.key <> 'change_log_floor'
  OR typeof(NEW.value) <> 'text' OR NEW.value = '' OR length(NEW.value) > 15
  OR length(CAST(NEW.value AS BLOB)) <> length(NEW.value) OR NEW.value GLOB '*[^0-9]*' OR (length(NEW.value) > 1 AND substr(NEW.value, 1, 1) = '0')
  OR CAST(NEW.value AS INTEGER) < CAST(OLD.value AS INTEGER)
  OR CAST(NEW.value AS INTEGER) > COALESCE((SELECT MAX(seq) FROM change_log), 0))
BEGIN SELECT RAISE(ABORT, 'change log floor may only increase up to the newest sequence'); END;
-- Covers UPDATE OR REPLACE which renames another row onto the floor key.
CREATE TRIGGER change_log_floor_no_rename_onto BEFORE UPDATE ON metadata
WHEN NEW.key = 'change_log_floor' AND OLD.key <> 'change_log_floor'
BEGIN SELECT RAISE(ABORT, 'change log floor cannot be replaced'); END;
CREATE TRIGGER change_log_floor_no_delete BEFORE DELETE ON metadata
WHEN OLD.key = 'change_log_floor'
BEGIN SELECT RAISE(ABORT, 'change log floor cannot be deleted'); END;
CREATE TRIGGER change_log_floor_no_replace BEFORE INSERT ON metadata
WHEN NEW.key = 'change_log_floor' AND EXISTS(SELECT 1 FROM metadata WHERE key = 'change_log_floor')
BEGIN SELECT RAISE(ABORT, 'change log floor cannot be replaced'); END;
-- R2c.4a anti-rollback anchor: the number of the last journal intent committed with the
-- store. Canonical decimal text, only ever increases, exists exactly once: no delete,
-- rename or replace (the same guard set as the floor).
CREATE TRIGGER anchor_seq_update BEFORE UPDATE ON metadata
WHEN OLD.key = 'anchor_seq' AND (NEW.key <> 'anchor_seq'
  OR typeof(NEW.value) <> 'text' OR NEW.value = '' OR length(NEW.value) > 15
  OR length(CAST(NEW.value AS BLOB)) <> length(NEW.value) OR NEW.value GLOB '*[^0-9]*' OR (length(NEW.value) > 1 AND substr(NEW.value, 1, 1) = '0')
  OR CAST(NEW.value AS INTEGER) < CAST(OLD.value AS INTEGER))
BEGIN SELECT RAISE(ABORT, 'anchor sequence may only increase'); END;
CREATE TRIGGER anchor_seq_no_rename_onto BEFORE UPDATE ON metadata
WHEN NEW.key = 'anchor_seq' AND OLD.key <> 'anchor_seq'
BEGIN SELECT RAISE(ABORT, 'anchor sequence cannot be replaced'); END;
CREATE TRIGGER anchor_seq_no_delete BEFORE DELETE ON metadata
WHEN OLD.key = 'anchor_seq'
BEGIN SELECT RAISE(ABORT, 'anchor sequence cannot be deleted'); END;
CREATE TRIGGER anchor_seq_no_replace BEFORE INSERT ON metadata
WHEN NEW.key = 'anchor_seq' AND EXISTS(SELECT 1 FROM metadata WHERE key = 'anchor_seq')
BEGIN SELECT RAISE(ABORT, 'anchor sequence cannot be replaced'); END;
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


-- R2d.2b: canonical but NOT activated notes. A note is either standalone in
-- one Area OR directly attached to a project and inherits its current Area.
-- Typed links/backlinks never confer parentage. Only an internal trusted
-- staging transaction can write a matching tombstone followed by DELETE;
-- there is no authenticated note-delete command, HTTP route or note sync yet.
CREATE TABLE notes (
  id TEXT PRIMARY KEY CHECK(typeof(id)='text' AND id <> '' AND id = trim(id)
    AND id NOT IN ('.', '..') AND length(CAST(id AS BLOB)) <= 512
    AND instr(id, char(0)) = 0
    AND id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  project_id TEXT REFERENCES projects(id),
  area_id TEXT REFERENCES areas(id),
  title TEXT NOT NULL CHECK(typeof(title)='text' AND length(trim(title)) > 0
    AND length(CAST(title AS BLOB)) <= 4096),
  body TEXT NOT NULL CHECK(typeof(body)='text' AND length(CAST(body AS BLOB)) <= 131072),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(revision)='integer' AND revision >= 0 AND revision < 9007199254740991),
  CHECK((project_id IS NULL AND area_id IS NOT NULL)
    OR (project_id IS NOT NULL AND area_id IS NULL))
) WITHOUT ROWID;
CREATE INDEX notes_by_area ON notes(area_id);
CREATE INDEX notes_by_project ON notes(project_id);
-- R2d.2c.2f.1: content-free, permanent note deletion marker. The project ID
-- is historical provenance, not a live FK (the parent may later be removed).
-- An insert is accepted only against the exact live note, effective Area and
-- next revision. The actual deletion MUST follow in the same trusted transaction;
-- canonical preflight rejects a tombstone still paired with a live note.
CREATE TABLE note_tombstones (
  id TEXT PRIMARY KEY CHECK(typeof(id)='text' AND id<>'' AND id=trim(id)
    AND id NOT IN ('.','..') AND length(CAST(id AS BLOB))<=512
    AND instr(id,char(0))=0
    AND id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  area_id TEXT NOT NULL REFERENCES areas(id),
  project_id TEXT,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0 AND revision<9007199254740991),
  deleted_at_ms INTEGER NOT NULL CHECK(typeof(deleted_at_ms)='integer' AND deleted_at_ms>0)
) WITHOUT ROWID;
CREATE TRIGGER note_tombstones_match BEFORE INSERT ON note_tombstones
WHEN NOT EXISTS (
  SELECT 1 FROM notes n LEFT JOIN projects p ON p.id=n.project_id
  WHERE n.id=NEW.id AND NEW.revision=n.revision+1
    AND NEW.project_id IS n.project_id
    AND NEW.area_id=COALESCE(n.area_id,p.area_id)
)
BEGIN SELECT RAISE(ABORT, 'note tombstone must match live note and next revision'); END;
CREATE TRIGGER note_tombstones_replace_guard BEFORE INSERT ON note_tombstones
WHEN EXISTS(SELECT 1 FROM note_tombstones WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'note tombstone replacement is forbidden'); END;
CREATE TRIGGER note_tombstones_capacity BEFORE INSERT ON note_tombstones
WHEN (SELECT COUNT(*) FROM note_tombstones)>=${TARGET_STAGING_MAX_TOMBSTONES}
BEGIN SELECT RAISE(ABORT, 'note tombstone capacity reached'); END;
CREATE TRIGGER note_tombstones_no_update BEFORE UPDATE ON note_tombstones
BEGIN SELECT RAISE(ABORT, 'note tombstones are immutable'); END;
CREATE TRIGGER note_tombstones_no_delete BEFORE DELETE ON note_tombstones
BEGIN SELECT RAISE(ABORT, 'note tombstones are permanent'); END;
CREATE TRIGGER note_capacity_guard BEFORE INSERT ON notes
WHEN (SELECT COUNT(*) FROM notes) >= ${TARGET_STAGING_MAX_NOTES}
BEGIN SELECT RAISE(ABORT, 'note capacity reached'); END;
CREATE TRIGGER note_replacement_guard BEFORE INSERT ON notes
WHEN EXISTS(SELECT 1 FROM notes WHERE id=NEW.id)
  OR EXISTS(SELECT 1 FROM note_tombstones WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'note ID cannot be replaced'); END;
CREATE TRIGGER note_id_guard BEFORE UPDATE OF id ON notes
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT, 'note ID is immutable'); END;
CREATE TRIGGER note_delete_guard BEFORE DELETE ON notes
WHEN NOT EXISTS (
  SELECT 1 FROM note_tombstones t
  WHERE t.id=OLD.id AND t.revision=OLD.revision+1
    AND t.project_id IS OLD.project_id
    AND t.area_id=COALESCE(OLD.area_id,(SELECT area_id FROM projects WHERE id=OLD.project_id))
)
BEGIN SELECT RAISE(ABORT, 'note deletion requires matching tombstone'); END;
-- A prepared tombstone cannot be followed by another edit/reparenting in the
-- same transaction: a deletion must refer to the exact original revision.
CREATE TRIGGER note_tombstone_pending_update BEFORE UPDATE ON notes
WHEN EXISTS(SELECT 1 FROM note_tombstones WHERE id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'note with pending tombstone cannot be updated'); END;
-- Fail on a mixed explicit revision/content change. Content-only updates bump
-- automatically, direct revision-only increments remain monotonic.
CREATE TRIGGER note_content_revision_guard BEFORE UPDATE OF title, body, project_id, area_id ON notes
WHEN (NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
  OR NEW.project_id IS NOT OLD.project_id OR NEW.area_id IS NOT OLD.area_id)
  AND NEW.revision IS NOT OLD.revision
BEGIN SELECT RAISE(ABORT, 'note content and revision cannot be changed together'); END;
CREATE TRIGGER note_revision_guard BEFORE UPDATE OF revision ON notes
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'note revision must increment by one'); END;
CREATE TRIGGER note_revision_bump AFTER UPDATE OF title, body, project_id, area_id ON notes
WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
  OR NEW.project_id IS NOT OLD.project_id OR NEW.area_id IS NOT OLD.area_id
BEGIN
  UPDATE notes SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
-- One witness tick per note mutation in its resulting Area. The nested
-- revision-only UPDATE from note_revision_bump fires this trigger exactly once.
-- An Area move additionally ticks the Area being left; no historical note ID
-- needs to be enumerated to detect an unjournaled move.
CREATE TRIGGER note_sync_insert AFTER INSERT ON notes BEGIN
  UPDATE areas SET note_sync_revision=note_sync_revision+1
    WHERE id=COALESCE(NEW.area_id,(SELECT area_id FROM projects WHERE id=NEW.project_id));
END;
CREATE TRIGGER note_sync_revision AFTER UPDATE OF revision ON notes
WHEN NEW.revision IS NOT OLD.revision BEGIN
  UPDATE areas SET note_sync_revision=note_sync_revision+1
    WHERE id=COALESCE(NEW.area_id,(SELECT area_id FROM projects WHERE id=NEW.project_id));
END;
CREATE TRIGGER note_sync_move_old BEFORE UPDATE OF project_id,area_id ON notes
WHEN COALESCE(OLD.area_id,(SELECT area_id FROM projects WHERE id=OLD.project_id))
  IS NOT COALESCE(NEW.area_id,(SELECT area_id FROM projects WHERE id=NEW.project_id)) BEGIN
  UPDATE areas SET note_sync_revision=note_sync_revision+1
    WHERE id=COALESCE(OLD.area_id,(SELECT area_id FROM projects WHERE id=OLD.project_id));
END;
CREATE TRIGGER note_sync_delete AFTER DELETE ON notes BEGIN
  UPDATE areas SET note_sync_revision=note_sync_revision+1
    WHERE id=COALESCE(OLD.area_id,(SELECT area_id FROM projects WHERE id=OLD.project_id));
END;
-- A parent revision changes every child manifest entry. One Area tick is
-- sufficient to force rebootstrap regardless of the number of children.
CREATE TRIGGER note_sync_parent_revision AFTER UPDATE OF revision ON projects
WHEN NEW.revision IS NOT OLD.revision AND EXISTS(SELECT 1 FROM notes WHERE project_id=NEW.id) BEGIN
  UPDATE areas SET note_sync_revision=note_sync_revision+1 WHERE id=NEW.area_id;
END;
CREATE TRIGGER note_sync_parent_move AFTER UPDATE OF area_id ON projects
WHEN NEW.area_id IS NOT OLD.area_id AND EXISTS(SELECT 1 FROM notes WHERE project_id=NEW.id) BEGIN
  UPDATE areas SET note_sync_revision=note_sync_revision+1 WHERE id=OLD.area_id;
  UPDATE areas SET note_sync_revision=note_sync_revision+1 WHERE id=NEW.area_id;
END;

-- R2d.2c.2a: committed note content edits. Only content-free metadata
-- is retained; title/body are never copied into this audit.
CREATE TABLE note_edit_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  -- Edit history must survive deletion; do not FK it to the live notes table.
  note_id TEXT NOT NULL,
  project_id TEXT,
  area_id TEXT NOT NULL REFERENCES areas(id),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision>=0),
  revision_before INTEGER NOT NULL CHECK(typeof(revision_before)='integer' AND revision_before>=0),
  revision_after INTEGER NOT NULL CHECK(typeof(revision_after)='integer' AND revision_after=revision_before+1),
  expected_revision TEXT NOT NULL CHECK(length(expected_revision)=64),
  restore_generation TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms>0)
);
CREATE INDEX note_edit_audit_by_note ON note_edit_audit(note_id,id);
CREATE TRIGGER note_edit_audit_no_update BEFORE UPDATE ON note_edit_audit
BEGIN SELECT RAISE(ABORT, 'note audit rows are immutable'); END;
CREATE TRIGGER note_edit_audit_retention BEFORE DELETE ON note_edit_audit
WHEN strftime('%s','now') IS NULL OR OLD.committed_at_ms > (CAST(strftime('%s','now') AS INTEGER)*1000-${TARGET_STAGING_AUDIT_RETENTION_DAYS}*86400000)
BEGIN SELECT RAISE(ABORT, 'note audit retention window is active'); END;
CREATE TRIGGER note_edit_audit_replace_guard BEFORE INSERT ON note_edit_audit
WHEN EXISTS(SELECT 1 FROM note_edit_audit WHERE id=NEW.id OR receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT, 'note audit replacement is forbidden'); END;
CREATE TRIGGER note_edit_audit_capacity BEFORE INSERT ON note_edit_audit
WHEN (SELECT COUNT(*) FROM note_edit_audit)>=${TARGET_STAGING_AUDIT_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'note audit capacity reached'); END;


-- R2d.2c.2f.2: immutable, content-free proof of the exact note deletion.
-- A historical parent is NOT a live foreign key and can subsequently be removed.
CREATE TABLE note_delete_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  note_id TEXT NOT NULL UNIQUE,
  project_id TEXT,
  area_id TEXT NOT NULL REFERENCES areas(id),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision>=0),
  revision_before INTEGER NOT NULL CHECK(typeof(revision_before)='integer' AND revision_before>=0),
  tombstone_revision INTEGER NOT NULL CHECK(typeof(tombstone_revision)='integer' AND tombstone_revision=revision_before+1),
  expected_revision TEXT NOT NULL CHECK(length(expected_revision)=64),
  restore_generation TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms>0)
);
CREATE INDEX note_delete_audit_by_note ON note_delete_audit(note_id,id);
CREATE TRIGGER note_delete_audit_no_update BEFORE UPDATE ON note_delete_audit
BEGIN SELECT RAISE(ABORT, 'note deletion audit immutable'); END;
-- The corresponding tombstone and receipt are permanent. Allowing expiry
-- would break canonical preflight's tombstone -> audit invariant, so this
-- audit must also be immutable for the entire lifetime of the staging store.
CREATE TRIGGER note_delete_audit_no_delete BEFORE DELETE ON note_delete_audit
BEGIN SELECT RAISE(ABORT, 'note deletion audit is permanent'); END;
CREATE TRIGGER note_delete_audit_replace_guard BEFORE INSERT ON note_delete_audit
WHEN EXISTS(SELECT 1 FROM note_delete_audit WHERE id=NEW.id OR receipt_key=NEW.receipt_key OR note_id=NEW.note_id)
BEGIN SELECT RAISE(ABORT, 'note deletion audit replacement forbidden'); END;
CREATE TRIGGER note_delete_audit_capacity BEFORE INSERT ON note_delete_audit
WHEN (SELECT COUNT(*) FROM note_delete_audit)>=${TARGET_STAGING_AUDIT_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'note deletion audit capacity reached'); END;


-- v19: One audit record for each authorized note creation or movement.
-- The identity, receipt and destination policy are checked by the trusted
-- pinned writer. Historical source IDs may not have live foreign keys.
-- A raw note INSERT/UPDATE without its matching audit stays UNJOURNALED:
-- the existing witness-gap rule then forces a full rebootstrap.
CREATE TABLE note_lifecycle_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('create','move')),
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  note_id TEXT NOT NULL,
  old_area_id TEXT REFERENCES areas(id),
  area_id TEXT NOT NULL REFERENCES areas(id),
  old_project_id TEXT,
  project_id TEXT,
  -- Historical policy witness in the source Area; NULL only for create.
  old_policy_revision INTEGER CHECK(old_policy_revision IS NULL OR
    (typeof(old_policy_revision)='integer' AND old_policy_revision>=0 AND old_policy_revision<9007199254740991)),
  parent_revision INTEGER CHECK(parent_revision IS NULL OR (typeof(parent_revision)='integer' AND parent_revision>=0)),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision>=0),
  revision_before INTEGER CHECK(revision_before IS NULL OR (typeof(revision_before)='integer' AND revision_before>=0)),
  revision_after INTEGER NOT NULL CHECK(typeof(revision_after)='integer' AND revision_after>=0 AND revision_after<9007199254740991),
  restore_generation TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms>0),
  CHECK((kind='create' AND old_area_id IS NULL AND old_project_id IS NULL AND
      old_policy_revision IS NULL AND revision_before IS NULL AND revision_after=0)
    OR (kind='move' AND old_area_id IS NOT NULL AND old_policy_revision IS NOT NULL AND
      revision_before IS NOT NULL AND revision_after=revision_before+1
      AND (old_area_id<>area_id OR old_project_id IS NOT project_id)))
);
CREATE INDEX note_lifecycle_audit_by_note ON note_lifecycle_audit(note_id,id);
CREATE TRIGGER note_lifecycle_audit_no_update BEFORE UPDATE ON note_lifecycle_audit
BEGIN SELECT RAISE(ABORT, 'note lifecycle audit immutable'); END;
CREATE TRIGGER note_lifecycle_audit_no_delete BEFORE DELETE ON note_lifecycle_audit
BEGIN SELECT RAISE(ABORT, 'note lifecycle audit permanent'); END;
CREATE TRIGGER note_lifecycle_audit_no_replace BEFORE INSERT ON note_lifecycle_audit
WHEN EXISTS(SELECT 1 FROM note_lifecycle_audit WHERE id=NEW.id OR receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT, 'note lifecycle audit replacement forbidden'); END;
CREATE TRIGGER note_lifecycle_audit_capacity BEFORE INSERT ON note_lifecycle_audit
WHEN (SELECT COUNT(*) FROM note_lifecycle_audit)>=${TARGET_STAGING_AUDIT_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'note lifecycle audit capacity reached'); END;
-- Audit must match the newly committed note's effective Area, direct parent,
-- note revision and parent revision in this same SQLite transaction.
CREATE TRIGGER note_lifecycle_audit_guard BEFORE INSERT ON note_lifecycle_audit
WHEN NOT EXISTS (
  SELECT 1 FROM notes n LEFT JOIN projects p ON p.id=n.project_id
  JOIN areas a ON a.id=COALESCE(n.area_id,p.area_id)
  WHERE n.id=NEW.note_id AND n.revision=NEW.revision_after
    AND a.id=NEW.area_id AND a.policy_revision=NEW.policy_revision
    AND (NEW.kind='create' OR EXISTS(
      SELECT 1 FROM areas src WHERE src.id=NEW.old_area_id
        AND src.policy_revision=NEW.old_policy_revision
    ))
    AND n.project_id IS NEW.project_id
    AND p.revision IS NEW.parent_revision
)
BEGIN SELECT RAISE(ABORT, 'note lifecycle audit does not match live note'); END;

-- R2d.2c.2g.2b.1: staging-only note-specific immutable change history.
-- Entries are appended by audit INSERT triggers IN THE SAME TRANSACTION as
-- the authenticated write, never by a separate best-effort sync process.
-- The journal is not a client feed: no HTTP or authorization to enumerate it.
-- The bootstrap manifest must precede a future cursor-consuming client.
-- R2d.2c.2g.2b.5: per-Area compaction floor of the note change journal. One row per
-- Area, created by trigger (floor 0). The floor only increases, never above the newest
-- live sequence, and the row is never deleted or replaced. Journal rows may be deleted
-- only at or below it (note_change_journal_guarded_delete); new sequences continue after
-- max(newest live sequence, floor), so a fully compacted Area never reuses a number.
CREATE TABLE note_journal_floors (
  area_id TEXT PRIMARY KEY REFERENCES areas(id),
  floor_seq INTEGER NOT NULL CHECK(typeof(floor_seq)='integer' AND floor_seq>=0 AND floor_seq<9007199254740991),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991)
) WITHOUT ROWID;
CREATE TRIGGER note_journal_floors_on_area AFTER INSERT ON areas
BEGIN INSERT INTO note_journal_floors(area_id,floor_seq,revision) VALUES (NEW.id,0,0); END;
CREATE TRIGGER note_journal_floors_insert BEFORE INSERT ON note_journal_floors
WHEN NEW.floor_seq<>0 OR NEW.revision<>0 OR EXISTS(SELECT 1 FROM note_journal_floors WHERE area_id=NEW.area_id)
BEGIN SELECT RAISE(ABORT, 'note journal floor cannot be created or replaced'); END;
CREATE TRIGGER note_journal_floors_update BEFORE UPDATE ON note_journal_floors
WHEN NEW.area_id<>OLD.area_id OR NEW.floor_seq<=OLD.floor_seq OR NEW.revision<>OLD.revision+1
  OR NEW.floor_seq>COALESCE((SELECT MAX(seq) FROM note_change_journal WHERE area_id=OLD.area_id),OLD.floor_seq)
BEGIN SELECT RAISE(ABORT, 'note journal floor may only increase up to the newest sequence'); END;
CREATE TRIGGER note_journal_floors_no_delete BEFORE DELETE ON note_journal_floors
BEGIN SELECT RAISE(ABORT, 'note journal floor cannot be deleted'); END;
CREATE TABLE note_change_journal (
  area_id TEXT NOT NULL REFERENCES areas(id),
  seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0 AND seq<9007199254740991),
  kind TEXT NOT NULL CHECK(kind IN ('edit','delete','upsert','leave')),
  receipt_key TEXT NOT NULL UNIQUE,
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  note_id TEXT NOT NULL CHECK(typeof(note_id)='text' AND note_id<>''),
  project_id TEXT,
  parent_revision INTEGER CHECK(parent_revision IS NULL OR (typeof(parent_revision)='integer' AND parent_revision>=0)),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision>=0),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0 AND revision<9007199254740991),
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms>0),
  PRIMARY KEY(area_id,seq)
) WITHOUT ROWID;
CREATE TRIGGER note_change_journal_capacity BEFORE INSERT ON note_change_journal
WHEN (SELECT COUNT(*) FROM note_change_journal)>=${TARGET_STAGING_NOTE_CHANGE_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'note change journal capacity reached'); END;
CREATE TRIGGER note_change_journal_no_update BEFORE UPDATE ON note_change_journal
BEGIN SELECT RAISE(ABORT, 'note change journal immutable'); END;
-- Compaction (R2d.2c.2g.2b.5): a row may go only at or below its Area's floor. There is no
-- per-note "keep the last row" rule: a note sync client behind the floor must rebootstrap
-- the whole Area (the cursor is refused with resync_required), so no row below the floor
-- is ever needed to serve a client.
CREATE TRIGGER note_change_journal_guarded_delete BEFORE DELETE ON note_change_journal
WHEN OLD.seq>COALESCE((SELECT floor_seq FROM note_journal_floors WHERE area_id=OLD.area_id),-1)
BEGIN SELECT RAISE(ABORT, 'note change journal rows may only be compacted at or below the floor'); END;
CREATE TRIGGER note_change_journal_above_floor BEFORE INSERT ON note_change_journal
WHEN NEW.seq<=COALESCE((SELECT floor_seq FROM note_journal_floors WHERE area_id=NEW.area_id),9007199254740991)
BEGIN SELECT RAISE(ABORT, 'note change journal sequence must follow the floor'); END;
CREATE TRIGGER note_change_journal_no_replace BEFORE INSERT ON note_change_journal
WHEN EXISTS(SELECT 1 FROM note_change_journal
  WHERE (area_id=NEW.area_id AND seq=NEW.seq) OR receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT, 'note change journal replacement forbidden'); END;
CREATE TRIGGER note_change_journal_on_edit AFTER INSERT ON note_edit_audit
BEGIN
  INSERT INTO note_change_journal(
    area_id,seq,kind,receipt_key,actor_user_id,note_id,project_id,policy_revision,
    revision,committed_at_ms)
  SELECT NEW.area_id,MAX(COALESCE(MAX(seq),0),COALESCE((SELECT floor_seq FROM note_journal_floors WHERE area_id=NEW.area_id),0))+1,'edit',NEW.receipt_key,NEW.actor_user_id,
    NEW.note_id,NEW.project_id,NEW.policy_revision,NEW.revision_after,NEW.committed_at_ms
  FROM note_change_journal WHERE area_id=NEW.area_id;
END;
CREATE TRIGGER note_change_journal_on_delete AFTER INSERT ON note_delete_audit
BEGIN
  INSERT INTO note_change_journal(
    area_id,seq,kind,receipt_key,actor_user_id,note_id,project_id,policy_revision,
    revision,committed_at_ms)
  SELECT NEW.area_id,MAX(COALESCE(MAX(seq),0),COALESCE((SELECT floor_seq FROM note_journal_floors WHERE area_id=NEW.area_id),0))+1,'delete',NEW.receipt_key,NEW.actor_user_id,
    NEW.note_id,NEW.project_id,NEW.policy_revision,NEW.tombstone_revision,NEW.committed_at_ms
  FROM note_change_journal WHERE area_id=NEW.area_id;
END;
-- Audit-backed lifecycle creates one upsert in the destination Area and, on
-- a cross-Area move, one leave in the old Area. Sequence/witness increments
-- match exactly: create +1, same-Area move +1, cross-Area move +1 per Area.
CREATE TRIGGER note_change_journal_on_lifecycle AFTER INSERT ON note_lifecycle_audit
BEGIN
  INSERT INTO note_change_journal(area_id,seq,kind,receipt_key,actor_user_id,
    note_id,project_id,parent_revision,policy_revision,revision,committed_at_ms)
  SELECT NEW.old_area_id,
    MAX(COALESCE((SELECT MAX(seq) FROM note_change_journal WHERE area_id=NEW.old_area_id),0),
      COALESCE((SELECT floor_seq FROM note_journal_floors WHERE area_id=NEW.old_area_id),0))+1,
    'leave',NEW.receipt_key||':leave',NEW.actor_user_id,NEW.note_id,
    NEW.old_project_id,NULL,NEW.old_policy_revision,NEW.revision_after,NEW.committed_at_ms
  WHERE NEW.kind='move' AND NEW.old_area_id<>NEW.area_id;
  INSERT INTO note_change_journal(area_id,seq,kind,receipt_key,actor_user_id,
    note_id,project_id,parent_revision,policy_revision,revision,committed_at_ms)
  VALUES (NEW.area_id,
    MAX(COALESCE((SELECT MAX(seq) FROM note_change_journal WHERE area_id=NEW.area_id),0),
      COALESCE((SELECT floor_seq FROM note_journal_floors WHERE area_id=NEW.area_id),0))+1,
    'upsert',NEW.receipt_key,NEW.actor_user_id,NEW.note_id,
    NEW.project_id,NEW.parent_revision,NEW.policy_revision,NEW.revision_after,NEW.committed_at_ms);
END;
-- Retain audit provenance for every journal event. Existing note edit audit
-- retention cannot silently remove the only authenticated source of an event.
-- The audit of a compacted Area stays permanent too (preflight reconciles audits with floor + live rows).
CREATE TRIGGER note_change_journal_edit_audit_no_delete
BEFORE DELETE ON note_edit_audit
WHEN EXISTS(SELECT 1 FROM note_change_journal WHERE receipt_key=OLD.receipt_key)
  OR COALESCE((SELECT floor_seq FROM note_journal_floors WHERE area_id=OLD.area_id),0)>0
BEGIN SELECT RAISE(ABORT, 'journal-backed note audit is permanent'); END;

CREATE VIEW task_effective_areas AS
  SELECT t.id AS task_id, COALESCE(t.area_id, p.area_id) AS effective_area_id,
         t.assignee_user_id AS assignee_user_id
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id;

-- Monotonic task and Area-policy epochs are maintained by SQLite, including
-- direct staging SQL changes. They make a reverted title/ACL policy (ABA)
-- distinguishable from the original state. Unrelated task changes cannot
-- invalidate a task's edit revision.
CREATE TRIGGER task_revision_bump AFTER UPDATE OF title, project_id, area_id, assignee_user_id, status, completed_at_ms, due_on ON tasks
WHEN NEW.title IS NOT OLD.title OR NEW.project_id IS NOT OLD.project_id
  OR NEW.area_id IS NOT OLD.area_id OR NEW.assignee_user_id IS NOT OLD.assignee_user_id
  OR NEW.status IS NOT OLD.status OR NEW.completed_at_ms IS NOT OLD.completed_at_ms
  OR NEW.due_on IS NOT OLD.due_on
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
  UPDATE areas SET project_content_revision = project_content_revision + 1 WHERE id = NEW.area_id;
  INSERT INTO change_log(entity_kind, entity_id, area_id, op, revision)
    VALUES ('project', NEW.id, NEW.area_id, 'upsert', NEW.revision);
END;
CREATE TRIGGER project_change_log_revision AFTER UPDATE OF revision ON projects
WHEN NEW.revision IS NOT OLD.revision
BEGIN
  UPDATE areas SET project_content_revision = project_content_revision + 1 WHERE id = NEW.area_id;
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
  UPDATE areas SET content_revision = content_revision + 1,
    project_content_revision = project_content_revision + 1 WHERE id = OLD.area_id;
  UPDATE areas SET content_revision = content_revision + 1,
    project_content_revision = project_content_revision + 1 WHERE id = NEW.area_id;
END;
CREATE TRIGGER project_delete_log AFTER DELETE ON projects
BEGIN
  INSERT INTO change_log(seq, entity_kind, entity_id, area_id, op, revision)
    SELECT ts.change_seq, 'project', ts.id, ts.area_id, 'tombstone', ts.revision
      FROM project_tombstones ts WHERE ts.id = OLD.id;
  UPDATE areas SET content_revision = content_revision + 1,
    project_content_revision = project_content_revision + 1
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
CREATE TRIGGER area_project_content_revision_guard BEFORE UPDATE OF project_content_revision ON areas
WHEN NEW.project_content_revision <> OLD.project_content_revision + 1
BEGIN SELECT RAISE(ABORT, 'Area project content revision must increment by one'); END;
CREATE TRIGGER area_note_sync_revision_guard BEFORE UPDATE OF note_sync_revision ON areas
WHEN NEW.note_sync_revision <> OLD.note_sync_revision + 1
BEGIN SELECT RAISE(ABORT, 'Area note sync revision must increment by one'); END;
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

-- R2c.4b restore bookkeeping, all append-only (no UPDATE, no DELETE, no REPLACE).
-- The generation history: every restore replaces the store's restore_generation by a fresh one and
-- leaves the previous one here, so audit rows written under it stay valid (preflight).
CREATE TABLE restore_generations (
  generation TEXT PRIMARY KEY CHECK(length(generation) = 36),
  previous_generation TEXT NOT NULL UNIQUE CHECK(length(previous_generation) = 36 AND previous_generation <> generation),
  journal_n INTEGER NOT NULL CHECK(typeof(journal_n)='integer' AND journal_n >= 1),
  restored_at_ms INTEGER NOT NULL CHECK(typeof(restored_at_ms)='integer' AND restored_at_ms > 0)
) WITHOUT ROWID;
CREATE TRIGGER restore_generations_no_update BEFORE UPDATE ON restore_generations
BEGIN SELECT RAISE(ABORT, 'restore history is append-only'); END;
CREATE TRIGGER restore_generations_no_delete BEFORE DELETE ON restore_generations
BEGIN SELECT RAISE(ABORT, 'restore history is append-only'); END;
CREATE TRIGGER restore_generations_replace_guard BEFORE INSERT ON restore_generations
WHEN EXISTS(SELECT 1 FROM restore_generations WHERE generation = NEW.generation OR previous_generation = NEW.previous_generation)
BEGIN SELECT RAISE(ABORT, 'restore history replacement is forbidden'); END;
CREATE TRIGGER restore_generations_capacity BEFORE INSERT ON restore_generations
WHEN (SELECT COUNT(*) FROM restore_generations) >= ${TARGET_STAGING_RESTORE_HISTORY_MAX}
BEGIN SELECT RAISE(ABORT, 'restore history capacity reached'); END;
-- Tokens which were live under the irreversible source when a restore replaced the store: the
-- presenter gets the 401 code session_restored (never an unknown token: only a restore writes here).
CREATE TABLE restore_superseded_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL CHECK(length(trim(user_id)) > 0),
  restore_generation TEXT NOT NULL CHECK(length(restore_generation) = 36)
) WITHOUT ROWID;
CREATE TRIGGER restore_superseded_sessions_no_update BEFORE UPDATE ON restore_superseded_sessions
BEGIN SELECT RAISE(ABORT, 'superseded sessions are append-only'); END;
CREATE TRIGGER restore_superseded_sessions_no_delete BEFORE DELETE ON restore_superseded_sessions
BEGIN SELECT RAISE(ABORT, 'superseded sessions are append-only'); END;
CREATE TRIGGER restore_superseded_sessions_replace_guard BEFORE INSERT ON restore_superseded_sessions
WHEN EXISTS(SELECT 1 FROM restore_superseded_sessions WHERE token_hash = NEW.token_hash)
  OR NOT EXISTS(SELECT 1 FROM restore_generations WHERE generation = NEW.restore_generation)
BEGIN SELECT RAISE(ABORT, 'superseded session replacement is forbidden'); END;
CREATE TRIGGER restore_superseded_sessions_capacity BEFORE INSERT ON restore_superseded_sessions
WHEN (SELECT COUNT(*) FROM restore_superseded_sessions) >= ${TARGET_STAGING_SUPERSEDED_SESSIONS_MAX}
BEGIN SELECT RAISE(ABORT, 'superseded session capacity reached'); END;
`;

// Project commands have their own immutable, content-free receipt ledger.  A
// single row is both the receipt and audit event, committed with the change.
export const TARGET_PROJECT_TITLE_SCHEMA_SQL = `
CREATE TABLE project_title_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_key TEXT NOT NULL UNIQUE CHECK(length(receipt_key)=64),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
  actor_user_id TEXT NOT NULL REFERENCES identities(id),
  project_id TEXT NOT NULL,
  area_id TEXT NOT NULL REFERENCES areas(id),
  policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision)='integer' AND policy_revision>=0),
  revision_before INTEGER NOT NULL CHECK(typeof(revision_before)='integer' AND revision_before>=0),
  revision_after INTEGER NOT NULL CHECK(typeof(revision_after)='integer' AND revision_after=revision_before+1),
  expected_revision TEXT NOT NULL CHECK(length(expected_revision)=64),
  restore_generation TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL CHECK(typeof(committed_at_ms)='integer' AND committed_at_ms>0)
);
CREATE TRIGGER project_title_audit_no_update BEFORE UPDATE ON project_title_audit
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER project_title_audit_no_delete BEFORE DELETE ON project_title_audit
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER project_title_audit_replace_guard BEFORE INSERT ON project_title_audit
WHEN EXISTS(SELECT 1 FROM project_title_audit WHERE id=NEW.id OR receipt_key=NEW.receipt_key)
BEGIN SELECT RAISE(ABORT, 'audit replacement is forbidden'); END;
CREATE TRIGGER project_title_audit_capacity BEFORE INSERT ON project_title_audit
WHEN (SELECT COUNT(*) FROM project_title_audit) >= ${TARGET_STAGING_AUDIT_MAX_EVENTS}
BEGIN SELECT RAISE(ABORT, 'audit capacity reached'); END;
`;
export const TARGET_SCHEMA_SQL = TARGET_SCHEMA_V25_SQL + TARGET_PROJECT_TITLE_SCHEMA_SQL;

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
      meta.run("change_log_floor", "0");
      meta.run("anchor_seq", "0");
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
  // The independent witness is committed atomically with main via SQLite ATTACH on every write.
  // Initialize it before exposing the genesis journal; an incomplete bootstrap is unusable.
  const genesis = targetStagingJournalGenesis(restoreGeneration);
  bootstrapTargetStagingWitness(directory, restoreGeneration, genesis.hash);
  // R2c.4a: the journal starts with its genesis record (confirmed 0). Created exclusively,
  // never through a symlink, private to this user, fsynced.
  const journalFd = openSync(path.join(directory, TARGET_STAGING_JOURNAL_FILENAME),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_APPEND, 0o600);
  try {
    fchmodSync(journalFd, 0o600);
    writeSync(journalFd, genesis.text);
    fsyncSync(journalFd);
  } finally {
    closeSync(journalFd);
  }
  return {
    directory, databasePath, ownerUserId: owner, personalWorkspaceId,
    unassignedAreaId, restoreGeneration, schemaVersion: TARGET_STORE_SCHEMA_VERSION,
  };
}
