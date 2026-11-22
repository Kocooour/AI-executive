import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,mkdirSync,chmodSync,rmSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  provisionInboxAIFenceSchema,recordExplicitInboxAIGrant,
  readInboxAIFenceGrant,revokeInboxAIConsent,inboxAIRevokeDrained,
  beginInboxAIDispatch,inboxAIDispatchStillAllowed,endInboxAIDispatch,
  verifiedInboxAIFencePath,
} from "../lib/target-inbox-ai-consent-fence.ts";

const GEN="123e4567-e89b-42d3-a456-426614174000",SCOPE="c3b:v1";
const baseTime=Date.parse("2026-11-22T11:00:00Z");
function fixture(){
  const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3b-fence-"));
  const target=path.join(root,"target-store");
  mkdirSync(target);
  const file=path.join(root,"outside-restore-fence.sqlite");
  const db=new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=1000;");
  assert.equal(provisionInboxAIFenceSchema(db),true);
  const db2=new DatabaseSync(file);
  db2.exec("PRAGMA busy_timeout=1000;");
  return {db,db2,file,target,close(){
    db2.close();db.close();rmSync(root,{recursive:true,force:true});
  }};
}
function grant(db,actor="owner",gen=GEN,decision="owner-approved-v1"){
  return recordExplicitInboxAIGrant(db,actor,actor,gen,SCOPE,decision);
}

test("C-3b external fence: location must be a pre-existing private file outside restore",()=>{
  const x=fixture();
  try{
    chmodSync(x.file,0o600);
    assert.equal(verifiedInboxAIFencePath(x.file,x.target),x.file);
    assert.equal(verifiedInboxAIFencePath(path.join(x.target,"missing"),x.target),null);
    assert.equal(verifiedInboxAIFencePath(path.join(x.target,"inside.db"),x.target),null);
    chmodSync(x.file,0o644);
    assert.equal(verifiedInboxAIFencePath(x.file,x.target),null);
  }finally{x.close();}
});

test("C-3b fence: two workers see explicit initial grant and shared pending/revoke state",()=>{
  const x=fixture();
  try{
    assert.equal(readInboxAIFenceGrant(x.db2,"owner"),null,"default AI off");
    const g=grant(x.db);
    assert.equal(g.active,true);
    assert.equal(g.epoch,1);
    assert.deepEqual(readInboxAIFenceGrant(x.db2,"owner"),g);
    assert.deepEqual(grant(x.db2),g,"same grant is idempotent");
    const ticket=beginInboxAIDispatch(x.db,"owner",GEN,SCOPE,baseTime);
    assert.ok(ticket);
    assert.equal(inboxAIDispatchStillAllowed(x.db2,ticket),true);
    assert.equal(beginInboxAIDispatch(x.db2,"owner",GEN,SCOPE,baseTime),null,
      "second worker cannot bypass per-actor pending cap");
    const revoked=revokeInboxAIConsent(x.db2,"owner");
    assert.equal(revoked.epoch,2);
    assert.equal(revoked.drained,false,"pending network ticket blocks confirmation");
    assert.equal(inboxAIRevokeDrained(x.db,"owner",2),false);
    assert.equal(inboxAIDispatchStillAllowed(x.db,ticket),false);
    assert.equal(beginInboxAIDispatch(x.db,"owner",GEN,SCOPE,baseTime),null);
    assert.equal(endInboxAIDispatch(x.db,ticket),false,
      "late result after revocation must be discarded");
    assert.equal(inboxAIRevokeDrained(x.db2,"owner",2),true);
    assert.equal(readInboxAIFenceGrant(x.db,"owner").active,false);
  }finally{x.close();}
});

test("C-3b fence: scope/restore mismatch and a missing fence fail closed",()=>{
  const x=fixture();
  try{
    assert.equal(grant(x.db).active,true);
    assert.equal(beginInboxAIDispatch(x.db,"owner",
      "123e4567-e89b-42d3-a456-426614174001",SCOPE,baseTime),null);
    assert.equal(beginInboxAIDispatch(x.db,"owner",GEN,"c3b:v2",baseTime),null);
    assert.equal(beginInboxAIDispatch(x.db,"other",GEN,SCOPE,baseTime),null);
    assert.equal(recordExplicitInboxAIGrant(x.db,"other","owner",GEN,SCOPE,
      "wrong-owner"),null);
    const ticket=beginInboxAIDispatch(x.db2,"owner",GEN,SCOPE,baseTime);
    assert.ok(ticket);
    assert.equal(endInboxAIDispatch(x.db,ticket),true);
    x.db.exec("DROP TABLE inbox_ai_fence_meta");
    assert.equal(beginInboxAIDispatch(x.db2,"owner",GEN,SCOPE,baseTime),null);
  }finally{x.close();}
});

test("C-3b fence: per-actor and global minute budgets persist across workers",()=>{
  const x=fixture();
  try{
    grant(x.db);
    for(let i=0;i<3;i++){
      const ticket=beginInboxAIDispatch(x.db2,"owner",GEN,SCOPE,baseTime+i);
      assert.ok(ticket);
      assert.equal(endInboxAIDispatch(x.db,ticket),true);
    }
    assert.equal(beginInboxAIDispatch(x.db,"owner",GEN,SCOPE,baseTime+4),null);
    assert.ok(beginInboxAIDispatch(x.db,"owner",GEN,SCOPE,baseTime+60_000),
      "next-minute budget recovers");
  }finally{x.close();}
});

test("C-3b fence: revoke is monotonic and never undone by an old restored target grant",()=>{
  const x=fixture();
  try{
    const first=grant(x.db);
    assert.equal(first.epoch,1);
    assert.deepEqual(revokeInboxAIConsent(x.db2,"owner"),{epoch:2,drained:true});
    assert.deepEqual(revokeInboxAIConsent(x.db,"owner"),{epoch:2,drained:true},
      "revoke idempotent across workers");
    assert.equal(inboxAIRevokeDrained(x.db2,"owner",2),true);
    assert.equal(beginInboxAIDispatch(x.db,"owner",GEN,SCOPE,baseTime),null);
    assert.equal(grant(x.db,"owner",GEN,"owner-approved-v1"),null,
      "restored initial decision cannot regrant after external revocation");
    // This primitive does NOT infer new consent from the restored target DB.
    // Only an explicit privileged grant may advance the epoch to 3.
    const again=grant(x.db2,"owner",GEN,"new-explicit-owner-decision");
    assert.equal(again.epoch,3);
    assert.equal(again.active,true);
    assert.equal(inboxAIRevokeDrained(x.db,"owner",2),false);
    assert.deepEqual(revokeInboxAIConsent(x.db,"owner"),{epoch:4,drained:true});
    assert.equal(grant(x.db,"owner",GEN,"owner-approved-v1"),null,
      "historically used decision v1 must never be reusable after later epochs");
    assert.equal(grant(x.db,"owner",GEN,"new-explicit-owner-decision"),null,
      "historically used decision v2 must never be reusable either");
  }finally{x.close();}
});

test("C-3b fence: consent regrant blocked until all prior tickets drain",()=>{
  const x=fixture();
  try{
    grant(x.db);
    const ticket=beginInboxAIDispatch(x.db,"owner",GEN,SCOPE,baseTime);
    assert.ok(ticket);
    assert.deepEqual(revokeInboxAIConsent(x.db2,"owner"),
      {epoch:2,drained:false});
    assert.equal(grant(x.db,"owner",GEN,"new-explicit-owner-decision"),null);
    assert.equal(endInboxAIDispatch(x.db2,ticket),false);
    assert.equal(inboxAIRevokeDrained(x.db,"owner",2),true);
    assert.equal(grant(x.db,"owner",GEN,"new-explicit-owner-decision").epoch,3);
  }finally{x.close();}
});
