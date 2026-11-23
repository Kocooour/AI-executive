/** C-3b bounded actor-scoped child. No private content in argv/stderr. */
import path from "node:path";
import {createHmac} from "node:crypto";
import {TargetStagingSessionAuthority}
  from "../lib/target-staging-session-authority.ts";
import {resolveChildActor} from "./target-staging-child-actor.mjs";
import {readTitleCommand} from "./target-staging-title-stdin.mjs";
import {inboxC3bActionKey,inboxC3bSessionBinding,openVerifiedInboxC3bFence,
  c3bEnabled,c3bWriteEnabled} from "../lib/target-inbox-c3b-runtime.ts";
import {inboxLocalDate,sealInboxDisplayedAction,unsealInboxDisplayedAction}
  from "../lib/target-inbox-suggestion-commitment.ts";
import {suggestInboxWithLocalToday}
  from "../lib/target-inbox-suggestions.ts";
import {dispatchAuthorizedInboxOpenAIOnly}
  from "../lib/target-inbox-suggestion-dispatch.ts";
import {INBOX_FIRST_OWNER_DECISION,INBOX_AI_DATA_SCOPE_VERSION,
  targetInboxAIConsentMatchesFence}
  from "../lib/target-inbox-ai-consent.ts";
import {recordExplicitInboxAIGrant,readInboxAIFenceGrant,
  revokeInboxAIConsent,inboxAIRevokeDrained}
  from "../lib/target-inbox-ai-consent-fence.ts";

const dir=process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY;
const gen=process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION;
const owner=process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID;
const HEX=/^[a-f0-9]{64}$/;
const TASK=/^[^\u0000-\u001f\u007f]{1,512}$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=()=>{throw Error("unavailable");};
const output=value=>process.stdout.write(JSON.stringify(value));
try{
  if(process.argv.length!==2||!c3bEnabled()||!dir||!path.isAbsolute(dir)||
     !gen||!UUID.test(gen)||!owner)fail();
  const request=await readTitleCommand(process.stdin);
  if(!request||typeof request!=="object"||Array.isArray(request)||
     !["preview","accept","undo","receipt","cancel","consent_read","consent_write"]
       .includes(request.operation))fail();
  const write=["accept","undo","cancel","consent_write"].includes(request.operation);
  if(write&&!c3bWriteEnabled())fail();
  const authority=new TargetStagingSessionAuthority({
    stagingDirectory:dir,expectedRestoreGeneration:gen,
  });
  try{
    const identity=resolveChildActor({stagingDirectory:dir,
      expectedRestoreGeneration:gen,ownerUserId:owner});
    if(!identity)fail();
    const actor=identity.actor;
    const key=inboxC3bActionKey();
    const binding=inboxC3bSessionBinding(actor,gen,identity.sessionTokenHash,
      process.env.AI_EXECUTIVE_TARGET_STAGING_C3B_OWNER_COOKIE_BINDING);
    if(!key||!binding||!HEX.test(binding))fail();
    const storePage=()=>authority.readInboxPage(actor,1);
    const fresh=async()=>{
      const live=resolveChildActor({stagingDirectory:dir,
        expectedRestoreGeneration:gen,ownerUserId:owner});
      const snapshot=live?.actor===actor
        ?authority.readPrivateInboxSuggestionSnapshot(actor,request.taskId):null;
      return snapshot?{actorUserId:actor,sessionAlive:true,
        privateSnapshot:snapshot,consent:authority.readInboxAIConsent(actor)}:null;
    };
    if(request.operation==="preview"){
      if(typeof request.taskId!=="string"||!TASK.test(request.taskId)||
         (request.mode!==undefined&&request.mode!=="rules"&&request.mode!=="best"))
        fail();
      const current=await fresh();
      if(!current)fail();
      const snapshot=current.privateSnapshot;
      const localDay=inboxLocalDate(Date.now(),snapshot.timeZone);
      if(!localDay)fail();
      let suggestion=suggestInboxWithLocalToday(snapshot.snapshot,localDay);
      let fence=request.mode==="rules"?null:openVerifiedInboxC3bFence(dir);
      try{
        // AI is OFF without the independent external fence, valid consent or
        // configured OpenAI provider. Rules remain fully local and available.
        if(request.mode!=="rules"&&fence&&current.consent){
          const synthetic=process.env.AI_EXECUTIVE_E2E==="true"&&
            process.env.LUMI_TARGET_INBOX_C3B_E2E==="true"&&
            dir.startsWith("/tmp/lumi-e2e-");
          const selected=await dispatchAuthorizedInboxOpenAIOnly({
            fenceDb:fence,initial:current,
            deps:{freshAuthorizedState:fresh,
              ...(synthetic?{complete:async input=>{
                // Only synthetic browser acceptance. This branch makes NO
                // network call, cannot run under an ordinary production
                // deployment and cannot choose outside the input allowlist.
                const label=input.privateOpenProjectNames.find(name=>
                  input.taskTitle.includes(name));
                return label?{action:"project",targetName:label,reason:"mock"}
                  :{action:"keep",targetName:null,reason:"mock"};
              }}:{})},
          });
          if(!selected)fail(); // revoked actor/ACL: release nothing
          suggestion=selected;
        }
      }finally{fence?.close();}
      const verified=await fresh();
      if(!verified||verified.privateSnapshot.candidateFingerprint!==
          snapshot.candidateFingerprint)fail();
      const p=verified.privateSnapshot;
      const day=inboxLocalDate(Date.now(),p.timeZone);
      if(day!==localDay)fail();
      const sealed=sealInboxDisplayedAction({
        actorUserId:actor,taskId:request.taskId,sessionTokenHash:binding,
        restoreGeneration:gen,candidateFingerprint:p.candidateFingerprint,
        taskWriteRevision:p.taskWriteRevision,taskRevision:p.taskRevision,
        triageRevision:p.triageRevision,personalPlanEpoch:p.personalPlanEpoch,
        personalWhenRevision:p.personalWhenRevision,notificationEpoch:p.notificationEpoch,
        timeZone:p.timeZone,localDate:day,consentEpoch:suggestion.source==="ai"
          ?(verified.consent?.epoch??0):0,
        dataScopeVersion:INBOX_AI_DATA_SCOPE_VERSION,suggestion,
      },key);
      const page=storePage();
      if(!sealed||!page)fail();
      output({ok:true,taskId:request.taskId,token:sealed,
        why:suggestion.why,changes:suggestion.changes,source:suggestion.source,
        restoreGeneration:gen,linearization:page.linearization,
        areaEpochs:page.areaEpochs,privateEpoch:p.personalPlanEpoch,
        notificationEpoch:p.notificationEpoch,
        consentEpoch:suggestion.source==="ai"?(verified.consent?.epoch??0):0});
    }else if(request.operation==="accept"||request.operation==="undo"){
      if(!request.command||typeof request.command!=="object")fail();
      const issued=authority.issueWritable(actor);
      if(!issued)fail();
      // A rule-only Accept must NEVER seize the external consent lock.
      // The signed commitment (not the caller) decides if AI was used.
      const committed=request.operation==="accept"
        ?unsealInboxDisplayedAction(request.command.token,key,{
          actorUserId:actor,taskId:request.command.taskId,
          sessionTokenHash:binding,restoreGeneration:gen,
          displayedChanges:request.command.displayedChanges,
          displayedWhy:request.command.displayedWhy,
        }):null;
      if(request.operation==="accept"&&!committed)fail();
      const requiresFence=committed?.suggestion.source==="ai";
      const fence=requiresFence?openVerifiedInboxC3bFence(dir):null;
      if(requiresFence&&!fence)fail();
      try{
        const work=request.operation==="accept"
          ?{mode:"accept",command:request.command,key,
            sessionTokenHash:binding,...(fence?{fenceDb:fence}:{})}
          :{mode:"undo",command:request.command,sessionTokenHash:binding};
        output(authority.changeInboxSuggestedAction(issued.sessionToken,work));
      }finally{fence?.close();}
    }else if(request.operation==="cancel"){
      if(!request.command||typeof request.command!=="object")fail();
      const issued=authority.issueWritable(actor);
      if(!issued)fail();
      const terminal=Object.prototype.hasOwnProperty.call(
        request.command,"undoOfCommandId")
        ?authority.cancelInboxSuggestedUndo(
          issued.sessionToken,request.command,binding)
        :authority.cancelInboxSuggestedAction(
          issued.sessionToken,request.command,binding);
      const page=storePage();
      if(!terminal||!page)fail();
      output({ok:true,...terminal,
        linearization:page.linearization,areaEpochs:page.areaEpochs});
    }else if(request.operation==="receipt"){
      if(!request.command||typeof request.command!=="object")fail();
      const receipt=authority.readInboxSuggestionReceipt(actor,request.command);
      const page=storePage();
      if(!receipt||!page)fail();
      output({ok:true,...receipt,
        linearization:page.linearization,areaEpochs:page.areaEpochs});
    }else if(request.operation==="consent_read"){
      if(actor!==owner||(request.includeCapacity!==undefined&&
         typeof request.includeCapacity!=="boolean"))fail();
      const record=authority.readInboxAIConsent(actor);
      const fence=openVerifiedInboxC3bFence(dir);
      if(!fence)fail();
      try{
        const grant=readInboxAIFenceGrant(fence,actor);
        const enabled=targetInboxAIConsentMatchesFence(record,grant,gen);
        const pending=Boolean(record&&!record.enabled&&grant&&!grant.active&&
          !inboxAIRevokeDrained(fence,actor,grant.epoch));
        const capacity=request.includeCapacity
          ?authority.readInboxReceiptCapacity(actor):null;
        if(request.includeCapacity&&!capacity)fail();
        output({ok:true,enabled,pending,epoch:record?.epoch??0,
          restoreGeneration:gen,capacity});
      }finally{fence.close();}
    }else if(request.operation==="consent_write"){
      if(actor!==owner||!["grant","revoke"].includes(request.mode))fail();
      const fence=openVerifiedInboxC3bFence(dir);
      if(!fence)fail();
      const issued=authority.issueWritable(actor);
      if(!issued){fence.close();fail();}
      try{
        const previous=authority.readInboxAIConsent(actor);
        const external=readInboxAIFenceGrant(fence,actor);
        if(request.mode==="grant"){
          if(previous?.enabled&&
             targetInboxAIConsentMatchesFence(previous,external,gen)){
            output({ok:true,enabled:true,pending:false});}
          else if(previous?.enabled){
            // Partial first rollout: target grant may have committed before
            // the external grant. An explicit retry can finish ONLY the same
            // first decision; an already revoked fence denies replay.
            if(previous.epoch!==1||
               previous.ownerDecision!==INBOX_FIRST_OWNER_DECISION||
               !recordExplicitInboxAIGrant(fence,actor,owner,gen,
                 INBOX_AI_DATA_SCOPE_VERSION,INBOX_FIRST_OWNER_DECISION)||
               !targetInboxAIConsentMatchesFence(previous,
                 readInboxAIFenceGrant(fence,actor),gen))fail();
            output({ok:true,enabled:true,pending:false});
          }
          else{
            const epoch=(previous?.epoch??0)+1;
            // Stable owner-action ID for a given revoked epoch: retrying a
            // partial two-store grant does not invent a new decision or re-
            // grant a historical epoch after a later revoke.
            const decision=previous
              ?createHmac("sha256",key).update(JSON.stringify([
                "lumi:c3b:explicit-consent-decision:v1",actor,gen,
                previous.epoch,previous.ownerDecision,
              ])).digest("hex").slice(0,48)
              :INBOX_FIRST_OWNER_DECISION;
            // Initial grant first records target, regrant first records fence.
            // Until BOTH commit, an outbound AI call cannot be authorized.
            if(previous&&!recordExplicitInboxAIGrant(
              fence,actor,owner,gen,INBOX_AI_DATA_SCOPE_VERSION,decision))fail();
            const changed=authority.changeInboxAIConsent(
              issued.sessionToken,actor,{mode:"grant",epoch,
                restoreGeneration:gen,ownerDecision:decision,
                dataScopeVersion:INBOX_AI_DATA_SCOPE_VERSION},
              identity.sessionTokenHash);
            if(!changed.ok)fail();
            if(!previous&&!recordExplicitInboxAIGrant(fence,actor,owner,
              gen,INBOX_AI_DATA_SCOPE_VERSION,decision))fail();
            if(!targetInboxAIConsentMatchesFence(changed.record,
                readInboxAIFenceGrant(fence,actor),gen))fail();
            output({ok:true,enabled:true,pending:false});
          }
        }else{
          // Revoke fence FIRST. The dispatch worker cannot start another
          // request after the external serial revoke commits.
          const revoked=revokeInboxAIConsent(fence,actor);
          if(!revoked)fail();
          let record=previous;
          // Reconcile a newer fence revoke, including a prior target OFF epoch.
          // This path can only disable consent; it never issues a new grant.
          if(record&&record.epoch<revoked.epoch){
            const result=authority.changeInboxAIConsent(
              issued.sessionToken,actor,{mode:"revoke",epoch:revoked.epoch,
                restoreGeneration:gen,ownerDecision:record.ownerDecision,
                dataScopeVersion:INBOX_AI_DATA_SCOPE_VERSION},
              identity.sessionTokenHash);
            if(!result.ok)fail();
            record=result.record;
          }
          if(!record||record.enabled||record.epoch!==revoked.epoch)fail();
          output({ok:true,enabled:false,pending:
            !inboxAIRevokeDrained(fence,actor,revoked.epoch)});
        }
      }finally{fence.close();}
    }
  }finally{authority.close();}
}catch{process.exitCode=1;}
