/** Actor-scoped, read-only CREATE receipt lookup. UUID is not authority. */
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {TARGET_STAGING_AUDIT_MAX_EVENTS,TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX} from "./target-store-bootstrap";
import {readAuthorizedTargetNote} from "./target-note-access";
import {canWriteIsolatedTargetArea} from "./target-task-write-preflight";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type TargetNoteCreateRecovery=
  |{ok:true;status:"not_recorded"}
  |{ok:true;status:"committed";noteId:string;areaId:string}
  |{ok:false;reason:"unavailable"};
export function readTargetNoteCreateRecovery(
  db:DatabaseSync,actor:string,commandId:string,
):TargetNoteCreateRecovery{
  const denied=():TargetNoteCreateRecovery=>({ok:false,reason:"unavailable"});
  if(!UUID.test(commandId))return denied();
  const rows=db.prepare(
    "SELECT note_id AS noteId,area_id AS areaId,restore_generation AS generation,"+
    "receipt_key AS receiptKey FROM note_lifecycle_audit "+
    "WHERE kind='create' AND actor_user_id=? LIMIT ?",
  ).all(actor,TARGET_STAGING_AUDIT_MAX_EVENTS+1) as {
    noteId:string;areaId:string;generation:string;receiptKey:string;
  }[];
  if(rows.length>TARGET_STAGING_AUDIT_MAX_EVENTS)return denied();
  for(const row of rows){
    const key=TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX+
      createHash("sha256").update(JSON.stringify([
        actor,row.noteId,commandId.toLowerCase(),
      ])).digest("hex");
    if(row.receiptKey!==key)continue;
    const currentGeneration=(db.prepare(
      "SELECT value FROM metadata WHERE key='restore_generation'",
    ).get() as {value?:unknown}|undefined)?.value;
    if(typeof currentGeneration!=="string"||
      row.generation.toLowerCase()!==currentGeneration.toLowerCase())
      return denied();
    const note=readAuthorizedTargetNote(db,{actorUserId:actor,noteId:row.noteId});
    if(!note||note.guard.areaId!==row.areaId||
      note.guard.projectId!==null||note.note.areaKind!=="private"||
      note.linearization.areas[0]?.access!=="private-owner"||
      !canWriteIsolatedTargetArea(db,actor,row.areaId))return denied();
    return {ok:true,status:"committed",noteId:row.noteId,areaId:row.areaId};
  }
  // Missing audit can never prove an earlier network request cannot commit.
  return {ok:true,status:"not_recorded"};
}
