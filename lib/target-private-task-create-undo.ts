/** #397: time-bounded Undo of a Quick Capture task the server just confirmed.
 *
 * Undo is NOT authorized by the CREATE receipt. It is an ordinary authorized
 * task delete: a fresh actor/Area-ACL read, the task CAS token, and the
 * existing exactly-once delete command with its read-only receipt. Undo only
 * proceeds while the task still has the exact revision observed right after
 * creation, so it never deletes a task the user has since edited, completed,
 * moved, or that someone else changed. Nothing is stored in browser storage.
 * The baseline is read when the notice appears, which is offered only for this
 * page's own just-confirmed command (never after a reload recovery). A personal
 * "Kdy" plan does not change the task revision, so it does not block Undo.
 * Callers pass a deadline-bound signal: an abort before dispatch is "failed",
 * after dispatch it stays "uncertain" and is resolved only via the receipt. */
import {readStagingTaskPreview} from "./target-staging-task-preview-client";
import {buildTaskDeleteCommand,checkTaskDeleteReceipt,dispatchTaskDelete,
  readTaskWriteContext,type TaskDeleteCommand} from "./target-staging-edit-clients";

/** How long the notice offers Undo after the server confirmed the task. */
export const PRIVATE_TASK_UNDO_WINDOW_MS=60_000;

export type UndoBaseline={taskId:string;areaId:string;revision:string};
export type UndoBaselineResult={ok:true;baseline:UndoBaseline}|{ok:false};
export type UndoOutcome=
  |{kind:"deleted"}
  |{kind:"changed"}       // edited/completed/moved since creation: never delete
  |{kind:"gone"}          // already deleted or no longer readable by this actor
  |{kind:"signed-out"}
  |{kind:"uncertain";command:TaskDeleteCommand} // dispatched, result unknown
  |{kind:"failed"};       // nothing was dispatched; a new attempt is safe

const REVISION=/^[a-f0-9]{64}$/;

/** Read once when the notice appears: the exact revision Undo is bound to.
 * Only an open, private task with a CAS token qualifies; otherwise no Undo. */
export async function readPrivateTaskUndoBaseline(
  taskId:string,fetchImpl:typeof fetch,signal:AbortSignal,
):Promise<UndoBaselineResult>{
  const seen=await readStagingTaskPreview(taskId,signal,fetchImpl);
  if(seen.ok===false||seen.task.id!==taskId||seen.task.status!=="open"||
     seen.task.areaKind!=="private"||typeof seen.expectedRevision!=="string"||
     !REVISION.test(seen.expectedRevision))return {ok:false};
  return {ok:true,baseline:{taskId,areaId:seen.task.areaId,revision:seen.expectedRevision}};
}

/** Delete the just-created task if, and only if, it is still exactly as created.
 * Dispatches at most one delete command; an ambiguous result is confirmed only
 * through that command's read-only receipt and is never resent. */
export async function undoPrivateTaskCreate(
  baseline:UndoBaseline,fetchImpl:typeof fetch,signal:AbortSignal,
):Promise<UndoOutcome>{
  const seen=await readStagingTaskPreview(baseline.taskId,signal,fetchImpl);
  if(seen.ok===false){
    if(seen.reason==="signed-out")return {kind:"signed-out"};
    if(seen.reason==="not-found"||seen.reason==="disabled")return {kind:"gone"};
    return {kind:"failed"};
  }
  if(seen.task.status!=="open"||seen.task.areaId!==baseline.areaId||
     seen.task.areaKind!=="private"||seen.expectedRevision!==baseline.revision)
    return {kind:"changed"};
  const context=await readTaskWriteContext(baseline.taskId,baseline.areaId,fetchImpl,signal);
  if(context.ok===false){
    if(context.reason==="signed-out")return {kind:"signed-out"};
    if(context.reason==="not-available")return {kind:"gone"};
    if(context.reason==="conflict")return {kind:"changed"};
    return {kind:"failed"};
  }
  if(context.context.expectedRevision!==baseline.revision)return {kind:"changed"};
  const command=buildTaskDeleteCommand(baseline.taskId,context.context);
  if(!command)return {kind:"failed"};
  const result=await dispatchTaskDelete(command,fetchImpl,signal);
  if(result.kind==="committed")return {kind:"deleted"};
  // dispatch() already asked the receipt once: never claim "not removed" here.
  if(result.kind==="uncertain")return {kind:"uncertain",command};
  // Only 400/409/429 are definitive pre-commit refusals.
  if(result.reason==="conflict")return {kind:"changed"};
  return {kind:"failed"};
}

/** Read-only confirmation of an earlier ambiguous Undo; never a new delete. */
export async function confirmPrivateTaskUndo(
  command:TaskDeleteCommand,fetchImpl:typeof fetch,signal:AbortSignal,
):Promise<UndoOutcome>{
  const receipt=await checkTaskDeleteReceipt(command,fetchImpl,signal);
  if(receipt.kind==="committed")return {kind:"deleted"};
  // No receipt: the delete was not recorded. A later write is guarded by CAS,
  // so offering a fresh attempt cannot delete a changed task.
  if(receipt.kind==="not-recorded")return {kind:"failed"};
  // After a dispatch even a 401 may follow a real commit: stay uncertain.
  return {kind:"uncertain",command};
}
