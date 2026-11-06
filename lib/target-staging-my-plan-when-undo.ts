/** Reversible private-when change: confirm the *original* actor's receipt,
 * then fresh-preview the CURRENT value before creating a NEW CAS for Undo.
 * Never PATCH here. Fails closed if another private-plan write intervened. */
import {
  checkMyPlanWhenReceipt,prepareMyPlanWhen,validMyPlanWhenCommand,validMyPlanWhenDate,
  type MyPlanWhenCommand,type MyPlanWhenFailure,
} from "./target-staging-my-plan-when-client";

export type ConfirmedWhen={command:MyPlanWhenCommand;previousWhenOn:string|null};
export type WhenUndoPreparation=
  |{kind:"ready";command:MyPlanWhenCommand}
  |{kind:"retry";reason:MyPlanWhenFailure}
  |{kind:"signed-out"};

export function validConfirmedWhen(x:ConfirmedWhen|null):x is ConfirmedWhen{
  return x!==null&&validMyPlanWhenCommand(x.command)&&
    validMyPlanWhenDate(x.previousWhenOn);
}

export function keepConfirmedWhenOnRefresh(
  action:{kind:string;taskId?:string;areaId?:string;whenOn?:string|null},
  original:ConfirmedWhen|null,
):boolean{
  return action.kind==="committed"&&validConfirmedWhen(original)&&
    original.command.taskId===action.taskId&&
    original.command.writeAreaId===action.areaId&&
    original.command.whenOn===action.whenOn;
}

export async function prepareConfirmedWhenUndo(
  original:ConfirmedWhen,fetchImpl:typeof fetch=fetch,
  signal?:AbortSignal,
):Promise<WhenUndoPreparation>{
  if(!validConfirmedWhen(original))
    return {kind:"retry",reason:"invalid-request"};
  const receipt=await checkMyPlanWhenReceipt(original.command,fetchImpl,signal);
  if(receipt.kind==="unknown"&&receipt.reason==="signed-out")
    return {kind:"signed-out"};
  if(receipt.kind!=="committed")
    return {kind:"retry",reason:receipt.kind==="unknown"
      ?receipt.reason:"stale"};
  if(signal?.aborted)return {kind:"retry",reason:"aborted"};
  const prepared=await prepareMyPlanWhen({
    taskId:original.command.taskId,
    areaId:original.command.writeAreaId,
    whenOn:original.previousWhenOn,signal,
  },fetchImpl);
  if(prepared.ok===false)
    return prepared.reason==="signed-out"?{kind:"signed-out"}:
      {kind:"retry",reason:prepared.reason};
  if(prepared.previousWhenOn!==original.command.whenOn)
    return {kind:"retry",reason:"stale"};
  return {kind:"ready",command:prepared.command};
}
