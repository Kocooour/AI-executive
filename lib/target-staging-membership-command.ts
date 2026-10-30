/**
 * R2-ID.2a staging-only shared-Area membership command. Not a sync command, not
 * a production writer, and no UI. The only supported entry is a session-bound
 * authority (see TargetStagingSessionAuthority.applyMembershipCommand).
 *
 * One command = one BEGIN IMMEDIATE transaction on the pinned database
 * (lib/target-staging-pinned-write.ts): live-session check, admin ACL, receipt
 * replay, policy-revision CAS, task unassignment, membership change, receipt and
 * audit commit or roll back together. Denials never reveal whether an Area
 * exists to a caller who is not its current admin.
 *
 * "Unfinished assignments": the staging schema has no task completion state, so
 * EVERY task assigned to the removed/demoted user in that Area counts as
 * unfinished and becomes unassigned (assignee_user_id = NULL, i.e. Nepřiděleno).
 * Historical completion attribution is deferred until completion exists.
 */
import { createHash } from "node:crypto";
import { TARGET_STAGING_AUDIT_MAX_EVENTS, TARGET_STAGING_MAX_RECEIPTS } from "./target-store-bootstrap";
import { isTargetStagingSessionTokenHash, lookupLiveTargetStagingSession } from "./target-staging-durable-session";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import { verifiedActor } from "./target-task-authenticated-read";
import type { TargetStagingReadCredential } from "./target-task-authenticated-read";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import { targetStoreRestoreGeneration } from "./target-task-write-preflight";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const MAX_REVISION = 9007199254740990;

export type TargetStagingMembershipRole = "viewer" | "editor" | "admin";
export type TargetStagingMembershipAction = "add" | "remove" | "set_role";

export interface TargetStagingMembershipCommand {
  /** Fresh UUID for the logical command; retries must reuse it. */
  readonly commandId: string;
  readonly areaId: string;
  /** Current areas.policy_revision the caller based the decision on (CAS). */
  readonly expectedPolicyRevision: number;
  readonly action: TargetStagingMembershipAction;
  readonly targetUserId: string;
  /** R2c.3: must equal `areaId` (the route rejects a mismatch with 400 before the admin check). */
  readonly writeAreaId: string;
  /** R2c.3: the restore generation the client synchronized to. */
  readonly restoreGeneration: string;
  /** Required for add / set_role, forbidden for remove. */
  readonly role?: TargetStagingMembershipRole;
}

export type TargetStagingMembershipResult =
  | { ok: true; outcome: "applied" | "noop"; policyRevision: number;
      unassignedTasks: number; replayed?: true }
  | { ok: false;
      reason: "invalid_request" | "unauthorized" | "unauthenticated" | "unavailable" | "stale_policy_revision" |
        "idempotency_conflict" | "already_member" | "last_admin" | "write_failed" |
        "session_revoked" | "resync_required" };

/** Pin / store integrity loss (HTTP 503). */
const denied = (): TargetStagingMembershipResult => ({ ok: false, reason: "unauthorized" });
/** Actor or session verification failure (HTTP 401). */
const unauthenticated = (): TargetStagingMembershipResult => ({ ok: false, reason: "unauthenticated" });
const failed = (): TargetStagingMembershipResult => ({ ok: false, reason: "write_failed" });
const roles = ["viewer", "editor", "admin"];

export function validTargetStagingMembershipCommand(
  value: unknown,
): value is TargetStagingMembershipCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  if (v.action !== "add" && v.action !== "remove" && v.action !== "set_role") return false;
  if (keys !== (v.action === "remove"
    ? "action,areaId,commandId,expectedPolicyRevision,restoreGeneration,targetUserId,writeAreaId"
    : "action,areaId,commandId,expectedPolicyRevision,restoreGeneration,role,targetUserId,writeAreaId")) return false;
  if (v.action !== "remove" && !(typeof v.role === "string" && roles.includes(v.role))) return false;
  return typeof v.commandId === "string" && UUID.test(v.commandId) &&
    typeof v.areaId === "string" && ID.test(v.areaId) &&
    typeof v.writeAreaId === "string" && v.writeAreaId === v.areaId &&
    typeof v.restoreGeneration === "string" && UUID.test(v.restoreGeneration) &&
    typeof v.targetUserId === "string" && ID.test(v.targetUserId) &&
    typeof v.expectedPolicyRevision === "number" && Number.isSafeInteger(v.expectedPolicyRevision) &&
    v.expectedPolicyRevision >= 0 && v.expectedPolicyRevision <= MAX_REVISION;
}

/** Opaque key: one command UUID is unique per actor and Area. */
export function targetMembershipReceiptKey(actor: string, areaId: string, commandId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["membership-v1", actor, areaId, commandId.toLowerCase()])).digest("hex");
}

/** Digest of the exact command semantics (Area and actor are in the key). */
export function targetMembershipPayloadDigest(command: TargetStagingMembershipCommand): string {
  return createHash("sha256").update(JSON.stringify([
    command.action, command.targetUserId, command.role ?? null, command.expectedPolicyRevision,
  ])).digest("hex");
}

export function applyTargetStagingMembershipCommand(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  command: TargetStagingMembershipCommand,
  durableSessionTokenHash?: string,
): TargetStagingMembershipResult {
  if (!validTargetStagingMembershipCommand(command)) return { ok: false, reason: "invalid_request" };
  if (durableSessionTokenHash !== undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return unauthenticated();
  return withPinnedTargetStagingWrite<TargetStagingMembershipResult>(store, context => {
    const { db } = context;
    const actor = verifiedActor(db, access, true);
    if (!actor) return unauthenticated();
    const sessionLive = (): boolean => {
      if (durableSessionTokenHash === undefined) return true;
      const live = lookupLiveTargetStagingSession(db, durableSessionTokenHash, Date.now());
      return live !== null && live.userId === actor;
    };
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };

    // R2c.3: a client synchronized to another restore generation writes nothing.
    // Store-level, so it reveals nothing about Areas; runs before the admin check.
    const generation = targetStoreRestoreGeneration(db);
    if (generation === null || generation !== command.restoreGeneration.toLowerCase()) {
      return { ok: false, reason: "resync_required" };
    }

    // Not-admin, unknown Area and private Area are one indistinguishable denial.
    const area = db.prepare(`
      SELECT a.policy_revision AS policy_revision FROM areas a
        JOIN area_members m ON m.area_id=a.id
       WHERE a.id=? AND a.kind='shared' AND m.user_id=? AND m.role='admin'
    `).get(command.areaId, actor) as { policy_revision: number } | undefined;
    if (!area) return { ok: false, reason: "unavailable" };

    const receiptKey = targetMembershipReceiptKey(actor, command.areaId, command.commandId);
    const digest = targetMembershipPayloadDigest(command);
    const prior = db.prepare(`
      SELECT payload_digest, outcome, policy_revision, unassigned_tasks
        FROM area_membership_receipts WHERE receipt_key=?
    `).get(receiptKey) as { payload_digest: string; outcome: "applied" | "noop";
      policy_revision: number; unassigned_tasks: number } | undefined;
    if (prior) {
      return prior.payload_digest === digest
        ? { ok: true, outcome: prior.outcome, policyRevision: prior.policy_revision,
            unassignedTasks: prior.unassigned_tasks, replayed: true }
        : { ok: false, reason: "idempotency_conflict" };
    }
    if (area.policy_revision !== command.expectedPolicyRevision) {
      return { ok: false, reason: "stale_policy_revision" };
    }

    // The target must be a real identity with a personal workspace.
    const target = db.prepare(`
      SELECT 1 AS ok FROM identities i JOIN workspaces w
        ON w.owner_user_id=i.id AND w.kind='personal' WHERE i.id=?
    `).get(command.targetUserId);
    if (!target) return { ok: false, reason: "unavailable" };
    const member = db.prepare("SELECT role FROM area_members WHERE area_id=? AND user_id=?")
      .get(command.areaId, command.targetUserId) as { role: TargetStagingMembershipRole } | undefined;
    const roleBefore = member?.role ?? null;
    const roleAfter = command.action === "remove" ? null : command.role as TargetStagingMembershipRole;
    if (command.action === "add" && member) return { ok: false, reason: "already_member" };
    if (command.action !== "add" && !member) return { ok: false, reason: "unavailable" };

    const committedAt = Date.now();
    if (!Number.isSafeInteger(committedAt) || committedAt <= 0) return failed();
    const record = (outcome: "applied" | "noop", revision: number, unassigned: number) => {
      const receipts = db.prepare("SELECT COUNT(*) AS n FROM area_membership_receipts")
        .get() as { n: number };
      if (receipts.n >= TARGET_STAGING_MAX_RECEIPTS) return false;
      db.prepare(`INSERT INTO area_membership_receipts(
        receipt_key,payload_digest,outcome,policy_revision,unassigned_tasks,committed_at_ms
      ) VALUES (?,?,?,?,?,?)`).run(receiptKey, digest, outcome, revision, unassigned, committedAt);
      return true;
    };

    if (roleBefore === roleAfter) {
      // Same-role set_role is a no-op: no audit row, no revision bump.
      if (!context.stillPinned() || !context.noSidecars()) return denied();
      if (!record("noop", area.policy_revision, 0)) return failed();
      if (!sessionLive()) return { ok: false, reason: "session_revoked" };
      context.commit();
      return { ok: true, outcome: "noop", policyRevision: area.policy_revision, unassignedTasks: 0 };
    }

    // Removing or demoting the only admin is refused (the triggers enforce it
    // for raw SQL as well).
    if (roleBefore === "admin" && roleAfter !== "admin") {
      const others = db.prepare(
        "SELECT COUNT(*) AS n FROM area_members WHERE area_id=? AND role='admin' AND user_id<>?",
      ).get(command.areaId, command.targetUserId) as { n: number };
      if (others.n === 0) return { ok: false, reason: "last_admin" };
    }
    if (!context.stillPinned() || !context.noSidecars()) return denied();
    const auditCount = db.prepare("SELECT COUNT(*) AS n FROM area_membership_audit")
      .get() as { n: number };
    if (auditCount.n >= TARGET_STAGING_AUDIT_MAX_EVENTS) return failed();

    // Unassign BEFORE the membership change so the existing guards pass. This
    // does not touch policy_revision (only membership rows do).
    let unassigned = 0;
    if (roleAfter === null || roleAfter === "viewer") {
      unassigned = Number(db.prepare(`
        UPDATE tasks SET assignee_user_id=NULL
         WHERE assignee_user_id=? AND id IN (
           SELECT task_id FROM task_effective_areas
            WHERE effective_area_id=? AND assignee_user_id=?)
      `).run(command.targetUserId, command.areaId, command.targetUserId).changes);
    }
    const changed = command.action === "add"
      ? db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)")
          .run(command.areaId, command.targetUserId, roleAfter)
      : command.action === "remove"
        ? db.prepare("DELETE FROM area_members WHERE area_id=? AND user_id=?")
            .run(command.areaId, command.targetUserId)
        : db.prepare("UPDATE area_members SET role=? WHERE area_id=? AND user_id=?")
            .run(roleAfter, command.areaId, command.targetUserId);
    if (changed.changes !== 1) return failed();
    const after = db.prepare("SELECT policy_revision FROM areas WHERE id=?")
      .get(command.areaId) as { policy_revision: number } | undefined;
    if (!after || after.policy_revision !== area.policy_revision + 1) return failed();
    if (!record("applied", after.policy_revision, unassigned)) return failed();
    db.prepare(`INSERT INTO area_membership_audit(
      receipt_key,actor_user_id,area_id,target_user_id,action,role_before,role_after,
      policy_revision_before,policy_revision_after,restore_generation,committed_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      receiptKey, actor, command.areaId, command.targetUserId, command.action,
      roleBefore, roleAfter, area.policy_revision, after.policy_revision,
      store.expectedRestoreGeneration, committedAt,
    );
    // Linearization point, still inside BEGIN IMMEDIATE: a session revoked
    // earlier rolls back membership, tasks, receipt and audit together.
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };
    context.commit();
    return { ok: true, outcome: "applied", policyRevision: after.policy_revision,
      unassignedTasks: unassigned };
  }, denied, failed);
}
