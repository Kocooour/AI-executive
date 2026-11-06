import assert from "node:assert/strict";
import {test} from "node:test";
import {
  keepConfirmedMyPlanUndoOnRefresh,prepareConfirmedMyPlanUndo,
} from "../lib/target-staging-my-plan-undo.ts";
import {
  dispatchMyPlanStatus,
} from "../lib/target-staging-my-plan-status-client.ts";
import {fetchMyPlanSlice} from "../lib/target-staging-my-plan-client.ts";

const original={
  commandId:"123e4567-e89b-42d3-a456-426614174000",
  taskId:"confirmed-task",status:"completed",
  expectedRevision:"a".repeat(64),
  writeAreaId:"private-home",
  restoreGeneration:"765e4567-e89b-42d3-a456-426614174000",
};
const refreshedRevision="b".repeat(64);
const snapshot={expectedRevision:refreshedRevision,
  writeAreaId:original.writeAreaId,
  restoreGeneration:original.restoreGeneration};
const json=(body,status=200)=>Response.json(body,{
  status,headers:{"cache-control":"no-store"},
});
const successRead={
  evaluationDate:"2026-11-06",areaFilter:"all",
  today:{tasks:[],hasMore:false},tomorrow:{tasks:[],hasMore:false},
  hasMore:false,nextCursor:null,
};
const params={evaluationDate:"2026-11-06",areaFilter:"all"};

test("P1: Undo receipt 503 preserves confirmed completion; later manual retry obtains fresh CAS",async()=>{
  const calls=[];
  let receiptFailure=true;
  const request=async(url,options)=>{
    calls.push({method:options.method,url,body:options.body?JSON.parse(options.body):null});
    if(options.method==="POST"){
      assert.match(url,/\/status\/receipt$/);
      assert.deepEqual(JSON.parse(options.body),original,
        "actor-bound receipt must verify original completion before Undo");
      return receiptFailure?json({error:"unavailable"},503):
        json({status:"committed"});
    }
    assert.equal(options.method,"GET");
    assert.match(url,/\/status\?taskId=confirmed-task$/);
    return json(snapshot);
  };
  let confirmed=original;
  let response=await prepareConfirmedMyPlanUndo(confirmed,request);
  assert.deepEqual(response,{kind:"retry",reason:"unavailable"});
  assert.equal(confirmed,original);
  assert.deepEqual(calls.map(c=>c.method),["POST"],
    "503 must never generate CAS GET or PATCH");
  receiptFailure=false;
  response=await prepareConfirmedMyPlanUndo(confirmed,request);
  assert.equal(response.kind,"ready");
  assert.equal(response.command.taskId,original.taskId);
  assert.equal(response.command.writeAreaId,original.writeAreaId);
  assert.equal(response.command.status,"open");
  assert.equal(response.command.expectedRevision,refreshedRevision);
  assert.notEqual(response.command.commandId,original.commandId,
    "Undo must use a brand-new UUID even after receipt retries");
  assert.deepEqual(calls.map(c=>c.method),["POST","POST","GET"]);
  assert.equal(confirmed,original,"confirmation remains until reversal is dispatched");

  const result=await dispatchMyPlanStatus(response.command,async(url,opts)=>{
    calls.push({method:opts.method,url,body:JSON.parse(opts.body)});
    assert.equal(opts.method,"PATCH");
    assert.equal(opts.headers["x-lumi-target-protocol"],"1");
    return json({ok:true});
  });
  assert.equal(result.kind,"committed");
  assert.deepEqual(calls.map(c=>c.method),["POST","POST","GET","PATCH"],
    "only the explicit, freshly authorized reversal dispatches one PATCH");
});

test("P1: committed receipt + Undo CAS preflight 503 is retryable without PATCH",async()=>{
  const methods=[];
  let preflightUnavailable=true;
  const request=async(_url,opts)=>{
    methods.push(opts.method);
    return opts.method==="POST"?json({status:"committed"}):
      preflightUnavailable?json({error:"unavailable"},503):json(snapshot);
  };
  const first=await prepareConfirmedMyPlanUndo(original,request);
  assert.deepEqual(first,{kind:"retry",reason:"unavailable"});
  assert.deepEqual(methods,["POST","GET"]);
  preflightUnavailable=false;
  const second=await prepareConfirmedMyPlanUndo(original,request);
  assert.equal(second.kind,"ready");
  assert.notEqual(second.command.commandId,original.commandId);
  assert.deepEqual(methods,["POST","GET","POST","GET"]);
});

test("P1: not-recorded receipt and signed-out receipt or preflight cannot authorize reversal",async()=>{
  let calls=[];
  const notRecorded=await prepareConfirmedMyPlanUndo(original,async(_url,options)=>{
    calls.push(options.method);
    return json({status:"not_recorded"});
  });
  assert.deepEqual(notRecorded,{kind:"retry",reason:"stale"});
  assert.deepEqual(calls,["POST"]);
  calls=[];
  const deniedReceipt=await prepareConfirmedMyPlanUndo(original,async(_url,options)=>{
    calls.push(options.method);
    return json({error:"no actor"},401);
  });
  assert.deepEqual(deniedReceipt,{kind:"signed-out"});
  assert.deepEqual(calls,["POST"]);
  calls=[];
  const deniedPreflight=await prepareConfirmedMyPlanUndo(original,async(_url,options)=>{
    calls.push(options.method);
    return options.method==="POST"
      ?json({status:"committed"}):json({error:"no actor"},403);
  });
  assert.deepEqual(deniedPreflight,{kind:"signed-out"});
  assert.deepEqual(calls,["POST","GET"]);
  calls=[];
  const invalid=await prepareConfirmedMyPlanUndo({...original,status:"open"},
    async()=>{throw Error("invalid command must not fetch");});
  assert.deepEqual(invalid,{kind:"retry",reason:"invalid-request"});
});

test("P1: confirmed completion survives temporary My Plan GET failure and authorized retry",async()=>{
  const action={kind:"committed",status:"completed",
    taskId:original.taskId,areaId:original.writeAreaId};
  let confirmed=original;
  let calls=[];
  const read=(failed)=>fetchMyPlanSlice(params,async(_url,opts)=>{
    calls.push(opts.method);
    assert.equal(opts.method,"GET");
    assert.equal(opts.credentials,"same-origin");
    assert.equal(opts.cache,"no-store");
    return failed?json({error:"temporarily unavailable"},503):json(successRead);
  });
  const failed=await read(true);
  assert.deepEqual(failed,{ok:false,reason:"unavailable"});
  assert.equal(keepConfirmedMyPlanUndoOnRefresh(action,confirmed),true);
  const refreshed=await read(false);
  assert.equal(refreshed.ok,true);
  assert.equal(confirmed,original,
    "same-task Undo must remain after GET 503 and successful GET-only retry");
  assert.deepEqual(calls,["GET","GET"]);
  // Current-actor original receipt is always rechecked before a new CAS;
  // retaining UI state does not itself grant permission to reverse.
  const prepared=await prepareConfirmedMyPlanUndo(confirmed,async(_url,opts)=>
    opts.method==="POST"?json({status:"committed"}):json(snapshot));
  assert.equal(prepared.kind,"ready");
  assert.notEqual(prepared.command.commandId,original.commandId);
});

test("P1: read-only refresh cannot preserve stale, unrelated, invalid or reversed Undo",()=>{
  const valid={kind:"committed",status:"completed",
    taskId:original.taskId,areaId:original.writeAreaId};
  assert.equal(keepConfirmedMyPlanUndoOnRefresh(valid,original),true);
  for(const [action,command] of [
    [valid,null],
    [{...valid,kind:"uncertain"},original],
    [{...valid,kind:"error"},original],
    [{...valid,status:"open"},original],
    [{...valid,taskId:"other"},original],
    [{...valid,areaId:"shared-other"},original],
    [valid,{...original,status:"open"}],
    [valid,{...original,commandId:"not-uuid"}],
  ])assert.equal(keepConfirmedMyPlanUndoOnRefresh(action,command),false);
});
