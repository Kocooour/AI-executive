/** Staging-only project title command; preflight, ACL, revision, receipt and
 * mutation share the pinned write transaction. */
import { createHash } from "node:crypto";
import { isReadableStagingProjectId } from "./target-project-id";
import { readAuthorizedProjectTasksPage } from "./target-project-task-read-model";
import { canWriteIsolatedTargetArea, targetStoreRestoreGeneration } from "./target-task-write-preflight";
import { verifiedActor, type TargetStagingReadCredential } from "./target-task-authenticated-read";
import { isTargetStagingSessionTokenHash, lookupLiveTargetStagingSession } from "./target-staging-durable-session";
import { withPinnedTargetStagingWrite } from "./target-staging-pinned-write";
import type { TargetStagingReadStore } from "./target-task-staging-reader";
import { TARGET_STORE_SCHEMA_VERSION } from "./target-store-bootstrap";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const area = /^[A-Za-z0-9_.:@-]{1,120}$/;
function validTitle(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value ||
      value.includes("\0") || Buffer.byteLength(value, "utf8") > 4096) return false;
  try { return decodeURIComponent(encodeURIComponent(value)) === value; }
  catch { return false; }
}
export type ProjectTitleCommand = { commandId: string; projectId: string; title: string; expectedRevision: string; writeAreaId: string; restoreGeneration: string };
export type ProjectTitleResult = {ok: true; replayed?: true} | {ok: false; reason: "invalid_request" | "unauthorized" | "unavailable" | "session_revoked" | "resync_required" | "write_area_mismatch" | "stale_revision" | "idempotency_conflict" | "unchanged" | "write_failed"};
export function validProjectTitleCommand(input: unknown): input is ProjectTitleCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const v = input as Record<string, unknown>;
  return Object.keys(v).sort().join(",") === "commandId,expectedRevision,projectId,restoreGeneration,title,writeAreaId" &&
    typeof v.commandId === "string" && uuid.test(v.commandId) && isReadableStagingProjectId(v.projectId) &&
    typeof v.expectedRevision === "string" && hash.test(v.expectedRevision) &&
    typeof v.restoreGeneration === "string" && uuid.test(v.restoreGeneration) &&
    typeof v.writeAreaId === "string" && area.test(v.writeAreaId) && validTitle(v.title);
}
export function writeTargetProjectTitle(store: TargetStagingReadStore, access: TargetStagingReadCredential,
  command: ProjectTitleCommand, durableSessionTokenHash?: string): ProjectTitleResult {
  if (!validProjectTitleCommand(command)) return {ok:false, reason:"invalid_request"};
  if (durableSessionTokenHash !== undefined && !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return {ok:false,reason:"unauthorized"};
  const denied = (): ProjectTitleResult => ({ok:false,reason:"unauthorized"});
  const failed = (): ProjectTitleResult => ({ok:false,reason:"write_failed"});
  return withPinnedTargetStagingWrite<ProjectTitleResult>(store, context => {
    const {db} = context;
    const actor = verifiedActor(db, access, true);
    if (!actor) return denied();
    const sessionLive = () => durableSessionTokenHash === undefined ||
      lookupLiveTargetStagingSession(db, durableSessionTokenHash, Date.now())?.userId === actor;
    if (!sessionLive()) return {ok:false,reason:"session_revoked"};
    if (targetStoreRestoreGeneration(db) !== command.restoreGeneration.toLowerCase()) return {ok:false,reason:"resync_required"};
    const page = readAuthorizedProjectTasksPage(db, {actorUserId: actor, projectId: command.projectId, limit:1, offset:0, restoreGeneration: command.restoreGeneration.toLowerCase()});
    if (!page?.ok || !canWriteIsolatedTargetArea(db, actor, page.page.project.areaId)) return {ok:false,reason:"unavailable"};
    if (!canWriteIsolatedTargetArea(db, actor, command.writeAreaId)) return {ok:false,reason:"unavailable"};
    if (command.writeAreaId !== page.page.project.areaId) return {ok:false,reason:"write_area_mismatch"};
    const version = db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get() as {value: string} | undefined;
    if (version?.value !== String(TARGET_STORE_SCHEMA_VERSION)) return {ok:false,reason:"write_failed"};
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const key = digest(["lumi:project-title", actor, command.projectId, command.commandId.toLowerCase()]);
    const payload = digest([command.projectId, command.title, command.expectedRevision]);
    const prior = db.prepare("SELECT request_digest FROM project_title_audit WHERE receipt_key=?").get(key) as {request_digest:string} | undefined;
    if (prior) {
      if (!sessionLive()) return {ok:false,reason:"session_revoked"};
      return prior.request_digest === payload ? {ok:true,replayed:true} : {ok:false,reason:"idempotency_conflict"};
    }
    if (page.page.revision !== command.expectedRevision) {
      if (!sessionLive()) return {ok:false,reason:"session_revoked"};
      return {ok:false,reason:"stale_revision"};
    }
    const before = db.prepare(`SELECT p.title, p.revision, a.policy_revision FROM projects p JOIN areas a ON a.id=p.area_id WHERE p.id=?`).get(command.projectId) as {title:string;revision:number;policy_revision:number} | undefined;
    if (!before) return failed();
    if (before.title === command.title) {
      if (!sessionLive()) return {ok:false,reason:"session_revoked"};
      return {ok:false,reason:"unchanged"};
    }
    if (!context.stillPinned() || !context.noSidecars()) return denied();
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now <= 0) return failed();
    if (db.prepare("UPDATE projects SET title=? WHERE id=?").run(command.title, command.projectId).changes !== 1) return failed();
    const after = db.prepare("SELECT revision FROM projects WHERE id=?").get(command.projectId) as {revision:number} | undefined;
    if (!after || after.revision !== before.revision + 1) return failed();
    db.prepare(`INSERT INTO project_title_audit(receipt_key,request_digest,actor_user_id,project_id,area_id,policy_revision,revision_before,revision_after,expected_revision,restore_generation,committed_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(key,payload,actor,command.projectId,command.writeAreaId,before.policy_revision,before.revision,after.revision,command.expectedRevision,store.expectedRestoreGeneration,now);
    if (!sessionLive()) return {ok:false,reason:"session_revoked"};
    // COMMIT may have persisted the rename even when journal confirmation is untrusted.
    // Never acknowledge success in that case; callers must treat the reply as uncertain
    // and retry the exact same idempotency key only after the store is trusted again.
    const confirmed = context.commit({kind:"project_title",payload:{}});
    return confirmed ? {ok:true} : failed();
  }, denied, failed);
}
