/** C-3b actor-private OpenAI-only dispatch. Fail-closed across identity,
 * session, candidate, restore, timezone/day, consent/revoke and worker changes.
 * A rules fallback is returned ONLY after fresh live authorization. */
import type {DatabaseSync} from "node:sqlite";
import type {AuthorizedInboxSuggestionSnapshot} from "./target-inbox-suggestion-snapshot";
import type {TargetInboxAIConsent} from "./target-inbox-ai-consent";
import {targetInboxAIConsentMatchesFence} from "./target-inbox-ai-consent";
import {completeInboxOpenAIOnly} from "./server-ai-provider";
import {inboxAIAllowedInput,resolveInboxAIChoice,composeInboxWithLocalToday,
  suggestInboxWithLocalToday} from "./target-inbox-suggestions";
import type {InboxAIAllowedInput,InboxAIChoice,InboxSuggestion}
  from "./target-inbox-suggestions";
import {inboxLocalDate} from "./target-inbox-suggestion-commitment";
import {readInboxAIFenceGrant,beginInboxAIDispatch,inboxAIDispatchStillAllowed,
  endInboxAIDispatch} from "./target-inbox-ai-consent-fence";

export type TrustedInboxAIState={
  actorUserId:string;
  sessionAlive:boolean;
  consent:TargetInboxAIConsent|null;
  privateSnapshot:AuthorizedInboxSuggestionSnapshot|null;
};
export type InboxAIDispatchDeps={
  /** New pinned read + actual session/ACL check. Never trust caller cache. */
  freshAuthorizedState:()=>Promise<TrustedInboxAIState|null>;
  complete?: (input:InboxAIAllowedInput,signal:AbortSignal)=>
    Promise<InboxAIChoice|null>;
};
export type InboxAIDispatchRequest={
  fenceDb:DatabaseSync;
  initial:TrustedInboxAIState;
  deps:InboxAIDispatchDeps;
  signal?:AbortSignal;
};

/** Ignore consent here: revoked AI still allows local rules for a LIVE actor. */
const sameLiveSnapshot=(a:TrustedInboxAIState,b:TrustedInboxAIState,
  localDay:string):boolean=>{
  const p=a.privateSnapshot,q=b.privateSnapshot;
  return Boolean(a.sessionAlive&&b.sessionAlive&&p&&q&&
    a.actorUserId===b.actorUserId&&
    p.restoreGeneration===q.restoreGeneration&&p.taskId===q.taskId&&
    p.candidateFingerprint===q.candidateFingerprint&&
    p.taskWriteRevision===q.taskWriteRevision&&
    p.taskRevision===q.taskRevision&&p.triageRevision===q.triageRevision&&
    p.personalWhenRevision===q.personalWhenRevision&&
    p.personalPlanEpoch===q.personalPlanEpoch&&
    p.timeZone===q.timeZone&&p.notificationEpoch===q.notificationEpoch&&
    inboxLocalDate(Date.now(),p.timeZone)===localDay);
};
const sameConsent=(a:TrustedInboxAIState,b:TrustedInboxAIState)=>Boolean(
  a.consent&&b.consent&&a.consent.enabled&&b.consent.enabled&&
  a.consent.actorUserId===b.consent.actorUserId&&
  a.consent.epoch===b.consent.epoch&&
  a.consent.dataScopeVersion===b.consent.dataScopeVersion&&
  a.consent.restoreGeneration===b.consent.restoreGeneration
);

/** The suggestion does not authorize Accept. Callers recheck live release. */
export async function dispatchAuthorizedInboxOpenAIOnly(
  request:InboxAIDispatchRequest,
):Promise<InboxSuggestion|null>{
  const initial=request?.initial,db=request?.fenceDb;
  if(!initial||!db||!request.deps||
     typeof request.deps.freshAuthorizedState!=="function"||
     !initial.sessionAlive||!initial.privateSnapshot||
     request.signal?.aborted)return null;
  const p=initial.privateSnapshot;
  const localDay=inboxLocalDate(Date.now(),p.timeZone);
  if(!localDay)return null;
  const rules=suggestInboxWithLocalToday(p.snapshot,localDay);
  const live=async():Promise<TrustedInboxAIState|null>=>{
    if(request.signal?.aborted)return null;
    try{
      const now=await request.deps.freshAuthorizedState();
      return now&&sameLiveSnapshot(initial,now,localDay)?now:null;
    }catch{return null;}
  };
  // Mandatory reauthorization also covers no-consent, failure and backpressure
  // paths. Never return stale 'why' text when an actor/session/ACL is gone.
  const before=await live();
  if(!before)return null;
  const actor=initial.actorUserId;
  const scope=initial.consent?.dataScopeVersion;
  if(!scope||!sameConsent(initial,before)||
    !targetInboxAIConsentMatchesFence(before.consent,
      readInboxAIFenceGrant(db,actor),p.restoreGeneration))return rules;
  const input=inboxAIAllowedInput(p.snapshot);
  if(!input)return rules;
  const ticket=beginInboxAIDispatch(db,actor,p.restoreGeneration,scope);
  if(!ticket)return (await live())?rules:null;
  const abort=new AbortController();
  const onAbort=()=>abort.abort();
  request.signal?.addEventListener("abort",onAbort,{once:true});
  const watchdog=setInterval(()=>{
    if(!inboxAIDispatchStillAllowed(db,ticket))abort.abort();
  },250);
  watchdog.unref?.();
  let candidate:InboxSuggestion|null=null;
  let approved=false,authorizationLost=false;
  try{
    if(!request.signal?.aborted&&inboxAIDispatchStillAllowed(db,ticket)){
      const complete=request.deps.complete??completeInboxOpenAIOnly;
      const choice=await complete(input,abort.signal);
      if(!abort.signal.aborted&&!request.signal?.aborted&&
          inboxAIDispatchStillAllowed(db,ticket)){
        const after=await live();
        if(!after)authorizationLost=true;
        else if(sameConsent(initial,after)&&
          targetInboxAIConsentMatchesFence(after.consent,
            readInboxAIFenceGrant(db,actor),p.restoreGeneration)){
          const selected=resolveInboxAIChoice(p.snapshot,choice);
          candidate=composeInboxWithLocalToday(p.snapshot,selected,localDay);
          approved=candidate.source==="ai";
        }
      }
    }
  }catch{
    // Do not log any private name, title, prompt or provider output.
  }finally{
    clearInterval(watchdog);
    request.signal?.removeEventListener("abort",onAbort);
    if(!endInboxAIDispatch(db,ticket))approved=false;
  }
  if(authorizationLost)return null;
  if(approved&&candidate&&!request.signal?.aborted)return candidate;
  // Safe local fallback for provider failure, timeout, 429 and consent
  // revocation ONLY if the actor can still see this exact private snapshot.
  return (await live())?rules:null;
}
