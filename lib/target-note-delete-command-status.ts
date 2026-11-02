/**
 * R2d.2c.2f.4 — read-only reconciliation of one exact staging note DELETE.
 * A command UUID is not an authorization token. The actor must still have a
 * current edit right and, after deletion, must own the exact durable receipt.
 * Never reveal content, tombstone metadata or another actor's receipts.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  validTargetStagingNoteDeleteRequest, targetNoteDeleteReceiptKey,
  targetNoteDeleteReceiptDigest, type TargetStagingNoteDeleteRequest,
} from "./target-note-delete-writer";
import { previewTargetNoteWrite } from "./target-note-write-contract";
import { canWriteIsolatedTargetArea, targetStoreRestoreGeneration } from "./target-task-write-preflight";

export type TargetNoteDeleteCommandStatus =
  | { ok: true; status: "committed" | "not_recorded" }
  | { ok: false; reason:
      "invalid_request" | "unavailable" | "resync_required" |
      "write_area_mismatch" | "idempotency_conflict" };

export function readTargetNoteDeleteCommandStatus(
  db: DatabaseSync, actor: string, request: TargetStagingNoteDeleteRequest,
): TargetNoteDeleteCommandStatus {
  if (!validTargetStagingNoteDeleteRequest(request))
    return { ok: false, reason: "invalid_request" };
  const generation = targetStoreRestoreGeneration(db);
  if (!generation || generation !== request.restoreGeneration.toLowerCase())
    return { ok: false, reason: "resync_required" };

  // Live-note status may return not_recorded, but only to a current editor.
  // For a deleted note, the receipt must be proven FIRST, before looking up a
  // tombstone or its Area, so nobody can probe the existence of another delete.
  const current = previewTargetNoteWrite(db, actor, request.noteId);
  const key = targetNoteDeleteReceiptKey(actor, request.noteId, request.commandId);
  if (!current.ok) {
    const own = db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(key) as { value: string } | undefined;
    if (!own) return { ok: false, reason: "unavailable" };
    const tomb = db.prepare("SELECT area_id FROM note_tombstones WHERE id=?")
      .get(request.noteId) as { area_id: string } | undefined;
    if (!tomb || !canWriteIsolatedTargetArea(db, actor, tomb.area_id) ||
        !canWriteIsolatedTargetArea(db, actor, request.writeAreaId))
      return { ok: false, reason: "unavailable" };
    if (tomb.area_id !== request.writeAreaId)
      return { ok: false, reason: "write_area_mismatch" };
    return own.value === targetNoteDeleteReceiptDigest(request)
      ? { ok: true, status: "committed" }
      : { ok: false, reason: "idempotency_conflict" };
  }
  if (!canWriteIsolatedTargetArea(db, actor, request.writeAreaId))
    return { ok: false, reason: "unavailable" };
  if (current.writeAreaId !== request.writeAreaId)
    return { ok: false, reason: "write_area_mismatch" };
  const prior = db.prepare("SELECT value FROM metadata WHERE key=?")
    .get(key) as { value: string } | undefined;
  if (!prior) return { ok: true, status: "not_recorded" };
  return prior.value === targetNoteDeleteReceiptDigest(request)
    ? { ok: true, status: "committed" }
    : { ok: false, reason: "idempotency_conflict" };
}
