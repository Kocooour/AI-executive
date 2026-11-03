/** Staging-only authorized, pinned note create/move journal writer.
 * Default-unused: there is no new route, UI hook or production activation.
 * A new user-visible sharing boundary must be explicitly confirmed.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { fingerprint } from "./target-task-staging-writer";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import { verifiedActor, type TargetStagingReadCredential } from "./target-task-authenticated-read";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import {
  isTargetStagingSessionTokenHash, lookupLiveTargetStagingSession,
} from "./target-staging-durable-session";
import {
  TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX,
  TARGET_STAGING_MAX_RECEIPTS, TARGET_STAGING_AUDIT_MAX_EVENTS,
} from "./target-store-bootstrap";
import { canWriteIsolatedTargetArea } from "./target-task-write-preflight";
import { previewTargetNoteWrite, checkTargetNoteWriteContract } from "./target-note-write-contract";
import { readAuthorizedTargetNote } from "./target-note-access";

type Common = {
  noteId: string; commandId: string; restoreGeneration: string;
  areaId: string; projectId: string | null;
};
export type TargetStagingNoteLifecycleRequest =
  | (Common & { kind: "create"; title: string; body: string })
  | (Common & { kind: "move"; writeAreaId: string;
      expectedRevision: string; confirmShare: boolean });
export type TargetStagingNoteLifecycleResult =
  | { ok: true; replayed?: true }
  | { ok: false; reason: "invalid_request" | "unauthorized" | "unavailable" |
      "resync_required" | "idempotency_conflict" | "stale_revision" |
      "write_area_mismatch" | "confirmation_required" | "unchanged" |
      "session_revoked" | "write_failed" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const safeId = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.trim() === value && value !== "." && value !== ".." &&
  value.isWellFormed() && Buffer.byteLength(value, "utf8") <= 512 &&
  !/[\u0000-\u001f\u007f]/u.test(value);

export function validTargetStagingNoteLifecycleRequest(
  value: unknown,
): value is TargetStagingNoteLifecycleRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (!safeId(r.noteId) || !safeId(r.areaId) ||
      !(r.projectId === null || safeId(r.projectId)) ||
      typeof r.commandId !== "string" || !UUID.test(r.commandId) ||
      typeof r.restoreGeneration !== "string" || !UUID.test(r.restoreGeneration)) return false;
  if (r.kind === "create") return Object.keys(r).sort().join(",") ===
    "areaId,body,commandId,kind,noteId,projectId,restoreGeneration,title" &&
    typeof r.title === "string" && r.title.trim().length > 0 &&
    Buffer.byteLength(r.title,"utf8") <= 4096 && !r.title.includes("\0") &&
    typeof r.body === "string" && Buffer.byteLength(r.body,"utf8") <= 131072 &&
    !r.body.includes("\0");
  if (r.kind === "move") return Object.keys(r).sort().join(",") ===
    "areaId,commandId,confirmShare,expectedRevision,kind,noteId,projectId,restoreGeneration,writeAreaId" &&
    typeof r.writeAreaId === "string" && safeId(r.writeAreaId) &&
    typeof r.expectedRevision === "string" && SHA.test(r.expectedRevision) &&
    typeof r.confirmShare === "boolean";
  return false;
}

function destination(db: DatabaseSync, areaId: string, projectId: string | null):
  { parentRevision: number | null; kind: string; policyRevision: number } | null {
  const row = db.prepare("SELECT a.kind AS kind, a.policy_revision AS policyRevision, "+
    "p.revision AS parentRevision FROM areas a "+
    "LEFT JOIN projects p ON p.area_id=a.id AND p.id=? WHERE a.id=?")
    .get(projectId,areaId) as
      { kind: string; policyRevision: number; parentRevision: number | null } | undefined;
  if (!row || !Number.isSafeInteger(row.policyRevision) || row.policyRevision<0) return null;
  if (projectId !== null && !Number.isSafeInteger(row.parentRevision)) return null;
  return row;
}

function receiptKey(actor: string, noteId: string, commandId: string): string {
  return TARGET_STAGING_NOTE_LIFECYCLE_RECEIPT_PREFIX +
    createHash("sha256").update(JSON.stringify([actor,noteId,commandId.toLowerCase()])).digest("hex");
}
function receiptDigest(r: TargetStagingNoteLifecycleRequest): string {
  return createHash("sha256").update(JSON.stringify([
    r.kind,r.noteId,r.areaId,r.projectId,r.restoreGeneration.toLowerCase(),
    r.kind === "create" ? [r.title,r.body] :
      [r.writeAreaId,r.expectedRevision,r.confirmShare],
  ])).digest("hex");
}
const denied = (): TargetStagingNoteLifecycleResult =>
  ({ ok:false, reason:"unauthorized" });
const failed = (): TargetStagingNoteLifecycleResult =>
  ({ ok:false, reason:"write_failed" });

export function changePreflightedTargetNoteLifecycle(
  store: TargetStagingReadStore,
  credential: TargetStagingReadCredential,
  request: TargetStagingNoteLifecycleRequest,
  durableSessionTokenHash?: string,
): TargetStagingNoteLifecycleResult {
  if (!validTargetStagingNoteLifecycleRequest(request))
    return { ok:false, reason:"invalid_request" };
  if (durableSessionTokenHash !== undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return denied();
  return withPinnedTargetStagingWrite<TargetStagingNoteLifecycleResult>(store, ctx => {
    const { db, databaseFd } = ctx;
    const actor = verifiedActor(db,credential,true);
    if (!actor) return denied();
    const sessionLive = () => durableSessionTokenHash === undefined ||
      lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now())?.userId === actor;
    if (!sessionLive()) return { ok:false, reason:"session_revoked" };
    const actualGeneration = (db.prepare("SELECT value FROM metadata WHERE key='restore_generation'")
      .get() as { value: string } | undefined)?.value;
    if (!actualGeneration ||
        request.restoreGeneration.toLowerCase() !== actualGeneration.toLowerCase() ||
        actualGeneration.toLowerCase() !== store.expectedRestoreGeneration.toLowerCase())
      return { ok:false, reason:"resync_required" };
    const dest = destination(db,request.areaId,request.projectId);
    if (!dest || !canWriteIsolatedTargetArea(db,actor,request.areaId))
      return { ok:false, reason:"unavailable" };

    // A completed command may have created the note or already moved it into
    // its destination. Recheck CURRENT note visibility and destination write
    // rights before acknowledging an actor-bound receipt; source CAS applies
    // only to fresh commands, never a confirmed replay.
    const key = receiptKey(actor,request.noteId,request.commandId);
    const digest = receiptDigest(request);
    const prior = db.prepare("SELECT value FROM metadata WHERE key=?")
      .get(key) as { value:string }|undefined;
    if (prior) {
      const existing = readAuthorizedTargetNote(db,{
        actorUserId:actor,noteId:request.noteId,
      });
      if (!existing || existing.guard.areaId !== request.areaId)
        return { ok:false, reason:"unavailable" };
      return prior.value === digest
        ? { ok:true,replayed:true } : {ok:false,reason:"idempotency_conflict"};
    }

    let oldArea: string | null = null;
    let oldProject: string | null = null;
    let oldRevision: number | null = null;
    if (request.kind === "move") {
      const preview = previewTargetNoteWrite(db,actor,request.noteId);
      if (!preview.ok) return { ok:false, reason:"unavailable" };
      if (preview.writeAreaId !== request.writeAreaId)
        return { ok:false, reason:"write_area_mismatch" };
      const source = db.prepare("SELECT kind FROM areas WHERE id=?")
        .get(request.writeAreaId) as { kind: string } | undefined;
      if (!source) return { ok:false, reason:"unavailable" };
      if (source.kind === "private" && dest.kind === "shared" &&
          !request.confirmShare) return { ok:false, reason:"confirmation_required" };
      // Receipt replays are never allowed to bypass CURRENT source ACL.
      const note = readAuthorizedTargetNote(db,{actorUserId:actor,noteId:request.noteId});
      if (!note) return { ok:false, reason:"unavailable" };
      oldArea = note.guard.areaId;
      oldProject = note.guard.projectId;
      oldRevision = note.note.revision;
    } else if (db.prepare("SELECT 1 FROM notes WHERE id=?").get(request.noteId) ||
        db.prepare("SELECT 1 FROM note_tombstones WHERE id=?").get(request.noteId))
      return { ok:false, reason:"unavailable" };

    if (request.kind === "move") {
      const cas = checkTargetNoteWriteContract(db,actor,{
        noteId:request.noteId, expectedRevision:request.expectedRevision,
        writeAreaId:request.writeAreaId,restoreGeneration:request.restoreGeneration,
      });
      if (!cas.ok) return { ok:false, reason:cas.reason };
      if (oldArea === request.areaId && oldProject === request.projectId)
        return { ok:false, reason:"unchanged" };
    }
    fingerprint(databaseFd);
    if (!ctx.stillPinned() || !ctx.noSidecars()) return denied();
    const n=(sql:string)=>(db.prepare(sql).get() as {n:number}).n;
    if (n("SELECT COUNT(*) AS n FROM note_lifecycle_audit") >= TARGET_STAGING_AUDIT_MAX_EVENTS ||
        n("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'r2:note-lifecycle-receipt-v1:%'") >=
          TARGET_STAGING_MAX_RECEIPTS) return failed();
    const now=Date.now();
    if (!Number.isSafeInteger(now) || now<=0) return failed();
    if (request.kind==="create") {
      const result=db.prepare("INSERT INTO notes(id,project_id,area_id,title,body) VALUES(?,?,?,?,?)")
        .run(request.noteId,request.projectId,request.projectId===null?request.areaId:null,
          request.title,request.body);
      if (result.changes !== 1) return failed();
    } else {
      const result=db.prepare("UPDATE notes SET project_id=?,area_id=? WHERE id=? AND revision=?")
        .run(request.projectId,request.projectId===null?request.areaId:null,
          request.noteId,oldRevision);
      if(result.changes!==1) return failed();
    }
    const after=db.prepare("SELECT revision FROM notes WHERE id=?")
      .get(request.noteId) as {revision:number}|undefined;
    const expectedRevision=request.kind==="create"?0:(oldRevision as number)+1;
    if(!after || after.revision!==expectedRevision) return failed();
    db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(key,digest);
    db.prepare("INSERT INTO note_lifecycle_audit("+
      "receipt_key,kind,actor_user_id,note_id,old_area_id,area_id,old_project_id,project_id,"+
      "parent_revision,policy_revision,revision_before,revision_after,restore_generation,committed_at_ms)"+
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        key,request.kind,actor,request.noteId,oldArea,request.areaId,oldProject,request.projectId,
        dest.parentRevision,dest.policyRevision,oldRevision,expectedRevision,
        actualGeneration,now);
    if(!sessionLive())return{ok:false,reason:"session_revoked"};
    ctx.commit({kind:request.kind==="create"?"note_create":"note_move",payload:{}});
    return {ok:true};
  },denied,failed);
}
