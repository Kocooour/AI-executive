/** Milestone E-1: Home's private task attention transport. The existing
 * strict staging client remains the sole HTTP transport. No persistence,
 * optimistic writes, automatic PATCH retry, or shared-Area fallback.
 * Project rules and UI activation are separate changes in this same PR. */
import {
  appendAttentionPage, fetchAttentionPage, fetchAttentionCommandPreview,
  sendAttentionCommand, fetchAttentionCommandReceipt,
  type AttentionPage, type AttentionItem, type AttentionAction,
  type AttentionCommand, type AttentionFailure,
} from "./target-staging-attention-client";

export const HOME_ATTENTION_LIMIT = 5;

type Failure = {status: AttentionFailure};
type PageResult = {status:"ok";page:AttentionPage}|Failure;
type ActionResult = {status:"ok"}|Failure;

/** Never accept another area scope, even when a caller has a wider My Plan scope. */
export async function readHomeAttention(
  signal?:AbortSignal, fetchImpl:typeof fetch=fetch,
):Promise<PageResult>{
  return fetchAttentionPage({
    areaFilter:"personal",view:"active",limit:HOME_ATTENTION_LIMIT,signal,
  },fetchImpl);
}

export async function readMoreHomeAttention(
  previous:AttentionPage,signal?:AbortSignal,fetchImpl:typeof fetch=fetch,
):Promise<PageResult>{
  if(previous.areaFilter!=="personal"||previous.view!=="active"||
    !previous.hasMore||!previous.nextCursor||
    previous.items.some(item=>item.areaKind!=="private"))
    return {status:"invalid"};
  const next=await fetchAttentionPage({
    areaFilter:"personal",view:"active",limit:HOME_ATTENTION_LIMIT,
    cursor:previous.nextCursor,signal,
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
  fetchImpl:typeof fetch=fetch,
):Promise<ActionResult>{
  const {item,attentionEpoch}=witness;
  if(signal.aborted)return {status:"aborted"};
  if(item.areaKind!=="private"||
    (action==="restore"?item.lifecycle==="active":item.lifecycle!=="active")||
    (action==="snooze"?(!Number.isSafeInteger(snoozedUntilMs)||
      (snoozedUntilMs as number)<=0):snoozedUntilMs!==null))
    return {status:"invalid"};
  const target={taskId:item.taskId,ruleId:item.ruleId,occurrenceOn:item.relevantOn};
  const result=await fetchAttentionCommandPreview({...target,signal},fetchImpl);
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
