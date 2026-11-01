/**
 * R2d.2c.2a: actual, isolated staging-only UPDATE of an EXISTING note.
 * Never wire this directly to HTTP: trusted server code must supply a verified,
 * write-audience session credential and a canonical pinned store. Parent/Area
 * are not writable here. No create/delete/sync/UI/production activation.
 *
 * A signed preview is NOT authority. Recheck effective ACL, note/project
 * revision, Area policy and restore generation inside one pinned BEGIN IMMEDIATE.
 * The content edit, opaque receipt and content-free audit are atomic, including
 * rollback on revocation, pin failure or audit exhaustion.
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
  TARGET_STAGING_NOTE_RECEIPT_PREFIX, TARGET_STAGING_MAX_RECEIPTS,
  TARGET_STAGING_AUDIT_MAX_EVENTS,
} from "./target-store-bootstrap";
import {
  checkTargetNoteWriteContract, previewTargetNoteWrite,
  validTargetNoteWriteContractRequest, type TargetNoteWriteContractRequest,
} from "./target-note-write-contract";
import { readAuthorizedTargetNote } from "./target-note-access";
import { canWriteIsolatedTargetArea } from "./target-task-write-preflight";

const COMMAND = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface TargetStagingNoteEditRequest extends TargetNoteWriteContractRequest {
  readonly commandId: string;
  readonly title: string;
  readonly body: string;
}
export type TargetStagingNoteEditResult =
  | { ok: true; replayed?: true }
  | { ok: false; reason:
      "invalid_request" | "unauthorized" | "unavailable" | "resync_required" |
      "write_area_mismatch" | "stale_revision" | "unchanged" |
      "idempotency_conflict" | "session_revoked" | "write_failed" };
const denied = (): TargetStagingNoteEditResult => ({ ok: false, reason: "unauthorized" });
const failed = (): TargetStagingNoteEditResult => ({ ok: false, reason: "write_failed" });

export function validTargetStagingNoteEditRequest(value: unknown): value is TargetStagingNoteEditRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join(",") !==
      "body,commandId,expectedRevision,noteId,restoreGeneration,title,writeAreaId" ||
      typeof request.commandId !== "string" || !COMMAND.test(request.commandId) ||
      typeof request.title !== "string" || request.title.trim().length === 0 ||
      Buffer.byteLength(request.title, "utf8") > 4096 ||
      typeof request.body !== "string" || Buffer.byteLength(request.body, "utf8") > 131072 ||
      request.title.includes("\0") || request.body.includes("\0")) return false;
  return validTargetNoteWriteContractRequest({
    noteId: request.noteId, expectedRevision: request.expectedRevision,
    writeAreaId: request.writeAreaId, restoreGeneration: request.restoreGeneration,
  });
}

/** The note ID and command ID are hidden behind a one-way key; never use raw IDs as metadata keys. */
export function targetNoteEditReceiptKey(actor: string, noteId: string, commandId: string): string {
  return TARGET_STAGING_NOTE_RECEIPT_PREFIX + createHash("sha256")
    .update(JSON.stringify([actor, noteId, commandId.toLowerCase()])).digest("hex");
}
/** Digest exact semantics, including requested Area, generation and note content. */
export function targetNoteEditReceiptDigest(request: TargetStagingNoteEditRequest): string {
  return createHash("sha256").update(JSON.stringify([
    request.noteId, request.title, request.body, request.expectedRevision,
    request.writeAreaId, request.restoreGeneration.toLowerCase(),
  ])).digest("hex");
}

export function editPreflightedTargetNote(
  store: TargetStagingReadStore,
  access: TargetStagingReadCredential,
  request: TargetStagingNoteEditRequest,
  durableSessionTokenHash?: string,
): TargetStagingNoteEditResult {
  if (!validTargetStagingNoteEditRequest(request)) return { ok: false, reason: "invalid_request" };
  if (durableSessionTokenHash !== undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return denied();

  return withPinnedTargetStagingWrite<TargetStagingNoteEditResult>(store, context => {
    const { db, databaseFd } = context;
    const actor = verifiedActor(db, access, true);
    if (!actor) return denied();
    const sessionLive = (): boolean => {
      if (durableSessionTokenHash === undefined) return true;
      const live = lookupLiveTargetStagingSession(db, durableSessionTokenHash, Date.now());
      return live !== null && live.userId === actor;
    };
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };

    // ACL before receipt lookup. A deleted/moved/foreign note, nonmember and
    // viewer must not use a known command UUID to learn whether it committed.
    const current = previewTargetNoteWrite(db, actor, request.noteId);
    if (!current.ok) return { ok: false, reason: "unavailable" };
    if (!canWriteIsolatedTargetArea(db, actor, request.writeAreaId)) {
      return { ok: false, reason: "unavailable" };
    }
    if (request.writeAreaId !== current.writeAreaId) {
      return { ok: false, reason: "write_area_mismatch" };
    }
    if (request.restoreGeneration.toLowerCase() !== current.restoreGeneration.toLowerCase()) {
      return { ok: false, reason: "resync_required" };
    }
    const receiptKey = targetNoteEditReceiptKey(actor, request.noteId, request.commandId);
    const receiptDigest = targetNoteEditReceiptDigest(request);
    const prior = db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(receiptKey) as { value: string } | undefined;
    if (prior) return prior.value === receiptDigest
      ? { ok: true, replayed: true } : { ok: false, reason: "idempotency_conflict" };

    // Only a brand-new command requires unchanged optimistic revision.
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
    if (note.note.title === request.title && note.note.body === request.body) {
      return { ok: false, reason: "unchanged" };
    }
    if (!context.stillPinned() || !context.noSidecars()) return denied();
    const receiptCount = db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
      .get(TARGET_STAGING_NOTE_RECEIPT_PREFIX + "%") as { n: number };
    const auditCount = db.prepare("SELECT COUNT(*) AS n FROM note_edit_audit").get() as { n: number };
    if (receiptCount.n >= TARGET_STAGING_MAX_RECEIPTS ||
        auditCount.n >= TARGET_STAGING_AUDIT_MAX_EVENTS) return failed();
    const committedAt = Date.now();
    if (!Number.isSafeInteger(committedAt) || committedAt <= 0) return failed();
    const update = db.prepare("UPDATE notes SET title=?,body=? WHERE id=? AND revision=?")
      .run(request.title, request.body, request.noteId, contract.noteRevision);
    const after = db.prepare("SELECT revision FROM notes WHERE id=?")
      .get(request.noteId) as { revision: number } | undefined;
    if (update.changes !== 1 || !after || after.revision !== contract.noteRevision + 1) return failed();

    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receiptKey, receiptDigest);
    db.prepare(`INSERT INTO note_edit_audit (
      receipt_key,actor_user_id,note_id,project_id,area_id,policy_revision,
      revision_before,revision_after,expected_revision,restore_generation,committed_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      receiptKey, actor, request.noteId, note.guard.projectId,
      contract.areaId, area.policyRevision, contract.noteRevision, after.revision,
      request.expectedRevision, store.expectedRestoreGeneration, committedAt,
    );
    if (!sessionLive()) return { ok: false, reason: "session_revoked" };
    context.commit({ kind: "note_edit", payload: {} });
    return { ok: true };
  }, denied, failed);
}
