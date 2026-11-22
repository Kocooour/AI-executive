/**
 * C-3b: OpenAI-only suggestion dispatch behind two-store owner consent.
 *
 * Server-internal, DEFAULT-OFF. The caller MUST authenticate a real session,
 * obtain both targetStore states through a trusted pinned actor-only reader,
 * and recheck live release/ACL before exposing any returned proposal.
 * This does not create a route or enable provider calls in any deployment.
 *
 * No persistent caching, fallback provider, task metadata, HTTP logging, or
 * retry. Each attempt consumes a cross-process bounded dispatch budget.
 * A revoke has exclusive authority to mark the external fence disabled.
 * While ANY outbound ticket remains pending, revoke cannot be confirmed;
 * a 250ms poll aborts in-flight network calls after fence becomes disabled.
 */
import type {DatabaseSync} from "node:sqlite";
import type {AuthorizedInboxSuggestionSnapshot}
  from "./target-inbox-suggestion-snapshot";
import type {TargetInboxAIConsent} from "./target-inbox-ai-consent";
import {targetInboxAIConsentMatchesFence} from "./target-inbox-ai-consent";
import {completeInboxOpenAIOnly} from "./server-ai-provider";
import {inboxAIAllowedInput,resolveInboxAIChoice,suggestInboxByRules}
  from "./target-inbox-suggestions";
import type {InboxAIAllowedInput,InboxAIChoice,InboxSuggestion}
  from "./target-inbox-suggestions";
import {
  readInboxAIFenceGrant,beginInboxAIDispatch,inboxAIDispatchStillAllowed,
  endInboxAIDispatch,
} from "./target-inbox-ai-consent-fence";

export type TrustedInboxAIState={
  actorUserId:string;
  /** Live authenticated session, checked by the trusted caller. */
  sessionAlive:boolean;
  consent:TargetInboxAIConsent|null;
  privateSnapshot:AuthorizedInboxSuggestionSnapshot|null;
};
export type InboxAIDispatchDeps={
  /** Must return a NEW pinned read + real session and ACL validation. */
  freshAuthorizedState:()=>Promise<TrustedInboxAIState|null>;
  /** Only tests inject a mock; real code defaults exclusively to OpenAI. */
  complete?: (input:InboxAIAllowedInput,signal:AbortSignal)=>
    Promise<InboxAIChoice|null>;
};
export type InboxAIDispatchRequest={
  fenceDb:DatabaseSync;
  initial:TrustedInboxAIState;
  deps:InboxAIDispatchDeps;
  signal?:AbortSignal;
};
const sameAuthorized=(a:TrustedInboxAIState,b:TrustedInboxAIState):boolean=>{
  const initial=a.privateSnapshot,next=b.privateSnapshot;
  return Boolean(a.sessionAlive&&b.sessionAlive&&
    initial&&next&&a.actorUserId===b.actorUserId&&
    initial.restoreGeneration===next.restoreGeneration&&
    initial.taskId===next.taskId&&
    initial.candidateFingerprint===next.candidateFingerprint&&
    initial.taskWriteRevision===next.taskWriteRevision&&
    initial.taskRevision===next.taskRevision&&
    initial.triageRevision===next.triageRevision&&
    initial.personalWhenRevision===next.personalWhenRevision&&
    initial.personalPlanEpoch===next.personalPlanEpoch&&
    a.consent&&b.consent&&a.consent.enabled&&b.consent.enabled&&
    a.consent.epoch===b.consent.epoch&&
    a.consent.dataScopeVersion===b.consent.dataScopeVersion&&
    a.consent.restoreGeneration===b.consent.restoreGeneration);
};
/** Never trust the returned suggestion as authorization for Accept. */
export async function dispatchAuthorizedInboxOpenAIOnly(
  request:InboxAIDispatchRequest,
):Promise<InboxSuggestion|null>{
  const initial=request?.initial,db=request?.fenceDb;
  if(!initial||!db||!request.deps||
     typeof request.deps.freshAuthorizedState!=="function"||
     !initial.privateSnapshot)return null;
  const rules=suggestInboxByRules(initial.privateSnapshot.snapshot);
  const fallback=()=>rules;
  if(!initial.sessionAlive||request.signal?.aborted)return fallback();
  const p=initial.privateSnapshot;
  const actor=initial.actorUserId;
  const scope=initial.consent?.dataScopeVersion;
  const fence=readInboxAIFenceGrant(db,actor);
  if(!initial.consent||!scope||
     !targetInboxAIConsentMatchesFence(initial.consent,fence,p.restoreGeneration))
    return fallback();
  const input=inboxAIAllowedInput(p.snapshot);
  if(!input)return fallback();
  try{
    // Reauthorize before even registering an outbound request.
    const before=await request.deps.freshAuthorizedState();
    if(!before||!sameAuthorized(initial,before)||
       !targetInboxAIConsentMatchesFence(
         before.consent,readInboxAIFenceGrant(db,actor),p.restoreGeneration))
      return fallback();
  }catch{return fallback();}
  const ticket=beginInboxAIDispatch(db,actor,p.restoreGeneration,scope);
  if(!ticket)return fallback();
  const abort=new AbortController();
  const onAbort=()=>abort.abort();
  request.signal?.addEventListener("abort",onAbort,{once:true});
  // A safe actual-network call only begins after a final serial fence check
  // against the registered pending ticket. A concurrent revoke that wins
  // later cannot confirm while this pending entry exists.
  const watchdog=setInterval(()=>{
    if(!inboxAIDispatchStillAllowed(db,ticket))abort.abort();
  },250);
  watchdog.unref?.();
  let candidate:InboxSuggestion|null=null;
  let approved=false;
  try{
    if(!request.signal?.aborted&&inboxAIDispatchStillAllowed(db,ticket)){
      const complete=request.deps.complete??completeInboxOpenAIOnly;
      const choice=await complete(input,abort.signal);
      if(!abort.signal.aborted&&!request.signal?.aborted&&
         inboxAIDispatchStillAllowed(db,ticket)){
        const after=await request.deps.freshAuthorizedState();
        if(after&&sameAuthorized(initial,after)&&
           targetInboxAIConsentMatchesFence(after.consent,
             readInboxAIFenceGrant(db,actor),p.restoreGeneration)){
          candidate=resolveInboxAIChoice(p.snapshot,choice);
          approved=candidate.source==="ai";
        }
      }
    }
  }catch{
    // Never log private titles, names, prompts or provider output.
  }finally{
    clearInterval(watchdog);
    request.signal?.removeEventListener("abort",onAbort);
    // Last serial check + ticket release is atomic with revoke. A false
    // result (revoke, restore, error) discards the late AI response.
    if(!endInboxAIDispatch(db,ticket))approved=false;
  }
  return approved&&candidate?candidate:fallback();
}
