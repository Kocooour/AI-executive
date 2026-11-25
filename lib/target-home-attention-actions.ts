/** Milestone E-1: Home's private task attention transport. The existing
 * strict staging client remains the sole HTTP transport. No persistence,
 * optimistic writes, automatic PATCH retry, or shared-Area fallback.
 * Project rules are deferred by the owner's decision of 2026-11-25. */
import {
  appendAttentionPage, fetchAttentionPage, fetchAttentionCommandPreview,
  sendAttentionCommand, fetchAttentionCommandReceipt,
  type AttentionPage, type AttentionItem, type AttentionAction,
  type AttentionCommand, type AttentionFailure, type AttentionExplanationLanguage,
} from "./target-staging-attention-client";

import {targetAppFetch} from "./target-app-fetch";

export const HOME_ATTENTION_LIMIT = 5;

type Failure = {status: AttentionFailure};
type PageResult = {status:"ok";page:AttentionPage}|Failure;
type ActionResult = {status:"ok"}|Failure;

/** Never accept another area scope, even when a caller has a wider My Plan scope. */
export async function readHomeAttention(
  signal?:AbortSignal, fetchImpl:typeof fetch=targetAppFetch,explain?:AttentionExplanationLanguage,
):Promise<PageResult>{
  return fetchAttentionPage({
    areaFilter:"personal",view:"active",limit:HOME_ATTENTION_LIMIT,signal,explain,
  },fetchImpl);
}

export async function readMoreHomeAttention(
  previous:AttentionPage,signal?:AbortSignal,fetchImpl:typeof fetch=targetAppFetch,
):Promise<PageResult>{
  if(previous.areaFilter!=="personal"||previous.view!=="active"||
    !previous.hasMore||!previous.nextCursor||
    previous.items.some(item=>item.areaKind!=="private"))
    return {status:"invalid"};
  const next=await fetchAttentionPage({
    areaFilter:"personal",view:"active",limit:HOME_ATTENTION_LIMIT,
    cursor:previous.nextCursor,signal,explain:previous.explanationLanguage,
  },fetchImpl);
  if(next.status!=="ok")return next;
  const page=appendAttentionPage(previous,next.page);
  return page?{status:"ok",page}:{status:"stale"};
}

/** One displayed occurrence and its exact page witness. The caller must
 * discard these on session, generation, privacy or scope changes. */
export type HomeAttentionWitness={
  item:AttentionItem;
  attentionEpoch:number;
};

export async function changeHomeAttention(
  witness:HomeAttentionWitness,
  action:AttentionAction,
  snoozedUntilMs:number|null,
  signal:AbortSignal,
  fetchImpl:typeof fetch=targetAppFetch,
  onCommitted?:(command:AttentionCommand)=>void,
):Promise<ActionResult>{
  const {item,attentionEpoch}=witness;
  if(signal.aborted)return {status:"aborted"};
  if(item.areaKind!=="private"||
    (action==="restore"?item.lifecycle==="active":item.lifecycle!=="active")||
    (action==="snooze"?(!Number.isSafeInteger(snoozedUntilMs)||
      (snoozedUntilMs as number)<=0):snoozedUntilMs!==null))
    return {status:"invalid"};
  const target={taskId:item.taskId,ruleId:item.ruleId,occurrenceOn:item.relevantOn};
  const result=await fetchAttentionCommandPreview({...target,sourceRevision:item.sourceRevision,signal},fetchImpl);
  if(result.status!=="ok")return result;
  if(signal.aborted)return {status:"aborted"};
  const preview=result.preview;
  // A fresh preview is not permission to change a different occurrence or
  // overwrite a newer lifecycle action. Require the displayed page witness.
  if(preview.writeAreaId!==item.areaId||
    preview.expectedAttentionEpoch!==attentionEpoch||
    preview.expectedStateRevision!==item.lifecycleRevision||
    preview.lifecycle!==item.lifecycle||
    preview.snoozedUntilMs!==item.snoozedUntilMs)
    return {status:"conflict"};
  const command:AttentionCommand={
    commandId:crypto.randomUUID(),...target,action,snoozedUntilMs,
    expectedRevision:preview.expectedRevision,
    expectedAttentionEpoch:preview.expectedAttentionEpoch,
    expectedStateRevision:preview.expectedStateRevision,
    writeAreaId:preview.writeAreaId,restoreGeneration:preview.restoreGeneration,
  };
  const outcome=await commitHomeAttention(command,signal,fetchImpl);
  if(outcome.status==="ok"&&!signal.aborted)onCommitted?.(command);
  return outcome;
}

async function commitHomeAttention(command:AttentionCommand,signal:AbortSignal,
  fetchImpl:typeof fetch):Promise<ActionResult>{
  const sent=await sendAttentionCommand(command,signal,fetchImpl);
  if(sent.status==="ok")return signal.aborted?{status:"aborted"}:{status:"ok"};
  if(sent.status!=="uncertain")return sent;
  if(signal.aborted)return {status:"uncertain"};
  // Only the exact original command's receipt can prove a commit. A missing
  // receipt is not proof of rollback; require an authorized reload.
  const receipt=await fetchAttentionCommandReceipt(command,signal,fetchImpl);
  if(signal.aborted)return {status:"uncertain"};
  if(receipt.status==="ok"&&receipt.receipt==="committed")return {status:"ok"};
  if(receipt.status==="unauthorized")return {status:"unauthorized"};
  return {status:"uncertain"};
}

/** Conservative Undo of one confirmed hide. State row revision resets to zero
 * on every insert, so it alone is not a witness. Require the exact original
 * task CAS, store generation and minimum resulting actor epoch. If overdue
 * hygiene removed an old soon row, the epoch can advance further; refuse Undo
 * rather than guessing whether another action intervened. */
export async function undoHomeAttention(
  original:AttentionCommand,signal:AbortSignal,fetchImpl:typeof fetch=targetAppFetch,
):Promise<ActionResult>{
  if(signal.aborted)return {status:"aborted"};
  if(original.action!=="dismiss"&&original.action!=="snooze")return {status:"invalid"};
  const target={taskId:original.taskId,ruleId:original.ruleId,occurrenceOn:original.occurrenceOn};
  const result=await fetchAttentionCommandPreview({...target,signal},fetchImpl);
  if(result.status!=="ok")return result;
  if(signal.aborted)return {status:"aborted"};
  const p=result.preview;
  // A prior active row with a revision is an expired snooze: writer deletes it
  // and inserts the new hidden row in the same transaction.
  const expectedEpoch=original.expectedAttentionEpoch+(original.expectedStateRevision===null?1:2);
  if(p.expectedAttentionEpoch!==expectedEpoch||p.expectedStateRevision!==0||
    p.expectedRevision!==original.expectedRevision||p.writeAreaId!==original.writeAreaId||
    p.restoreGeneration!==original.restoreGeneration||
    p.lifecycle!==(original.action==="snooze"?"snoozed":"dismissed")||
    p.snoozedUntilMs!==original.snoozedUntilMs)return {status:"conflict"};
  return commitHomeAttention({
    ...target,commandId:crypto.randomUUID(),action:"restore",snoozedUntilMs:null,
    expectedRevision:p.expectedRevision,expectedAttentionEpoch:p.expectedAttentionEpoch,
    expectedStateRevision:p.expectedStateRevision,writeAreaId:p.writeAreaId,
    restoreGeneration:p.restoreGeneration,
  },signal,fetchImpl);
}
