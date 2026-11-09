import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  MY_PLAN_STATUS_UI_WRITE_FLAGS,myPlanStagingWriteUiEnabled,
} from "../lib/target-staging-my-plan-ui-write-gate.ts";
import {canRetryUncertainMyPlanRead} from "../lib/target-staging-my-plan-status-recovery.ts";
import {fetchMyPlanSlice} from "../lib/target-staging-my-plan-client.ts";
import {checkMyPlanStatusReceipt} from "../lib/target-staging-my-plan-status-client.ts";

const root=path.join(import.meta.dirname,"..");
const source=filename=>readFileSync(path.join(root,filename),"utf8");

test("status UI is independently default-off and needs all five exact server flags",()=>{
  const enabled=Object.fromEntries(MY_PLAN_STATUS_UI_WRITE_FLAGS.map(name=>[name,"true"]));
  assert.equal(MY_PLAN_STATUS_UI_WRITE_FLAGS.length,5);
  assert.equal(myPlanStagingWriteUiEnabled({}),false);
  assert.equal(myPlanStagingWriteUiEnabled(enabled),true);
  assert.ok(MY_PLAN_STATUS_UI_WRITE_FLAGS.includes(
    "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_STATUS_UI_ENABLED"));
  for(const name of MY_PLAN_STATUS_UI_WRITE_FLAGS){
    for(const disabled of [undefined,"false","TRUE","1","true ",""]){
      const env={...enabled,[name]:disabled};
      assert.equal(myPlanStagingWriteUiEnabled(env),false,name+"="+disabled);
    }
  }
  assert.equal(myPlanStagingWriteUiEnabled({
    ...enabled,NEXT_PUBLIC_LUMI_DESIGN_V1_PREVIEW:"false",
  }),true,"public design flag must not grant write access");
});

test("Next server route gates all read access and only passes gated write UI prop",()=>{
  const page=source("app/target-staging/my-plan/preview/page.tsx");
  const gate=source("lib/target-staging-my-plan-ui-write-gate.ts");
  for(const name of [
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_DAY_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_MY_PLAN_SLICE_ENABLED",
    "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_CLIENT_PREVIEW_ENABLED",
  ])assert.ok(page.includes(name),name);
  assert.match(page,/notFound\(\)/);
  assert.match(page,/myPlanStagingWriteUiEnabled\(process\.env\)/);
  assert.match(page,/statusWriteEnabled=\{statusWriteEnabled\}/);
  assert.doesNotMatch(gate,/NEXT_PUBLIC_/);
  assert.doesNotMatch(page,/NEXT_PUBLIC_/);
  const prod=source("app/ui/lumi-app-root.tsx");
  assert.doesNotMatch(prod,/TargetStagingMyPlanPreview|target-staging-my-plan-status-client/);
});

test("task completion uses square control with screen reader label and large touch target",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const css=source("app/target-staging/my-plan/preview/preview.css");
  assert.match(ui,/statusWriteEnabled=false/);
  assert.match(ui,/statusWriteEnabled\s*\?\s*"Izolovaný stagingový náhled s dokončením/);
  assert.match(ui,/\{canComplete[\s\S]*?<button type="button" className="stagingMyPlanSquare stagingMyPlanComplete"/);
  assert.match(ui,/aria-label=\{"Dokončit úkol: "\+task\.title\}/);
  assert.match(ui,/canComplete=\{canComplete\}/);
  assert.match(css,/button\.stagingMyPlanComplete\s*\{[\s\S]*?width:44px;height:44px;min-height:44px/);
  assert.match(css,/button\.stagingMyPlanComplete::before\s*\{[\s\S]*?width:20px;height:20px/);
});

test("exact CAS is prepared before dispatch; a synchronous mutex blocks double submit",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(ui,/if\(!statusWriteEnabled\|\|statusOperation\.current\|\|/);
  assert.match(ui,/statusOperation\.current=op; \/\/ Synchronous mutex/);
  const start=ui.indexOf("async function changeStatus(");
  const end=ui.indexOf("async function verifyUncertainReceipt()",start);
  assert.ok(start>0&&end>start);
  const method=ui.slice(start,end);
  assert.ok(method.indexOf("prepareMyPlanStatus(")<method.indexOf("dispatchMyPlanStatus("));
  assert.match(method,/invalidate\("stale",true\); \/\/ No stale open row/);
  assert.match(method,/op\.command=command/);
  assert.match(method,/result\.kind==="committed"/);
  assert.match(method,/result\.kind==="uncertain"/);
  assert.match(method,/result\.reason==="signed-out"/);
  assert.match(method,/refreshAfterStatus\(\)/);
  assert.doesNotMatch(method,/setState\(\{status:"ready"/);
});

test("manual receipt verification never resends a PATCH and blocks new status controls",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const start=ui.indexOf("async function verifyUncertainReceipt()");
  const end=ui.indexOf("function resetFeedback()",start);
  assert.ok(start>0&&end>start);
  const method=ui.slice(start,end);
  assert.match(method,/checkMyPlanStatusReceipt\(command,fetch,op\.controller\.signal\)/);
  assert.doesNotMatch(method,/dispatchMyPlanStatus|changeMyPlanStatus|fetch\(/);
  assert.match(method,/receipt\.kind==="committed"/);
  assert.match(method,/receipt\.reason==="signed-out"/);
  assert.match(method,/setAction\(\{kind:"uncertain"\}\)/);
  assert.match(ui,/const actionPending=action\.kind==="pending"\|\|action\.kind==="checking"\|\|\s*action\.kind==="uncertain"/);
  assert.match(ui,/disabled=\{anyPending\}/);
  assert.match(ui,/\{!anyPending&&<>[\s\S]*?<PlanDay/);
  assert.match(ui,/Ověřit původní potvrzení/);
  assert.doesNotMatch(ui,/localStorage|indexedDB|sessionStorage|serviceWorker/);
});

test("hide/offline abort active requests, discard confirmed Undo and reauthorize on wake",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(ui,/function privacyChange\(\)\{\s*privacyEpoch\.current\+\+;/);
  assert.match(ui,/statusOperation\.current\?\.controller\.abort\(\)/);
  assert.match(ui,/old\.kind==="committed"\|\|old\.kind==="error"/);
  assert.match(ui,/old\.kind==="checking"\?\{kind:"uncertain"\}/);
  assert.match(ui,/const hide=\(\)=>\{\s*privacyChange\(\);/);
  assert.match(ui,/const offline=\(\)=>\{\s*privacyChange\(\);/);
  assert.match(ui,/if\(op\.privacyEpoch!==privacyEpoch\.current\)\{/);
  assert.match(ui,/if\(op\.command\)\{\s*uncertainCommand\.current=op\.command/);
  assert.match(ui,/const chosen=resumeMyPlanDate\(date,followToday,new Date\(\)\)/);
  assert.match(ui,/if\(result\.reason==="signed-out"\)\{\s*uncertainCommand\.current=null;/);
  assert.match(ui,/const pageshow=\(event:PageTransitionEvent\)=>wake\(event\.persisted\)/);
});

test("Undo is a fresh authorized open command, not an old PATCH replay",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(ui,/statusWriteEnabled&&!anyPending&&action\.kind==="committed"/);
  assert.match(ui,/action\.status==="completed"&&/);
  assert.match(ui,/action\.taskId===task\.taskId&&action\.areaId===task\.areaId/);
  assert.match(ui,/Vrátit dokončení \(Undo\)/);
  assert.match(ui,/areaId:action\.areaId,[\s\S]*?\},"open"\)/);
  assert.doesNotMatch(ui,/checkMyPlanStatusReceipt\(.*"open"/);
});

test("P1: uncertain PATCH + failed list GET can reauthorize, then reconcile original receipt",async()=>{
  const original={
    commandId:"123e4567-e89b-42d3-a456-426614174000",
    taskId:"task-3",status:"completed",expectedRevision:"a".repeat(64),
    writeAreaId:"area-1",restoreGeneration:"765e4567-e89b-42d3-a456-426614174000",
  };
  const params={evaluationDate:"2026-11-06",areaFilter:"all"};
  const emptyPage={
    ...params,today:{tasks:[],hasMore:false},
    tomorrow:{tasks:[],hasMore:false},hasMore:false,nextCursor:null,
  };
  const readCalls=[];
  const read=async(success)=>{
    return fetchMyPlanSlice(params,async(url,opts)=>{
      readCalls.push({url,method:opts.method,credentials:opts.credentials,cache:opts.cache});
      assert.equal(opts.method,"GET");
      assert.equal(opts.credentials,"same-origin");
      assert.equal(opts.cache,"no-store");
      return Response.json(success?emptyPage:{error:"staging unavailable"},{
        status:success?200:503,headers:{"cache-control":"no-store"},
      });
    });
  };
  // An ambiguous completion has already attempted its SINGLE PATCH.
  let action="uncertain";
  let command=original;
  let readState="loading";
  let result=await read(false);
  assert.deepEqual(result,{ok:false,reason:"unavailable"});
  readState="error";
  assert.equal(canRetryUncertainMyPlanRead({
    statusWriteEnabled:true,actionKind:action,readStatus:readState,
    hasOriginalCommand:command===original,operationInFlight:false,
    visible:true,online:true,
  }),true,"failed reauthorization must not deadlock receipt recovery");

  // The UI's retry path changes ONLY the read generation: no new PATCH,
  // no resetFeedback and no mutation/UUID replacement.
  readState="loading";
  result=await read(true);
  assert.equal(result.ok,true);
  readState="ready";
  assert.equal(command,original,"original CAS/UUID must survive the error and retry");
  assert.equal(canRetryUncertainMyPlanRead({
    statusWriteEnabled:true,actionKind:action,readStatus:readState,
    hasOriginalCommand:true,operationInFlight:false,visible:true,online:true,
  }),false,"after reauthorization the distinct receipt-only action is available");

  const receiptCalls=[];
  const receipt=(status)=>checkMyPlanStatusReceipt(command,async(url,opts)=>{
    receiptCalls.push({url,method:opts.method,body:JSON.parse(opts.body)});
    assert.equal(opts.method,"POST");
    assert.match(url,/\/status\/receipt$/);
    assert.deepEqual(JSON.parse(opts.body),original);
    return Response.json({status},{headers:{"cache-control":"no-store"}});
  });
  assert.deepEqual(await receipt("not_recorded"),{kind:"not-recorded"});
  assert.equal(action,"uncertain","not_recorded must not clear an unresolved write");
  assert.deepEqual(await receipt("committed"),{kind:"committed"});
  assert.equal(receiptCalls.length,2);
  assert.deepEqual([...readCalls,...receiptCalls].map(x=>x.method),
    ["GET","GET","POST","POST"],"recovery must not replay PATCH");
});

test("P1: recovery policy refuses hidden, offline, signed-out, absent-command or busy reads",()=>{
  const valid={
    statusWriteEnabled:true,actionKind:"uncertain",readStatus:"error",
    hasOriginalCommand:true,operationInFlight:false,visible:true,online:true,
  };
  for(const patch of [
    {statusWriteEnabled:false},{actionKind:"idle"},
    {actionKind:"pending"},{actionKind:"checking"},
    {readStatus:"ready"},{readStatus:"loading"},
    {hasOriginalCommand:false},{operationInFlight:true},
    {visible:false},{online:false},
  ]){
    assert.equal(canRetryUncertainMyPlanRead({...valid,...patch}),false,
      JSON.stringify(patch));
  }
  assert.equal(canRetryUncertainMyPlanRead(valid),true);
});

test("P1: failed-read recovery is visible outside ready state and never changes the original command",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const start=ui.indexOf("function retryUncertainRead()");
  const end=ui.indexOf("\n  }\n",start)+"\n  }".length;
  assert.ok(start>0&&end>start);
  const retry=ui.slice(start,end);
  assert.match(retry,/canRetryUncertainMyPlanRead\(\{/);
  assert.match(retry,/hasOriginalCommand:uncertainCommand\.current!==null/);
  assert.match(retry,/invalidate\("stale",true\)/);
  assert.match(retry,/setRefresh\(n=>n\+1\)/);
  assert.doesNotMatch(retry,/dispatchMyPlanStatus|prepareMyPlanStatus|resetFeedback\(|uncertainCommand\.current\s*=/);
  const control=ui.indexOf("Znovu ověřit přehled (bez zápisu)");
  const ready=ui.indexOf('{state.status==="ready"&&date&&');
  assert.ok(control>0&&control<ready,"read recovery must appear even when list is in error");
  assert.match(ui,/state\.status==="error"&&state\.reason!=="signed-out"/);
  assert.match(ui,/uncertainCommand\.current!==null&&/);
  assert.match(ui,/onClick=\{retryUncertainRead\}/);
  assert.match(ui,/\{!anyPending&&<>/);
});

test("P1: Undo receipt/preflight failures preserve same actor's completion instead of losing it",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const start=ui.indexOf("async function changeStatus(");
  const end=ui.indexOf("async function verifyUncertainReceipt()",start);
  assert.ok(start>0&&end>start);
  const method=ui.slice(start,end);
  assert.match(method,/const retainedStatusUndo=prior\?\?/);
  assert.doesNotMatch(method,/if\(!prior\)confirmedCommand\.current=null/,
    "a new status preflight must not discard a prior confirmed completion");
  assert.match(method,/const restoreStatusUndoOnFailure=/);
  assert.match(method,/setUndoFailure\(reason\)/);
  assert.match(method,/setAction\(\{kind:"committed",taskId:retainedStatusUndo\.taskId/);
  assert.match(method,/const undo=await prepareConfirmedMyPlanUndo\(/);
  assert.match(method,/if\(undo\.kind!=="ready"\)\{/);
  assert.match(method,/restoreStatusUndoOnFailure\(undo\.reason\)/);
  assert.match(method,/restoreStatusUndoOnFailure\(prepared\.reason\)/);
  assert.match(method,/restoreStatusUndoOnFailure\(result\.reason\)/);
  assert.match(method,/command=undo\.command/);
  assert.match(method,/op\.command=command/);
  assert.match(method,/confirmedCommand\.current=status==="completed"\?result\.command:null/);
  assert.match(method,/confirmedCommand\.current=null;\s*uncertainCommand\.current=result\.command/);
  assert.match(method,/if\(undo\.kind==="signed-out"\)\{\s*confirmedCommand\.current=null/);
});

test("P1: manual Refresh retains confirmed Undo across list 503 but still reauthorizes",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const start=ui.indexOf("function refreshPlan()");
  const end=ui.indexOf("function resetFeedback()",start);
  assert.ok(start>0&&end>start);
  const refresh=ui.slice(start,end);
  assert.match(refresh,/keepConfirmedMyPlanUndoOnRefresh\(action,confirmedCommand\.current\)/);
  assert.match(refresh,/invalidate\("stale",true\)/);
  assert.match(refresh,/setRefresh\(n=>n\+1\)/);
  assert.doesNotMatch(refresh,/dispatchMyPlanStatus|prepareMyPlanStatus/);
  assert.match(ui,/onClick=\{refreshPlan\}>Obnovit/);
  assert.match(ui,/state\.status==="error"&&[\s\S]*?action\.kind==="committed"&&/);
  assert.match(ui,/Znovu načíst přehled \(Undo zůstane\)/);
  assert.match(ui,/undoFailure&&/);
  assert.match(ui,/setUndoFailure\(null\)/);
});
