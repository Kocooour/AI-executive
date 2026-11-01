/**
 * R2d.2c.2e — read-only reconciliation of an uncertain note edit.
 * Must run inside a canonical preflighted read snapshot with an authenticated
 * write-audience actor. A UUID alone is never a receipt lookup capability.
 */
import type { DatabaseSync } from "node:sqlite";
import { previewTargetNoteWrite } from "./target-note-write-contract";
import {
  validTargetStagingNoteEditRequest, targetNoteEditReceiptDigest,
  targetNoteEditReceiptKey, type TargetStagingNoteEditRequest,
} from "./target-note-staging-writer";
import { canWriteIsolatedTargetArea } from "./target-task-write-preflight";

export type TargetNoteEditCommandStatus =
  | { ok: true; status: "committed" | "not_recorded" }
  | { ok: false; reason:
      "invalid_request" | "unavailable" | "idempotency_conflict" |
      "resync_required" | "write_area_mismatch" };

/**
 * Revalidate CURRENT note, inherited project Area and write ACL before touching
 * receipt metadata. A successful command may already have advanced the note
 * revision, so DO NOT compare the old optimistic expectedRevision with today's.
 */
export function readTargetNoteEditCommandStatus(
  db: DatabaseSync, actor: string, request: TargetStagingNoteEditRequest,
): TargetNoteEditCommandStatus {
  if (!validTargetStagingNoteEditRequest(request))
    return { ok: false, reason: "invalid_request" };
  const current = previewTargetNoteWrite(db, actor, request.noteId);
  if (!current.ok || !canWriteIsolatedTargetArea(db, actor, request.writeAreaId))
    return { ok: false, reason: "unavailable" };
  if (request.writeAreaId !== current.writeAreaId)
    return { ok: false, reason: "write_area_mismatch" };
  if (request.restoreGeneration.toLowerCase() !== current.restoreGeneration.toLowerCase())
    return { ok: false, reason: "resync_required" };
  const row = db.prepare("SELECT value FROM metadata WHERE key=?").get(
    targetNoteEditReceiptKey(actor, request.noteId, request.commandId),
  ) as { value: string } | undefined;
  if (!row) return { ok: true, status: "not_recorded" };
  return row.value === targetNoteEditReceiptDigest(request)
    ? { ok: true, status: "committed" }
    : { ok: false, reason: "idempotency_conflict" };
}
