import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {supersedesCrossFamilyUndo} from "../lib/target-staging-my-plan-cross-family-undo.ts";
import {
  prepareMyPlanWhen,dispatchMyPlanWhen,
} from "../lib/target-staging-my-plan-when-client.ts";
import {
  prepareMyPlanStatus,dispatchMyPlanStatus,
} from "../lib/target-staging-my-plan-status-client.ts";
import {prepareConfirmedMyPlanUndo} from "../lib/target-staging-my-plan-undo.ts";
import {prepareConfirmedWhenUndo} from "../lib/target-staging-my-plan-when-undo.ts";
import {fetchMyPlanSlice} from "../lib/target-staging-my-plan-client.ts";

const root=path.join(import.meta.dirname,"..");
const ui=()=>readFileSync(path.join(root,
  "app/ui/target-staging-my-plan-preview.tsx"),"utf8");
const originalStatus={
  commandId:"123e4567-e89b-42d3-a456-426614174000",
  taskId:"completed-A",status:"completed",previousWhenOn:null,
  expectedRevision:"a".repeat(64),writeAreaId:"private-area",
  restoreGeneration:"765e4567-e89b-42d3-a456-426614174000",
};
const originalWhen={
  command:{
    commandId:"123e4567-e89b-42d3-a456-426614174001",
    taskId:"planned-A",whenOn:"2026-11-07",
    expectedRevision:"a".repeat(64),expectedPrivateEpoch:5,
    expectedPlanRevision:0,writeAreaId:"private-area",
    restoreGeneration:"765e4567-e89b-42d3-a456-426614174000",
  },
  previousWhenOn:"2026-11-06",
};
const statusPreview={
  expectedRevision:"b".repeat(64),writeAreaId:"private-area",
  restoreGeneration:"765e4567-e89b-42d3-a456-426614174000",
};
const whenPreview={
  expectedRevision:"b".repeat(64),expectedPrivateEpoch:6,
  expectedPlanRevision:1,whenOn:"2026-11-07",
  writeAreaId:"private-area",
  restoreGeneration:"765e4567-e89b-42d3-a456-426614174000",
};
const dayPage={
  evaluationDate:"2026-11-06",areaFilter:"all",
  today:{tasks:[],hasMore:false},tomorrow:{tasks:[],hasMore:false},
  undated:{tasks:[],hasMore:false},
  hasMore:false,nextCursor:null,
};
const json=(body,status=200)=>Response.json(body,{
  status,headers:{"cache-control":"no-store"},
});
const freshList=(calls)=>fetchMyPlanSlice({
  evaluationDate:"2026-11-06",areaFilter:"all",
},async(url,options)=>{
  assert.equal(options.method,"GET");
  calls.push("GET list");
  return json(dayPage);
});

test("P1: committed status A survives whenOn B preview 503; authorized re-read still allows Undo A",async()=>{
  const calls=[];
  const existing=originalStatus;
  const preview=await prepareMyPlanWhen({
    taskId:"task-B",areaId:"private-area",whenOn:"2026-11-07",
  },async(url,options)=>{
    calls.push(options.method+" when preview");
    assert.equal(options.method,"GET");
    return json({error:"unavailable"},503);
  });
  assert.deepEqual(preview,{ok:false,reason:"unavailable"});
  // No PATCH was issued; the original confirmed completion is not superseded.
  assert.equal(existing,originalStatus);
  assert.deepEqual(calls,["GET when preview"]);
  assert.equal((await freshList(calls)).ok,true);
  const undo=await prepareConfirmedMyPlanUndo(existing,async(url,options)=>{
    calls.push(options.method+" status "+(url.includes("/receipt")?"receipt":"CAS"));
    if(options.method==="POST"){
      assert.deepEqual(JSON.parse(options.body),existing);
      return json({status:"committed"});
    }
    assert.equal(options.method,"GET");
    return json(statusPreview);
  });
  assert.equal(undo.kind,"ready");
  assert.equal(undo.command.status,"open");
  assert.notEqual(undo.command.commandId,existing.commandId);
  assert.deepEqual(calls,[
    "GET when preview","GET list","POST status receipt","GET status CAS",
  ],"the failed cross-family preflight never dispatched PATCH");
});

test("P1: committed whenOn A survives status B preview 503; authorized re-read still allows Undo A",async()=>{
  const calls=[];
  const existing=originalWhen;
  const preview=await prepareMyPlanStatus({
    taskId:"task-B",areaId:"private-area",status:"completed",
  },async(url,options)=>{
    calls.push(options.method+" status preview");
    assert.equal(options.method,"GET");
    return json({error:"unavailable"},503);
  });
  assert.deepEqual(preview,{ok:false,reason:"unavailable"});
  assert.equal(existing,originalWhen);
  assert.deepEqual(calls,["GET status preview"]);
  assert.equal((await freshList(calls)).ok,true);
  const undo=await prepareConfirmedWhenUndo(existing,async(url,options)=>{
    calls.push(options.method+" when "+(url.includes("/receipt")?"receipt":"CAS"));
    if(options.method==="POST"){
      assert.deepEqual(JSON.parse(options.body),existing.command);
      return json({status:"committed"});
    }
    assert.equal(options.method,"GET");
    return json(whenPreview);
  });
  assert.equal(undo.kind,"ready");
  assert.equal(undo.command.whenOn,existing.previousWhenOn);
  assert.equal(undo.command.expectedPrivateEpoch,6);
  assert.notEqual(undo.command.commandId,existing.command.commandId);
  assert.deepEqual(calls,[
    "GET status preview","GET list","POST when receipt","GET when CAS",
  ],"the failed cross-family preflight never dispatched PATCH");
});

test("P1: only definite commit or ambiguous dispatch invalidates previous cross-family Undo",async()=>{
  for(const [name,dispatcher,command,url] of [
    ["when",dispatchMyPlanWhen,originalWhen.command,"when"],
    ["status",dispatchMyPlanStatus,originalStatus,"status"],
  ]){
    for(const [patchStatus,kind] of [[200,"committed"],[409,"rejected"],[400,"rejected"]]){
      const calls=[];
      const result=await dispatcher(command,async(_url,options)=>{
        calls.push(options.method);
        return patchStatus===200?json({ok:true}):json({error:"no"},patchStatus);
      });
      assert.equal(result.kind,kind,name+" "+patchStatus);
      assert.equal(supersedesCrossFamilyUndo(result.kind),kind==="committed",
        "definitive pre-commit 400/409 must preserve original Undo");
      assert.deepEqual(calls,["PATCH"]);
    }
    const calls=[];
    const ambiguous=await dispatcher(command,async(_url,options)=>{
      calls.push(options.method);
      if(options.method==="PATCH")throw Error("wire died after potential commit");
      return json({error:"unknown"},503);
    });
    assert.equal(ambiguous.kind,"uncertain",name);
    assert.equal(supersedesCrossFamilyUndo(ambiguous.kind),true);
    assert.deepEqual(calls,["PATCH","POST"],url+" should not replay PATCH");
  }
});

test("P1: React wiring preserves opposite Undo before PATCH and hides it during other in-flight action",()=>{
  const code=ui();
  const statusStart=code.indexOf("async function changeStatus(");
  const statusDispatch=code.indexOf("const result=await dispatchMyPlanStatus(",statusStart);
  const statusEnd=code.indexOf("async function changeWhen(",statusStart);
  const statusPreflight=code.slice(statusStart,
    code.indexOf("let command:MyPlanStatusCommand;",statusStart));
  assert.doesNotMatch(statusPreflight,/confirmedWhen\.current=null|setWhenAction\(\{kind:"idle"\}\)/);
  const statusPost=code.slice(statusDispatch,statusEnd);
  assert.match(statusPost,/if\(supersedesCrossFamilyUndo\(result\.kind\)\)\{[\s\S]*?confirmedWhen\.current=null/);
  assert.match(statusPost,/if\(result\.kind==="committed"\)/);
  assert.match(statusPost,/result\.kind==="uncertain"/);
  assert.match(code.slice(statusStart,statusEnd),/prepared\.reason==="signed-out"\)[\s\S]*?confirmedWhen\.current=null|confirmedWhen\.current=null[\s\S]*?prepared\.reason==="signed-out"/);

  const whenStart=code.indexOf("async function changeWhen(");
  const whenDispatch=code.indexOf("const result=await dispatchMyPlanWhen(",whenStart);
  const whenEnd=code.indexOf("async function verifyUncertainWhenReceipt(",whenStart);
  const whenPreflight=code.slice(whenStart,
    code.indexOf("let command:MyPlanWhenCommand;",whenStart));
  assert.doesNotMatch(whenPreflight,/confirmedCommand\.current=null|setAction\(\{kind:"idle"\}\)/);
  const whenPost=code.slice(whenDispatch,whenEnd);
  assert.match(whenPost,/if\(supersedesCrossFamilyUndo\(result\.kind\)\)\{[\s\S]*?confirmedCommand\.current=null/);
  assert.match(whenPost,/if\(result\.kind==="committed"\)/);
  assert.match(whenPost,/result\.kind==="uncertain"/);
  assert.match(code,/whenWriteEnabled&&!anyPending&&whenAction\.kind==="committed"/);
  assert.match(code,/statusWriteEnabled&&!anyPending&&action\.kind==="committed"/);
  assert.match(code,/if\(!statusWriteEnabled\|\|statusOperation\.current\|\|whenOperation\.current/);
  assert.match(code,/if\(!whenWriteEnabled\|\|statusOperation\.current\|\|whenOperation\.current/);
});

test("P1: signed-out preview and read-ACL revocation invalidate BOTH actor-bound confirmations",async()=>{
  const calls=[];
  const w=await prepareMyPlanWhen({
    taskId:"task-B",areaId:"private-area",whenOn:"2026-11-07",
  },async(_url,options)=>{calls.push(options.method);return json({error:"revoked"},401);});
  const s=await prepareMyPlanStatus({
    taskId:"task-B",areaId:"private-area",status:"completed",
  },async(_url,options)=>{calls.push(options.method);return json({error:"revoked"},403);});
  assert.deepEqual(w,{ok:false,reason:"signed-out"});
  assert.deepEqual(s,{ok:false,reason:"signed-out"});
  assert.deepEqual(calls,["GET","GET"],"no mutations on revoked actor");
  const code=ui();
  const a=code.slice(code.indexOf("async function changeStatus("),
    code.indexOf("async function changeWhen("));
  const b=code.slice(code.indexOf("async function changeWhen("),
    code.indexOf("async function verifyUncertainWhenReceipt("));
  for(const flow of [a,b]){
    assert.match(flow,/prepared\.reason==="signed-out"/);
    assert.match(flow,/confirmedWhen\.current=null/);
    assert.match(flow,/confirmedCommand\.current=null/);
    assert.match(flow,/invalidate\("signed-out"\)/);
  }
  assert.match(code,/if\(result\.reason==="signed-out"\)\{[\s\S]*?confirmedWhen\.current=null/);
  assert.match(code,/function privacyChange\(\)\{[\s\S]*?confirmedWhen\.current=null/);
});
