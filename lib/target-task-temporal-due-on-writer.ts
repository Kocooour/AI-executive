/**
 * R2d.3i.1: staging-only, idempotent date-only dueOn mutation.
 * No HTTP/UI/production activation or personal today/when preference here.
 * Actor is derived from a live writable authority credential, never input.
 */
import {createHash} from "node:crypto";
import {
  TARGET_STAGING_MAX_RECEIPTS,TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX,
} from "./target-store-bootstrap";
import {isTargetStagingSessionTokenHash,lookupLiveTargetStagingSession}
  from "./target-staging-durable-session";
import {withPinnedTargetStagingWrite} from "./target-staging-pinned-write";
import {verifiedActor} from "./target-task-authenticated-read";
import type {TargetStagingReadCredential} from "./target-task-authenticated-read";
import type {TargetStagingReadStore} from "./target-task-staging-reader";
import {fingerprint} from "./target-task-staging-writer";
import {
  checkTargetTaskWriteContract,targetTaskWriteRevision,
  validTargetTaskTitleEditPreviewRequest,
} from "./target-task-write-preflight";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AREA=/^[A-Za-z0-9_.:@-]{1,120}$/;
/** ISO 8601 calendar date, no timezone, locale, rollover or offset. */
export function validTargetDueOn(value:unknown):value is string|null {
  if (value===null) return true;
  if (typeof value!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const year=Number(value.slice(0,4));
  const month=Number(value.slice(5,7));
  const day=Number(value.slice(8,10));
  if (year<1||month<1||month>12||day<1) return false;
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  return day<=days[month-1];
}

export interface TargetStagingTemporalDueOnCommand {
  readonly commandId:string;
  readonly taskId:string;
  /** Date-only for all Area-visible task readers, null clears date. */
  readonly dueOn:string|null;
  readonly expectedRevision:string;
  readonly writeAreaId:string;
  readonly restoreGeneration:string;
}
export type TargetStagingTemporalDueOnResult =
  | {ok:true;replayed?:true}
  | {ok:false;reason:"invalid_request"|"unauthorized"|"unavailable"|
      "stale_revision"|"idempotency_conflict"|"unchanged"|"write_failed"|
      "session_revoked"|"resync_required"|"write_area_mismatch"};

const denied=():TargetStagingTemporalDueOnResult=>({ok:false,reason:"unauthorized"});
const failed=():TargetStagingTemporalDueOnResult=>({ok:false,reason:"write_failed"});

export function validTargetStagingTemporalDueOnCommand(
  input:unknown,
):input is TargetStagingTemporalDueOnCommand {
  if (!input||typeof input!=="object"||Array.isArray(input)) return false;
  const cmd=input as Record<string,unknown>;
  return Object.keys(cmd).sort().join(",")===
      "commandId,dueOn,expectedRevision,restoreGeneration,taskId,writeAreaId" &&
    typeof cmd.commandId==="string"&&UUID.test(cmd.commandId) &&
    validTargetDueOn(cmd.dueOn) &&
    typeof cmd.writeAreaId==="string"&&AREA.test(cmd.writeAreaId) &&
    typeof cmd.restoreGeneration==="string"&&UUID.test(cmd.restoreGeneration) &&
    validTargetTaskTitleEditPreviewRequest({
      taskId:cmd.taskId,expectedRevision:cmd.expectedRevision,
    });
}

export function temporalDueOnReceiptKey(
  actor:string,taskId:string,commandId:string,
):string {
  return TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX+createHash("sha256")
    .update(JSON.stringify(["temporal-due-on-v1",actor,taskId,commandId.toLowerCase()]))
    .digest("hex");
}
export function temporalDueOnReceiptDigest(
  command:TargetStagingTemporalDueOnCommand,
):string {
  return createHash("sha256").update(JSON.stringify([
    "temporal-due-on-v1",command.taskId,command.dueOn,command.expectedRevision,
    command.writeAreaId,command.restoreGeneration.toLowerCase(),
  ])).digest("hex");
}

export function writePreflightedTemporalDueOn(
  store:TargetStagingReadStore,
  credential:TargetStagingReadCredential,
  command:TargetStagingTemporalDueOnCommand,
  durableSessionTokenHash?:string,
):TargetStagingTemporalDueOnResult {
  if (!validTargetStagingTemporalDueOnCommand(command))
    return {ok:false,reason:"invalid_request"};
  if (durableSessionTokenHash!==undefined &&
      !isTargetStagingSessionTokenHash(durableSessionTokenHash)) return denied();

  return withPinnedTargetStagingWrite<TargetStagingTemporalDueOnResult>(
    store, context=>{
      const {db,databaseFd}=context;
      const actor=verifiedActor(db,credential,true);
      if (!actor) return denied();
      const sessionLive=():boolean=>{
        if (durableSessionTokenHash===undefined) return true;
        const live=lookupLiveTargetStagingSession(db,durableSessionTokenHash,Date.now());
        return live!==null&&live.userId===actor;
      };
      if (!sessionLive()) return {ok:false,reason:"session_revoked"};
      // Authorization and explicit task/Area contract precede *all* receipt
      // lookups, including UUID replays after role revocation or task move.
      const contract=checkTargetTaskWriteContract(db,actor,command);
      if (contract.ok === false) return {ok:false,reason:contract.reason};
      const receipt=temporalDueOnReceiptKey(actor,command.taskId,command.commandId);
      const digest=temporalDueOnReceiptDigest(command);
      const prior=db.prepare("SELECT value FROM metadata WHERE key=?")
        .get(receipt) as {value:string}|undefined;
      if (prior) return prior.value===digest
        ? {ok:true,replayed:true}:{ok:false,reason:"idempotency_conflict"};

      fingerprint(databaseFd);
      if (targetTaskWriteRevision(db,command.taskId)!==command.expectedRevision)
        return {ok:false,reason:"stale_revision"};
      const row=db.prepare(
        "SELECT due_on AS dueOn,revision,status,completed_at_ms AS completedAtMs FROM tasks WHERE id=?"
      ).get(command.taskId) as {
        dueOn:string|null;revision:number;status:string;completedAtMs:number|null;
      }|undefined;
      if (!row||!Number.isSafeInteger(row.revision)||row.revision<0||
          !validTargetDueOn(row.dueOn) ||
          !((row.status==="open"&&row.completedAtMs===null)||
            (row.status==="completed"&&Number.isSafeInteger(row.completedAtMs))))
        return failed();
      if (row.dueOn===command.dueOn) return {ok:false,reason:"unchanged"};
      if (!context.stillPinned()||!context.noSidecars()) return denied();
      const existing=db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE ?")
        .get(TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX+"%") as {n:number};
      if (existing.n>=TARGET_STAGING_MAX_RECEIPTS) return failed();
      const changed=db.prepare("UPDATE tasks SET due_on=? WHERE id=?")
        .run(command.dueOn,command.taskId);
      if (changed.changes!==1) return failed();
      const next=db.prepare("SELECT revision,status,completed_at_ms AS completedAtMs FROM tasks WHERE id=?")
        .get(command.taskId) as {revision:number;status:string;completedAtMs:number|null}|undefined;
      if (!next||next.revision!==row.revision+1||
          next.status!==row.status||next.completedAtMs!==row.completedAtMs) return failed();
      db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)").run(receipt,digest);
      if (!sessionLive()||!context.stillPinned())
        return {ok:false,reason:"session_revoked"};
      // Content-free journal: the date itself, task ID and actor never appear.
      context.commit({kind:"temporal_due_on",payload:{
        receiptHash:receipt.slice(TARGET_STAGING_TEMPORAL_DUE_ON_RECEIPT_PREFIX.length),
        revision:next.revision,set:command.dueOn===null?0:1,
      }});
      return {ok:true};
    },denied,failed);
}
