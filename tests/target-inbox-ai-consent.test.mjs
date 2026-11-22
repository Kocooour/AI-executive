import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3b-consent-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
const oldDir=process.env.AI_EXECUTIVE_DATA_DIR;
const oldSecret=process.env.AI_EXECUTIVE_SESSION_SECRET;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
process.env.AI_EXECUTIVE_SESSION_SECRET="C3b-consent-test-session-secret-long-enough";
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {targetInboxAIConsentMatchesFence,
  INBOX_FIRST_OWNER_DECISION,INBOX_AI_DATA_SCOPE_VERSION}=
  await import("../lib/target-inbox-ai-consent.ts");
const {provisionInboxAIFenceSchema,recordExplicitInboxAIGrant,
  readInboxAIFenceGrant,revokeInboxAIConsent}=
  await import("../lib/target-inbox-ai-consent-fence.ts");
const {inspectIsolatedTargetStore}=await import("../lib/target-store-preflight.ts");
const stages=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
  });
  const store={stagingDirectory:stage.directory,
    expectedRestoreGeneration:stage.restoreGeneration};
  const authority=new TargetStagingSessionAuthority(store);
  const token=authority.issueWritable("alice").sessionToken;
  const fence=new DatabaseSync(":memory:");
  assert.equal(provisionInboxAIFenceSchema(fence),true);
  stages.push({stage,store,authority,fence});
  return {stage,store,authority,token,fence};
}
test.after(()=>{
  for(const fx of stages){fx.authority.close();fx.fence.close();}
  if(oldDir===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=oldDir;
  if(oldSecret===undefined)delete process.env.AI_EXECUTIVE_SESSION_SECRET;
  else process.env.AI_EXECUTIVE_SESSION_SECRET=oldSecret;
  rmSync(root,{recursive:true,force:true});
});
const cmd=(fx,mode,epoch,ownerDecision)=>({
  mode,epoch,ownerDecision,restoreGeneration:fx.stage.restoreGeneration,
  dataScopeVersion:INBOX_AI_DATA_SCOPE_VERSION,
});

test("C-3b v27 consent: default off, explicit owner first release, idempotent grant",()=>{
  const x=fixture(),first=cmd(x,"grant",1,INBOX_FIRST_OWNER_DECISION);
  assert.equal(x.authority.readInboxAIConsent("alice"),null);
  assert.equal(x.authority.changeInboxAIConsent(x.token,"bob",first).ok,false);
  assert.equal(x.authority.changeInboxAIConsent(x.token,"alice",
    cmd(x,"grant",1,"unapproved")).ok,false);
  const g=x.authority.changeInboxAIConsent(x.token,"alice",first);
  assert.equal(g.ok,true);
  assert.equal(g.record.enabled,true);
  assert.equal(g.record.epoch,1);
  assert.equal(g.record.decisionSource,"2026-11-19:#471");
  assert.deepEqual(x.authority.changeInboxAIConsent(x.token,"alice",first),
    {...g,replayed:true});
  assert.deepEqual(x.authority.readInboxAIConsent("alice"),g.record);
  const fenced=recordExplicitInboxAIGrant(x.fence,"alice","alice",
    x.stage.restoreGeneration,INBOX_AI_DATA_SCOPE_VERSION,INBOX_FIRST_OWNER_DECISION);
  assert.equal(fenced.active,true);
  assert.equal(targetInboxAIConsentMatchesFence(g.record,fenced,
    x.stage.restoreGeneration),true);
  assert.equal(targetInboxAIConsentMatchesFence(g.record,null,
    x.stage.restoreGeneration),false);
  assert.deepEqual(inspectIsolatedTargetStore({...x.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
});

test("C-3b consent: external revoke immediately disables AI even with stale target true",()=>{
  const x=fixture(),first=cmd(x,"grant",1,INBOX_FIRST_OWNER_DECISION);
  assert.equal(x.authority.changeInboxAIConsent(x.token,"alice",first).ok,true);
  const fg=recordExplicitInboxAIGrant(x.fence,"alice","alice",
    x.stage.restoreGeneration,INBOX_AI_DATA_SCOPE_VERSION,INBOX_FIRST_OWNER_DECISION);
  assert.ok(fg);
  assert.deepEqual(revokeInboxAIConsent(x.fence,"alice"),{epoch:2,drained:true});
  assert.equal(targetInboxAIConsentMatchesFence(
    x.authority.readInboxAIConsent("alice"),
    readInboxAIFenceGrant(x.fence,"alice"),
    x.stage.restoreGeneration),false);
  const off=x.authority.changeInboxAIConsent(x.token,"alice",
    cmd(x,"revoke",2,INBOX_FIRST_OWNER_DECISION));
  assert.equal(off.ok,true);
  assert.equal(off.record.enabled,false);
  assert.deepEqual(x.authority.changeInboxAIConsent(x.token,"alice",
    cmd(x,"revoke",2,INBOX_FIRST_OWNER_DECISION)),{...off,replayed:true});
  assert.equal(x.authority.changeInboxAIConsent(x.token,"alice",
    cmd(x,"grant",3,INBOX_FIRST_OWNER_DECISION)).ok,false,
    "replaying first approval cannot regrant");
  const second="explicit-owner-regrant-2026-11-22";
  const fg2=recordExplicitInboxAIGrant(x.fence,"alice","alice",
    x.stage.restoreGeneration,INBOX_AI_DATA_SCOPE_VERSION,second);
  assert.ok(fg2);
  assert.equal(targetInboxAIConsentMatchesFence(
    x.authority.readInboxAIConsent("alice"),fg2,x.stage.restoreGeneration),false,
    "target is still revoked while the external fence has a new epoch");
  const on=x.authority.changeInboxAIConsent(x.token,"alice",cmd(x,"grant",3,second));
  assert.equal(on.ok,true);
  assert.equal(targetInboxAIConsentMatchesFence(on.record,fg2,
    x.stage.restoreGeneration),true);
  assert.equal(targetInboxAIConsentMatchesFence(on.record,fg2,
    randomUUID()),false,"old DB consent does not survive a new restore generation");
});

test("C-3b target preflight rejects tampered consent record",()=>{
  const x=fixture(),first=cmd(x,"grant",1,INBOX_FIRST_OWNER_DECISION);
  assert.equal(x.authority.changeInboxAIConsent(x.token,"alice",first).ok,true);
  const db=new DatabaseSync(x.stage.databasePath);
  try{
    const old=db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'r3:c3b:ai-target-consent:v1:%'").get();
    assert.ok(old);
    const forged=JSON.parse(old.value);forged.actorUserId="bob";
    db.prepare("UPDATE metadata SET value=? WHERE key=?")
      .run(JSON.stringify(forged),old.key);
    const inspection=inspectIsolatedTargetStore({...x.store,mode:"r2-model"});
    assert.equal(inspection.ok,false);
    assert.ok(inspection.issues.includes("metadata_invalid"));
  }finally{db.close();}
});

test("C-3b consent: fail closed on bad generation and scope without write",()=>{
  const x=fixture();
  const first=cmd(x,"grant",1,INBOX_FIRST_OWNER_DECISION);
  assert.equal(x.authority.changeInboxAIConsent(x.token,"alice",
    {...first,restoreGeneration:randomUUID()}).ok,false);
  assert.equal(x.authority.changeInboxAIConsent(x.token,"alice",
    {...first,dataScopeVersion:"c3b:v2"}).ok,false);
  assert.equal(x.authority.readInboxAIConsent("alice"),null);
});

test("C-3b clean production v27 remains backward compatible without metadata writes",()=>{
  const x=fixture();
  const before=x.authority.readInboxAIConsent("alice");
  assert.equal(before,null,"untouched v27 does not acquire C-3b consent");
  assert.deepEqual(inspectIsolatedTargetStore({...x.store,mode:"r2-model"}),
    {ok:true,mode:"r2-model",issues:[]});
  assert.equal(x.authority.readInboxAIConsent("alice"),null,
    "read-only check never writes consent namespaces");
});
