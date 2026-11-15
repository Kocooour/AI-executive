/** R3 UI-03b: recoverable, actor-bound Undo preparation.
 * Checks the *original* completion receipt under the current session, then
 * obtains a fresh CAS for a NEW reversal UUID. This function NEVER sends PATCH.
 * Callers preserve their previous confirmed command on transient failures. */
import {
  checkMyPlanStatusReceipt,prepareMyPlanStatus,validStatusCommand,
  type MyPlanStatusCommand,type MyPlanStatusFailure,
} from "./target-staging-my-plan-status-client";

export type MyPlanUndoPreparation=
  |{kind:"ready";command:MyPlanStatusCommand}
  |{kind:"retry";reason:MyPlanStatusFailure}
  |{kind:"signed-out"};

export async function prepareConfirmedMyPlanUndo(
  original:MyPlanStatusCommand,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal,
):Promise<MyPlanUndoPreparation>{
  if(!validStatusCommand(original)||original.status!=="completed")
    return {kind:"retry",reason:"invalid-request"};
  const receipt=await checkMyPlanStatusReceipt(original,fetchImpl,signal);
  if(receipt.kind==="unknown"&&receipt.reason==="signed-out")
    return {kind:"signed-out"};
  if(receipt.kind!=="committed")
    return {kind:"retry",reason:receipt.kind==="unknown"
      ?receipt.reason:"stale"};
  if(signal?.aborted)return {kind:"retry",reason:"aborted"};
  const prepared=await prepareMyPlanStatus({
    taskId:original.taskId,areaId:original.writeAreaId,
    status:"open",undoOf:original,signal,
  },fetchImpl);
  if(prepared.ok===false)
    return prepared.reason==="signed-out"
      ?{kind:"signed-out"}:{kind:"retry",reason:prepared.reason};
  return {kind:"ready",command:prepared.command};
}

/** Preserve Undo on manual same-context read retry, never on actor/context loss.
 * An authorized fresh list read still controls whether Undo is rendered. */
export function keepConfirmedMyPlanUndoOnRefresh(
  action:{kind:string;status?:string;taskId?:string;areaId?:string},
  command:MyPlanStatusCommand|null,
):boolean{
  return action.kind==="committed"&&action.status==="completed"&&
    command!==null&&validStatusCommand(command)&&
    command.status==="completed"&&command.taskId===action.taskId&&
    command.writeAreaId===action.areaId;
}
