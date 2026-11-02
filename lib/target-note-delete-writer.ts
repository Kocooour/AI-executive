/**
 * R2d.2c.2f.2: staging-only, authenticated deletion of one existing note.
 * Opt-in HTTP callers may use this internal writer; no sync or production activation. All state changes are in a
 * pinned BEGIN IMMEDIATE transaction with canonical store preflight.
 */
import { createHash } from "node:crypto";
import { fingerprint } from "./target-task-staging-writer";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import { verifiedActor, type TargetStagingReadCredential } from "./target-task-authenticated-read";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import {
  isTargetStagingSessionTokenHash, lookupLiveTargetStagingSession,
} from "./target-staging-durable-session";
import {
  TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX, TARGET_STAGING_MAX_RECEIPTS,
  TARGET_STAGING_AUDIT_MAX_EVENTS, TARGET_STAGING_MAX_TOMBSTONES,
} from "./target-store-bootstrap";
import {
  checkTargetNoteWriteContract, previewTargetNoteWrite,
  validTargetNoteWriteContractRequest, type TargetNoteWriteContractRequest,
} from "./target-note-write-contract";
import { readAuthorizedTargetNote } from "./target-note-access";
import { canWriteIsolatedTargetArea, targetStoreRestoreGeneration } from "./target-task-write-preflight";

const COMMAND = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface TargetStagingNoteDeleteRequest extends TargetNoteWriteContractRequest {
  readonly commandId: string;
}
export type TargetStagingNoteDeleteResult =
  | { ok: true; replayed?: true }
  | { ok: false; reason:
      "invalid_request" | "unauthorized" | "unavailable" | "resync_required" |
      "write_area_mismatch" | "stale_revision" | "idempotency_conflict" |
      "session_revoked" | "write_failed" };
const denied = (): TargetStagingNoteDeleteResult => ({ ok: false, reason: "unauthorized" });
const failed = (): TargetStagingNoteDeleteResult => ({ ok: false, reason: "write_failed" });

export function validTargetStagingNoteDeleteRequest(value: unknown): value is TargetStagingNoteDeleteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return Object.keys(r).sort().join(",") ===
      "commandId,expectedRevision,noteId,restoreGeneration,writeAreaId" &&
    typeof r.commandId === "string" && COMMAND.test(r.commandId) &&
    validTargetNoteWriteContractRequest({
      noteId: r.noteId, expectedRevision: r.expectedRevision,
      writeAreaId: r.writeAreaId, restoreGeneration: r.restoreGeneration,
    });
}

export function targetNoteDeleteReceiptKey(actor: string, noteId: string, commandId: string): string {
  return TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX + createHash("sha256")
    .update(JSON.stringify([actor, noteId, commandId.toLowerCase()])).digest("hex");
}
export function targetNoteDeleteReceiptDigest(request: TargetStagingNoteDeleteRequest): string {
  return createHash("sha256").update(JSON.stringify([
    "note-delete-v1", request.noteId, request.expectedRevision,
    request.writeAreaId, request.restoreGeneration.toLowerCase(),
  ])).digest("hex");
}

/**
 * A tombstone is only consulted AFTER finding this actor's exact receipt.
 * This prevents using deletion retries to enumerate other actors' note IDs.
 * Current Area write rights still apply to a replay.
 */
export function deletePreflightedTargetNote(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingNoteDeleteRequest,
  durableSessionTokenHash?: string,
): TargetStagingNoteDeleteResult {
  if (!validTargetStagingNoteDeleteRequest(request)) return { ok: false, reason: "invalid_request" };
  if (durableSessionTokenHash !== undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return denied();

  return withPinnedTargetStagingWrite<TargetStagingNoteDeleteResult>(store, context => {
    const { db, databaseFd } = context;
    const actor = verifiedActor(db, access, true);
    if (!actor) return denied();
    const sessionLive = (): boolean => {
      if (durableSessionTokenHash === undefined) return true;
      const live = lookupLiveTargetStagingSession(db, durableSessionTokenHash, Date.now());
      return live !== null && live.userId === actor;
    };
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };
    const generation = targetStoreRestoreGeneration(db);
    if (!generation || generation.toLowerCase() !== request.restoreGeneration.toLowerCase()) {
      return { ok: false, reason: "resync_required" };
    }
    const receiptKey = targetNoteDeleteReceiptKey(actor, request.noteId, request.commandId);
    const receiptDigest = targetNoteDeleteReceiptDigest(request);
    const current = previewTargetNoteWrite(db, actor, request.noteId);
    if (!current.ok) {
      // Do not expose whether an inaccessible/deleted/never-existing ID exists.
      const own = db.prepare("SELECT value FROM metadata WHERE key=?")
        .get(receiptKey) as { value: string } | undefined;
      if (!own) return { ok: false, reason: "unavailable" };
      const tomb = db.prepare("SELECT area_id FROM note_tombstones WHERE id=?")
        .get(request.noteId) as { area_id: string } | undefined;
      if (!tomb || !canWriteIsolatedTargetArea(db, actor, tomb.area_id) ||
          !canWriteIsolatedTargetArea(db, actor, request.writeAreaId)) {
        return { ok: false, reason: "unavailable" };
      }
      if (tomb.area_id !== request.writeAreaId) {
        return { ok: false, reason: "write_area_mismatch" };
      }
      return own.value === receiptDigest
        ? { ok: true, replayed: true } : { ok: false, reason: "idempotency_conflict" };
    }
    if (!canWriteIsolatedTargetArea(db, actor, request.writeAreaId)) {
      return { ok: false, reason: "unavailable" };
    }
    if (current.writeAreaId !== request.writeAreaId) {
      return { ok: false, reason: "write_area_mismatch" };
    }
    const prior = db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(receiptKey) as { value: string } | undefined;
    if (prior) return prior.value === receiptDigest
      ? { ok: true, replayed: true } : { ok: false, reason: "idempotency_conflict" };
    // The note-write CAS contract has an exact four-field shape; commandId is
    // strictly a delete idempotency token and must not enter that validator.
    const contract = checkTargetNoteWriteContract(db, actor, {
      noteId: request.noteId, expectedRevision: request.expectedRevision,
      writeAreaId: request.writeAreaId, restoreGeneration: request.restoreGeneration,
    });
    if (contract.ok === false) return { ok: false, reason: contract.reason };
    fingerprint(databaseFd);
    const note = readAuthorizedTargetNote(db, { actorUserId: actor, noteId: request.noteId });
    const area = note?.linearization.areas[0];
    if (!note || !area || note.note.revision !== contract.noteRevision ||
        note.guard.areaId !== contract.areaId ||
        note.guard.parentRevision !== contract.parentRevision) return failed();
    if (!context.stillPinned() || !context.noSidecars()) return denied();
    const count = (sql: string, ...args: string[]) =>
      (db.prepare(sql).get(...args) as { n: number }).n;
    if (count("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?",
          TARGET_STAGING_NOTE_DELETE_RECEIPT_PREFIX + "%") >= TARGET_STAGING_MAX_RECEIPTS ||
        count("SELECT COUNT(*) AS n FROM note_delete_audit") >= TARGET_STAGING_AUDIT_MAX_EVENTS ||
        count("SELECT COUNT(*) AS n FROM note_tombstones") >= TARGET_STAGING_MAX_TOMBSTONES) return failed();
    const committedAt = Date.now();
    if (!Number.isSafeInteger(committedAt) || committedAt <= 0) return failed();

    const nextRevision = contract.noteRevision + 1;
    db.prepare(`INSERT INTO note_tombstones(id,area_id,project_id,revision,deleted_at_ms)
      VALUES (?,?,?,?,?)`).run(
      request.noteId, contract.areaId, note.guard.projectId, nextRevision, committedAt,
    );
    if (db.prepare("DELETE FROM notes WHERE id=? AND revision=?")
      .run(request.noteId, contract.noteRevision).changes !== 1) return failed();
    const stored = db.prepare("SELECT area_id,project_id,revision,deleted_at_ms FROM note_tombstones WHERE id=?")
      .get(request.noteId) as {
        area_id: string; project_id: string | null; revision: number; deleted_at_ms: number;
      } | undefined;
    if (!stored || stored.area_id !== contract.areaId ||
        stored.project_id !== note.guard.projectId || stored.revision !== nextRevision ||
        stored.deleted_at_ms !== committedAt) return failed();
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receiptKey, receiptDigest);
    db.prepare(`INSERT INTO note_delete_audit (
      receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
      revision_before,tombstone_revision,expected_revision,restore_generation,committed_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      receiptKey, actor, request.noteId, note.guard.projectId, contract.areaId,
      area.policyRevision, contract.noteRevision, nextRevision,
      request.expectedRevision, store.expectedRestoreGeneration, committedAt,
    );
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };
    context.commit({ kind: "note_delete", payload: {} });
    return { ok: true };
  }, denied, failed);
}
