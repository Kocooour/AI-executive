import assert from "node:assert/strict";
import {test} from "node:test";
import {parseStagingTargetInboxPage} from "../lib/target-staging-read-process.ts";
import {parseInboxWriteReply,parseInboxReceiptReply} from "../lib/target-inbox-http-process.ts";
import {parseInboxClientPage,verifyInboxCommand} from "../lib/target-inbox-client.ts";
import {targetInboxUiEnabled} from "../lib/target-ui-config.ts";
import {validTargetInboxTriageCommand} from "../lib/target-inbox-triage-writer.ts";
import {randomUUID} from "node:crypto";

const epoch={areaId:"private:alice",areaKind:"private",access:"private-owner",
  policyRevision:0,contentRevision:1,projectContentRevision:0};
const linearization={actorUserId:"alice",areas:[{
  areaId:epoch.areaId,areaKind:epoch.areaKind,access:epoch.access,
  policyRevision:epoch.policyRevision,
}]};
const item={id:"task-1",title:"Inbox entry",status:"completed",triageRevision:0,
  taskRevision:2,effectiveAreaId:epoch.areaId,canProcess:true,
  // Completed Inbox items cannot receive a C-3b suggestion even if their
  // C-3a Process action remains authorized.
  canSuggest:false,expectedRevision:"a".repeat(64)};
const raw={ok:true,items:[item],count:1,nextCursor:null,
  areaEpochs:[epoch],linearization};
const command={commandId:randomUUID(),taskId:item.id,mode:"process",
  undoOfCommandId:null,expectedRevision:item.expectedRevision,
  expectedTriageRevision:item.triageRevision,writeAreaId:item.effectiveAreaId,
  restoreGeneration:randomUUID()};

test("C-3a: worker parser binds actor/Area witness; browser never sees it",()=>{
  const internal=parseStagingTargetInboxPage(raw,50);
  assert.ok(internal);
  assert.equal(internal.items[0].status,"completed");
  assert.equal(internal.linearization.actorUserId,"alice");
  const client={items:internal.items,count:internal.count,nextCursor:null,
    restoreGeneration:command.restoreGeneration,snapshotRevision:"f".repeat(64)};
  assert.deepEqual(parseInboxClientPage(client,50),client);
  assert.equal(parseInboxClientPage({...client,linearization},50),null);
  assert.equal(parseInboxClientPage({...client,areaEpochs:[epoch]},50),null);
  assert.equal(parseStagingTargetInboxPage({...raw,leaked:true},50),null);
  assert.equal(parseStagingTargetInboxPage({...raw,
    areaEpochs:[{...epoch,policyRevision:2}]},50),null);
  assert.equal(parseStagingTargetInboxPage({...raw,
    items:[{...item,expectedRevision:null}]},50),null);
  assert.equal(parseStagingTargetInboxPage({...raw,
    items:[{...item,canProcess:false,expectedRevision:null}]},50)!==null,true);
  assert.equal(parseStagingTargetInboxPage({...raw,
    items:[{...item,canSuggest:true}]},50),null,
    "completed Inbox item cannot gain AI suggestion permission");
});

test("C-3a: receipt proof and Process/Undo responses are exact, not caller-shaped",()=>{
  assert.deepEqual(parseInboxWriteReply({ok:true}),{ok:true});
  assert.deepEqual(parseInboxWriteReply({ok:true,replayed:true}),{ok:true,replayed:true});
  assert.equal(parseInboxWriteReply({ok:true,receipts:[item]}),null);
  const receipt={ok:true,status:"committed",next:{
    expectedRevision:"b".repeat(64),triageRevision:1,writeAreaId:epoch.areaId,
  },linearization,areaEpochs:[epoch]};
  assert.ok(parseInboxReceiptReply(receipt));
  assert.equal(parseInboxReceiptReply({...receipt,taskTitle:"private"}),null);
  assert.equal(parseInboxReceiptReply({...receipt,next:{...receipt.next,
    writeAreaId:"foreign"}}),null);
  assert.equal(parseInboxReceiptReply({...receipt,status:"not_recorded"}),null);
  assert.ok(parseInboxReceiptReply({...receipt,status:"not_recorded",next:null}));
  assert.equal(validTargetInboxTriageCommand(command),true);
  assert.equal(validTargetInboxTriageCommand({...command,actorUserId:"bob"}),false);
});

test("C-3a: all read/write/UI gates default off; no partial promotion",()=>{
  const flags={
    AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:"true",
    AI_EXECUTIVE_TARGET_UI_ENABLED:"true",
    AI_EXECUTIVE_TARGET_UI_MY_PLAN_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_HOME_ENABLED:"true",
    AI_EXECUTIVE_TARGET_UI_INBOX_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:"true",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_INBOX_WRITE_ENABLED:"true",
  };
  assert.equal(targetInboxUiEnabled(flags),true);
  for(const key of Object.keys(flags)){
    assert.equal(targetInboxUiEnabled({...flags,[key]:"false"}),false,key);
    assert.equal(targetInboxUiEnabled({...flags,[key]:undefined}),false,key);
  }
  assert.equal(targetInboxUiEnabled({}),false);
});

test("C-3a: C-3b capacity pressure retries only the read-only original receipt",async()=>{
  const original=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(input,init)=>{
    assert.equal(String(input),"/api/target-staging/inbox/receipt");
    assert.equal(init.method,"POST");
    const sent=JSON.parse(init.body);
    calls.push(sent);
    if(calls.length<3)
      return Response.json({error:"Staging unavailable"},{status:503});
    return Response.json({ok:true,status:"not_recorded",next:null});
  };
  try{
    assert.deepEqual(await verifyInboxCommand(command),
      {ok:true,status:"not_recorded",next:null});
    assert.equal(calls.length,3);
    assert.ok(calls.every(x=>JSON.stringify(x)===JSON.stringify(command)),
      "only a read-only receipt may be retried, with identical original UUID and CAS");
  }finally{globalThis.fetch=original;}
});

test("C-3a: authorization refusal and stale receipt never trigger a retry",async()=>{
  const original=globalThis.fetch;
  try{
    for(const [status,reason] of [[403,"signed-out"],[409,"stale"],[404,"feature-off"]]){
      let calls=0;
      globalThis.fetch=async()=>{
        calls++;
        return Response.json({error:"refused"},{status});
      };
      assert.deepEqual(await verifyInboxCommand(command),{ok:false,reason});
      assert.equal(calls,1,"do not retry permanent refusal "+status);
    }
  }finally{globalThis.fetch=original;}
});
