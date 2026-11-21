import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {after,test} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-c3a-command-proof-"));
const legacy=path.join(root,"legacy");mkdirSync(legacy);
const before={data:process.env.AI_EXECUTIVE_DATA_DIR,
  secret:process.env.AI_EXECUTIVE_SESSION_SECRET};
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
process.env.AI_EXECUTIVE_SESSION_SECRET="test-inbox-command-proof-secret-at-least-thirty-two-characters";
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {issueTargetInboxRevision,verifyIssuedTargetInboxRevision,
  issueTargetInboxCommandId,verifyTargetInboxCommandId,
  inboxWorkerProofKey}=await import("../lib/target-inbox-command-identity.ts");
const store=bootstrapIsolatedTargetStore({
  stagingDirectory:path.join(root,randomUUID()),ownerUserId:"alice",
});
const db=new DatabaseSync(store.databasePath);db.exec("PRAGMA foreign_keys=ON");
db.prepare("INSERT INTO tasks(id,area_id,title) VALUES ('entry',?,'Inbox work')")
  .run(store.unassignedAreaId);
after(()=>{
  db.close();rmSync(root,{recursive:true,force:true});
  if(before.data===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=before.data;
  if(before.secret===undefined)delete process.env.AI_EXECUTIVE_SESSION_SECRET;
  else process.env.AI_EXECUTIVE_SESSION_SECRET=before.secret;
});

test("C-3a issued CAS authenticates actor and original Area/epoch after task revision changes",()=>{
  const fields={
    taskId:"entry",mode:"process",undoOfCommandId:null,
    expectedTriageRevision:0,writeAreaId:store.unassignedAreaId,
    restoreGeneration:store.restoreGeneration,
    expectedRevision:issueTargetInboxRevision(db,"alice","entry",0,
      store.unassignedAreaId,store.restoreGeneration),
  };
  assert.match(fields.expectedRevision,/^[a-f0-9]{64}$/);
  assert.equal(verifyIssuedTargetInboxRevision("alice",fields),true);
  assert.equal(verifyIssuedTargetInboxRevision("bob",fields),false,
    "another actor cannot assert someone else's historical command");
  const id=issueTargetInboxCommandId(fields),issued={...fields,commandId:id};
  assert.equal(verifyTargetInboxCommandId(issued),true);
  assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  for(const modified of [
    {...issued,expectedTriageRevision:1},
    {...issued,writeAreaId:"other"},
    {...issued,mode:"undo",undoOfCommandId:randomUUID()},
    {...issued,restoreGeneration:randomUUID()},
    {...issued,expectedRevision:"0".repeat(64)},
  ]){
    assert.equal(verifyTargetInboxCommandId(modified),false,
      "same UUID cannot be rebound to a different original payload");
    if(modified.expectedRevision!==fields.expectedRevision||
        modified.writeAreaId!==fields.writeAreaId||
        modified.expectedTriageRevision!==fields.expectedTriageRevision||
        modified.restoreGeneration!==fields.restoreGeneration)
      assert.equal(verifyIssuedTargetInboxRevision("alice",modified),false,
        "the signer binds Area, epoch and restore generation");
    // Mode/Undo parent are bound by the self-certifying UUID, not by the
    // actor-issued task CAS (which is also used to mint a later Undo).

  }
  db.prepare("UPDATE tasks SET title='new CAS' WHERE id='entry'").run();
  assert.equal(verifyIssuedTargetInboxRevision("alice",fields),true,
    "historical proof remains authentic even after a valid task mutation");
  const fresh={...fields,expectedRevision:issueTargetInboxRevision(
    db,"alice","entry",0,store.unassignedAreaId,store.restoreGeneration)};
  assert.notEqual(fresh.expectedRevision,fields.expectedRevision);
  assert.notEqual(issueTargetInboxCommandId(fresh),id);
  assert.equal(verifyTargetInboxCommandId({...fresh,commandId:id}),false);
});

test("C-3a scoped HMAC key never needs to expose application session signing secret",()=>{
  const derived=inboxWorkerProofKey();
  assert.match(derived,/^[a-f0-9]{64}$/);
  const original=process.env.AI_EXECUTIVE_SESSION_SECRET;
  try{
    delete process.env.AI_EXECUTIVE_SESSION_SECRET;
    process.env.AI_EXECUTIVE_TARGET_STAGING_INBOX_PROOF_KEY=derived;
    const issued=issueTargetInboxRevision(db,"alice","entry",0,
      store.unassignedAreaId,store.restoreGeneration);
    assert.match(issued,/^[a-f0-9]{64}$/);
    assert.equal(verifyIssuedTargetInboxRevision("alice",{
      taskId:"entry",mode:"process",undoOfCommandId:null,
      expectedRevision:issued,expectedTriageRevision:0,
      writeAreaId:store.unassignedAreaId,
      restoreGeneration:store.restoreGeneration,
    }),true);
  }finally{
    process.env.AI_EXECUTIVE_SESSION_SECRET=original;
    delete process.env.AI_EXECUTIVE_TARGET_STAGING_INBOX_PROOF_KEY;
  }
});
