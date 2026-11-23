/**
 * Privileged first-rollout C-3b consent coordinator. NEVER call from a request,
 * startup, store restore, or normal deployment. Only the explicit reviewed
 * deploy-safe.sh first-fence-rollout stage may invoke this code.
 *
 * The target's canonical pinned writer journals the owner grant first; the
 * independent non-restorable fence commits second. A crash between commits
 * leaves AI disabled. A later deploy only checks: it NEVER repairs consent.
 */
import type {DatabaseSync} from "node:sqlite";
import {TargetStagingSessionAuthority} from "./target-staging-session-authority";
import {INBOX_AI_DATA_SCOPE_VERSION,INBOX_FIRST_OWNER_DECISION}
  from "./target-inbox-ai-consent";
import {readInboxAIFenceGrant,recordExplicitInboxAIGrant}
  from "./target-inbox-ai-consent-fence";

const OWNER=/^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read-only, strict two-store agreement; revoked+revoked is also valid.
 * A restored older target snapshot must NEVER resurrect a fence revocation.
 */
export function checkFirstDeployInboxAIConsent(
  authority:TargetStagingSessionAuthority,db:DatabaseSync,
  owner:string,generation:string,
):boolean{
  if(!OWNER.test(owner)||!UUID.test(generation))return false;
  const target=authority.readInboxAIConsent(owner);
  const fence=readInboxAIFenceGrant(db,owner);
  if(!target||!fence||target.actorUserId!==owner||
     target.enabled!==fence.active||target.epoch!==fence.epoch||
     target.restoreGeneration!==generation.toLowerCase()||
     fence.restoreGeneration!==generation.toLowerCase()||
     target.dataScopeVersion!==INBOX_AI_DATA_SCOPE_VERSION||
     fence.dataScopeVersion!==INBOX_AI_DATA_SCOPE_VERSION)return false;
  try{
    const current=db.prepare(
      "SELECT owner_decision AS decision FROM inbox_ai_fence_grants WHERE actor=?",
    ).get(owner) as {decision:string}|undefined;
    const historical=db.prepare(
      "SELECT epoch FROM inbox_ai_fence_decisions WHERE actor=? AND decision=?",
    ).get(owner,target.ownerDecision) as {epoch:number}|undefined;
    return current?.decision===target.ownerDecision&&
      historical!==undefined&&historical.epoch<=target.epoch;
  }catch{return false;}
}

/** Called only on the FIRST missing-fence rollout. Never silently re-grants
 * a disabled or stale owner, never rewinds epoch/decision history.
 */
export function grantFirstDeployInboxAIConsent(
  authority:TargetStagingSessionAuthority,db:DatabaseSync,
  owner:string,generation:string,
):boolean{
  if(!OWNER.test(owner)||!UUID.test(generation))return false;
  try{
    const prior=authority.readInboxAIConsent(owner);
    const external=readInboxAIFenceGrant(db,owner);
    if(prior&&(!prior.enabled||prior.epoch!==1||
       prior.ownerDecision!==INBOX_FIRST_OWNER_DECISION||
       prior.dataScopeVersion!==INBOX_AI_DATA_SCOPE_VERSION||
       prior.restoreGeneration!==generation.toLowerCase()))return false;
    // Any earlier decision, including a revoked grant, blocks automatic grant.
    // Reentry with the exact already active first grant is read-only.
    if(external)return Boolean(prior&&
      checkFirstDeployInboxAIConsent(authority,db,owner,generation)&&
      external.active&&external.epoch===1);
    const history=db.prepare(
      "SELECT (SELECT COUNT(*) FROM inbox_ai_fence_grants) AS grants, "+
      "(SELECT COUNT(*) FROM inbox_ai_fence_decisions) AS decisions, "+
      "(SELECT COUNT(*) FROM inbox_ai_fence_pending) AS pending",
    ).get() as {grants:number;decisions:number;pending:number};
    if(history.grants!==0||history.decisions!==0||history.pending!==0)return false;
    if(!prior){
      const issued=authority.issueWritable(owner);
      if(!issued)return false;
      const result=authority.changeInboxAIConsent(issued.sessionToken,owner,{
        mode:"grant",epoch:1,ownerDecision:INBOX_FIRST_OWNER_DECISION,
        restoreGeneration:generation,
        dataScopeVersion:INBOX_AI_DATA_SCOPE_VERSION,
      });
      if(!result.ok)return false;
    }
    // This records the decision outside the restorable target. No remote
    // dispatch can occur until BOTH durable writes agree and check succeeds.
    const granted=recordExplicitInboxAIGrant(db,owner,owner,generation,
      INBOX_AI_DATA_SCOPE_VERSION,INBOX_FIRST_OWNER_DECISION);
    return Boolean(granted&&
      checkFirstDeployInboxAIConsent(authority,db,owner,generation));
  }catch{return false;}
}
