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
import {TARGET_STAGING_AUDIT_MAX_EVENTS} from "./target-store-bootstrap";

export type TargetNoteEditCommandStatus =
  | { ok: true; status: "committed" | "not_recorded" }
  | { ok: false; reason:
      "invalid_request" | "unavailable" | "idempotency_conflict" |
      "resync_required" | "write_area_mismatch" };

const commandUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type TargetNoteEditRecovery =
  | {ok:true;status:"not_recorded"}
  | {ok:true;status:"committed";noteId:string;areaId:string}
  | {ok:false;reason:"unavailable"};

/** An opaque UUID is merely a correlation ID, not permission to inspect a receipt.
 * Look up only the current signed writer's immutable audit, then enforce live
 * note/Area ACL and store generation before returning a committed result.
 * Absence of audit is never proof that an earlier PATCH cannot still commit. */
export function readTargetNoteEditRecovery(
  db:DatabaseSync,actor:string,commandId:string,
):TargetNoteEditRecovery{
  if(!commandUuid.test(commandId))return {ok:false,reason:"unavailable"};
  const rows=db.prepare(
    "SELECT note_id,area_id,restore_generation,receipt_key FROM note_edit_audit WHERE actor_user_id=? LIMIT ?",
  ).all(actor,TARGET_STAGING_AUDIT_MAX_EVENTS+1) as {
    note_id:string;area_id:string;restore_generation:string;receipt_key:string;
  }[];
  if(rows.length>TARGET_STAGING_AUDIT_MAX_EVENTS)return {ok:false,reason:"unavailable"};
  for(const row of rows){
    if(row.receipt_key!==targetNoteEditReceiptKey(actor,row.note_id,commandId))continue;
    const current=previewTargetNoteWrite(db,actor,row.note_id);
    if(!current.ok||!canWriteIsolatedTargetArea(db,actor,row.area_id)||
       current.writeAreaId!==row.area_id||
       current.restoreGeneration.toLowerCase()!==row.restore_generation.toLowerCase())
      return {ok:false,reason:"unavailable"};
    return {ok:true,status:"committed",noteId:row.note_id,areaId:row.area_id};
  }
  return {ok:true,status:"not_recorded"};
}

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
