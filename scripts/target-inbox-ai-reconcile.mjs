#!/usr/bin/env node
/**
 * Explicit operator-only recovery of orphaned C-3b dispatch tickets.
 * NEVER called by deploy, app startup, HTTP or target restore.
 *
 * Preconditions: ai-executive systemd unit is INACTIVE (not activating,
 * reloading or failed), all its child workers have terminated, verified fixed
 * target and independent fence path, exact configured owner/generation.
 * Requires LUMI_INBOX_AI_RECONCILE=1 and the fence's expected epoch.
 * The procedure ALWAYS DISABLES AI, advances the fence epoch, and records a
 * matching target revoke under the canonical pinned transaction.
 */
import {spawnSync} from "node:child_process";
import {TargetStagingSessionAuthority}
  from "../lib/target-staging-session-authority.ts";
import {openVerifiedInboxC3bFence} from "../lib/target-inbox-c3b-runtime.ts";
import {readInboxAIFenceGrant,reconcileStoppedInboxAIOrphans}
  from "../lib/target-inbox-ai-consent-fence.ts";
import {checkFirstDeployInboxAIConsent}
  from "../lib/target-inbox-ai-first-deploy.ts";
import {INBOX_AI_DATA_SCOPE_VERSION}
  from "../lib/target-inbox-ai-consent.ts";

const args=process.argv.slice(2);
const [verb,dirArg,directory,ownerArg,owner,genArg,generation,
  epochArg,expectedEpochRaw]=args;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER=/^[A-Za-z0-9_.:@-]{1,120}$/;
const epoch=Number(expectedEpochRaw);
const fail=message=>{process.stderr.write("C-3b reconciliation denied: "+message+"\n");process.exit(1);};
if(args.length!==9||verb!=="--reconcile-stopped"||dirArg!=="--directory"||
   ownerArg!=="--owner"||genArg!=="--generation"||epochArg!=="--expected-epoch"||
   directory!=="/var/lib/ai-executive-target/personal-v1"||
   !OWNER.test(owner??"")||!UUID.test(generation??"")||
   !Number.isSafeInteger(epoch)||epoch<1||
   process.env.LUMI_INBOX_AI_RECONCILE!=="1")fail("invalid operator invocation");
// Do NOT accept an unknown state, including service-query permission errors.
const service=spawnSync("systemctl",["show","-p","ActiveState","--value","ai-executive"],
  {encoding:"utf8",timeout:5000});
if(service.status!==0||service.stdout.trim()!=="inactive")
  fail("ai-executive is not confirmed inactive");
const fence=openVerifiedInboxC3bFence(directory);
if(!fence)fail("external fence missing or invalid");
const authority=new TargetStagingSessionAuthority({
  stagingDirectory:directory,expectedRestoreGeneration:generation,
});
try{
  const grant=readInboxAIFenceGrant(fence,owner);
  const target=authority.readInboxAIConsent(owner);
  if(!grant||grant.epoch!==epoch||!target||
     grant.restoreGeneration!==generation.toLowerCase()||
     target.restoreGeneration!==generation.toLowerCase()||
     grant.dataScopeVersion!==INBOX_AI_DATA_SCOPE_VERSION||
     target.dataScopeVersion!==INBOX_AI_DATA_SCOPE_VERSION||
     target.epoch>epoch)fail("owner/epoch/scope mismatch");
  const cleared=reconcileStoppedInboxAIOrphans(fence,owner,epoch);
  if(!cleared)fail("tickets not expired, absent or fence unavailable");
  const issued=authority.issueWritable(owner);
  if(!issued)fail("target writable session unavailable; AI remains revoked");
  const disabled=authority.changeInboxAIConsent(issued.sessionToken,owner,{
    mode:"revoke",epoch:cleared.epoch,
    restoreGeneration:generation,ownerDecision:target.ownerDecision,
    dataScopeVersion:INBOX_AI_DATA_SCOPE_VERSION,
  });
  if(!disabled.ok||disabled.record.enabled||
     !checkFirstDeployInboxAIConsent(authority,fence,owner,generation))
    fail("target reconciliation incomplete; service must remain stopped");
  process.stdout.write(JSON.stringify({
    ok:true,consentEnabled:false,epoch:cleared.epoch,ticketsReconciled:cleared.cleared,
  })+"\n");
}finally{authority.close();fence.close();}
