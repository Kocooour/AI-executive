import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {prepareMyPlanStatus,dispatchMyPlanStatus} from "../lib/target-staging-my-plan-status-client.ts";
import {prepareMyPlanWhen,dispatchMyPlanWhen} from "../lib/target-staging-my-plan-when-client.ts";
import {prepareConfirmedMyPlanUndo,keepConfirmedMyPlanUndoOnRefresh} from "../lib/target-staging-my-plan-undo.ts";
import {prepareConfirmedWhenUndo,keepConfirmedWhenOnRefresh} from "../lib/target-staging-my-plan-when-undo.ts";
import {fetchMyPlanSlice} from "../lib/target-staging-my-plan-client.ts";

const root=path.join(import.meta.dirname,"..");
const source=()=>readFileSync(path.join(root,"app/ui/target-staging-my-plan-preview.tsx"),"utf8");
const id="123e4567-e89b-42d3-a456-426614174000";
const restoreGeneration="765e4567-e89b-42d3-a456-426614174000";
const area="private-area";
const originalStatus={
  commandId:id,taskId:"completed-A",status:"completed",
  expectedRevision:"a".repeat(64),writeAreaId:area,restoreGeneration,
};
const originalWhen={
  command:{
    commandId:"123e4567-e89b-42d3-a456-426614174001",
    taskId:"planned-A",whenOn:"2026-11-07",
    expectedRevision:"a".repeat(64),expectedPrivateEpoch:3,
    expectedPlanRevision:0,writeAreaId:area,restoreGeneration,
  },
  previousWhenOn:"2026-11-06",
};
const statusAction={kind:"committed",taskId:originalStatus.taskId,
  areaId:area,status:"completed"};
const whenAction={kind:"committed",taskId:originalWhen.command.taskId,
  areaId:area,whenOn:originalWhen.command.whenOn,
  previousWhenOn:originalWhen.previousWhenOn,undoable:true};
const statusPreview={expectedRevision:"b".repeat(64),writeAreaId:area,restoreGeneration};
const whenPreview={expectedRevision:"b".repeat(64),expectedPrivateEpoch:4,
  expectedPlanRevision:1,whenOn:originalWhen.command.whenOn,
  writeAreaId:area,restoreGeneration};
const whenBPreview={...whenPreview,whenOn:null};
const json=(body,status=200)=>Response.json(body,{
  status,headers:{"cache-control":"no-store"},
});
const page={
  evaluationDate:"2026-11-06",areaFilter:"all",
  today:{tasks:[],hasMore:false},tomorrow:{tasks:[],hasMore:false},
  hasMore:false,nextCursor:null,
};
const reauthorize=async(calls)=>{
  const read=await fetchMyPlanSlice({
    evaluationDate:"2026-11-06",areaFilter:"all",
  },async(_url,opts)=>{
    calls.push(opts.method+" list");
    return json(page);
  });
  assert.equal(read.ok,true);
};
const statusUndo=async(calls)=>{
  const undo=await prepareConfirmedMyPlanUndo(originalStatus,async(url,opts)=>{
    calls.push(opts.method+" status "+(url.endsWith("/receipt")?"receipt":"CAS"));
    if(opts.method==="POST"){
      assert.deepEqual(JSON.parse(opts.body),originalStatus);
      return json({status:"committed"});
    }
    assert.equal(opts.method,"GET");
    return json(statusPreview);
  });
  assert.equal(undo.kind,"ready");
  assert.equal(undo.command.status,"open");
  assert.notEqual(undo.command.commandId,originalStatus.commandId);
};
const whenUndo=async(calls)=>{
  const undo=await prepareConfirmedWhenUndo(originalWhen,async(url,opts)=>{
    calls.push(opts.method+" when "+(url.endsWith("/receipt")?"receipt":"CAS"));
    if(opts.method==="POST"){
      assert.deepEqual(JSON.parse(opts.body),originalWhen.command);
      return json({status:"committed"});
    }
    assert.equal(opts.method,"GET");
    return json(whenPreview);
  });
  assert.equal(undo.kind,"ready");
  assert.equal(undo.command.whenOn,originalWhen.previousWhenOn);
  assert.notEqual(undo.command.commandId,originalWhen.command.commandId);
};

test("P1 same-family: failed status B GET cannot erase committed status A Undo",async()=>{
  for(const code of [503,409,"offline"]){
    const calls=[];
    const response=await prepareMyPlanStatus({
      taskId:"other-B",areaId:area,status:"completed",
    },async(_url,opts)=>{
      calls.push(opts.method+" status B");
      assert.equal(opts.method,"GET");
      if(code==="offline")throw Error("network down");
      return json({error:"unavailable"},code);
    });
    assert.equal(response.ok,false);
    assert.equal(keepConfirmedMyPlanUndoOnRefresh(statusAction,originalStatus),true);
    await reauthorize(calls);
    await statusUndo(calls);
    assert.deepEqual(calls,[
      "GET status B","GET list","POST status receipt","GET status CAS",
    ],"failed status B preflight must not send a PATCH or lose A's Undo");
  }
});

test("P1 same-family: failed When B GET cannot erase committed When A Undo",async()=>{
  for(const code of [503,409,"offline"]){
    const calls=[];
    const response=await prepareMyPlanWhen({
      taskId:"other-B",areaId:area,whenOn:"2026-11-06",
    },async(_url,opts)=>{
      calls.push(opts.method+" when B");
      assert.equal(opts.method,"GET");
      if(code==="offline")throw Error("network down");
      return json({error:"unavailable"},code);
    });
    assert.equal(response.ok,false);
    assert.equal(keepConfirmedWhenOnRefresh(whenAction,originalWhen),true);
    await reauthorize(calls);
    await whenUndo(calls);
    assert.deepEqual(calls,[
      "GET when B","GET list","POST when receipt","GET when CAS",
    ],"failed When B preflight must not send a PATCH or lose A's Undo");
  }
});

test("P1 same-family: definite status/When B PATCH 400/409 keeps earlier A Undo",async()=>{
  for(const code of [400,409]){
    for(const family of ["status","when"]){
      const calls=[];
      const prepared=family==="status"
        ?await prepareMyPlanStatus({
          taskId:"other-B",areaId:area,status:"completed",
        },async(_url,opts)=>{
          calls.push("GET "+family+" B");
          return json(statusPreview);
        })
        :await prepareMyPlanWhen({
          taskId:"other-B",areaId:area,whenOn:"2026-11-06",
        },async(_url,opts)=>{
          calls.push("GET "+family+" B");
          return json(whenBPreview);
        });
      assert.equal(prepared.ok,true,family+" prepared");
      const result=family==="status"
        ?await dispatchMyPlanStatus(prepared.command,async(_url,opts)=>{
          calls.push(opts.method+" "+family+" B");
          return json({error:"rejected"},code);
        })
        :await dispatchMyPlanWhen(prepared.command,async(_url,opts)=>{
          calls.push(opts.method+" "+family+" B");
          return json({error:"rejected"},code);
        });
      assert.equal(result.kind,"rejected");
      assert.deepEqual(calls,["GET "+family+" B","PATCH "+family+" B"],
        "definitive refusal must not trigger a receipt retry or second PATCH");
      if(family==="status"){
        assert.equal(keepConfirmedMyPlanUndoOnRefresh(statusAction,originalStatus),true);
        await reauthorize(calls);
        await statusUndo(calls);
      }else{
        assert.equal(keepConfirmedWhenOnRefresh(whenAction,originalWhen),true);
        await reauthorize(calls);
        await whenUndo(calls);
      }
      assert.equal(calls.filter(x=>x.startsWith("PATCH")).length,1);
    }
  }
});

test("P1 same-family: React preserves previous committed UI on definite failure and clears on new commit",()=>{
  const code=source();
  const status=code.slice(code.indexOf("async function changeStatus("),
    code.indexOf("async function changeWhen("));
  const when=code.slice(code.indexOf("async function changeWhen("),
    code.indexOf("async function verifyUncertainWhenReceipt("));
  assert.match(status,/const retainedStatusUndo=prior\?\?/);
  assert.match(status,/keepConfirmedMyPlanUndoOnRefresh\(action,confirmedCommand\.current\)/);
  assert.match(status,/const restoreStatusUndoOnFailure=/);
  assert.match(status,/setAction\(\{kind:"committed",taskId:retainedStatusUndo\.taskId/);
  assert.match(status,/restoreStatusUndoOnFailure\(prepared\.reason\)/);
  assert.match(status,/restoreStatusUndoOnFailure\(result\.reason\)/);
  assert.doesNotMatch(status.slice(0,status.indexOf("let command:MyPlanStatusCommand;")),
    /confirmedCommand\.current=null/,
    "status B read-only phase must preserve status A receipt");
  assert.match(status,/confirmedCommand\.current=status==="completed"\?result\.command:null/);
  assert.match(status,/result\.kind==="uncertain"[\s\S]*?confirmedCommand\.current=null/);

  assert.match(when,/const retainedWhenUndo=prior\?\?/);
  assert.match(when,/keepConfirmedWhenOnRefresh\(whenAction,confirmedWhen\.current\)/);
  assert.match(when,/const restoreWhenUndoOnFailure=/);
  assert.match(when,/setWhenAction\(\{kind:"committed",taskId:retainedWhenUndo\.command\.taskId/);
  assert.match(when,/restoreWhenUndoOnFailure\(prepared\.reason\)/);
  assert.match(when,/restoreWhenUndoOnFailure\(result\.reason\)/);
  assert.doesNotMatch(when.slice(0,when.indexOf("let command:MyPlanWhenCommand;")),
    /confirmedWhen\.current=null/,
    "When B read-only phase must preserve When A receipt");
  assert.match(when,/confirmedWhen\.current=undo\?null:\{command,previousWhenOn\}/);
  assert.match(when,/result\.kind==="uncertain"[\s\S]*?confirmedWhen\.current=null/);

  for(const method of [status,when]){
    assert.match(method,/setAction\(\{kind:"pending"\}\)|setWhenAction\(\{kind:"pending"\}\)/);
    assert.match(method,/invalidate\("stale",true\)/);
    assert.match(method,/invalidate\("signed-out"\)/);
  }
  assert.match(code,/!anyPending&&whenAction\.kind==="committed"/);
  assert.match(code,/!anyPending&&action\.kind==="committed"/);
  assert.match(code,/keepConfirmedMyPlanUndoOnRefresh\(action,confirmedCommand\.current\)/);
  assert.match(code,/keepConfirmedWhenOnRefresh\(whenAction,confirmedWhen\.current\)/);
});
