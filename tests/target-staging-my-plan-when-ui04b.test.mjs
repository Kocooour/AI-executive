import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  MY_PLAN_WHEN_UI_WRITE_FLAGS,myPlanStagingWhenUiEnabled,
} from "../lib/target-staging-my-plan-when-ui-gate.ts";
import {
  validConfirmedWhen,keepConfirmedWhenOnRefresh,prepareConfirmedWhenUndo,
} from "../lib/target-staging-my-plan-when-undo.ts";
import {dispatchMyPlanWhen} from "../lib/target-staging-my-plan-when-client.ts";
import {fetchMyPlanSlice} from "../lib/target-staging-my-plan-client.ts";

const root=path.join(import.meta.dirname,"..");
const source=p=>readFileSync(path.join(root,p),"utf8");
const command={
  commandId:"123e4567-e89b-42d3-a456-426614174000",
  taskId:"task-1",whenOn:"2026-11-07",
  expectedRevision:"a".repeat(64),expectedPrivateEpoch:3,
  expectedPlanRevision:null,writeAreaId:"private-area",
  restoreGeneration:"765e4567-e89b-42d3-a456-426614174000",
};
const previousWhenOn="2026-11-06";
const confirmed={command,previousWhenOn};
const snapshot={
  expectedRevision:"b".repeat(64),expectedPrivateEpoch:4,
  expectedPlanRevision:0,whenOn:command.whenOn,
  writeAreaId:command.writeAreaId,
  restoreGeneration:command.restoreGeneration,
};
const good=(body,status=200)=>Response.json(body,{
  status,headers:{"cache-control":"no-store"},
});
const page={
  evaluationDate:"2026-11-06",areaFilter:"all",
  today:{tasks:[],hasMore:false},tomorrow:{tasks:[],hasMore:false},
  hasMore:false,nextCursor:null,
};

test("UI-04b: independent server-only default-off five-flag gate",()=>{
  const flags=Object.fromEntries(MY_PLAN_WHEN_UI_WRITE_FLAGS.map(x=>[x,"true"]));
  assert.equal(MY_PLAN_WHEN_UI_WRITE_FLAGS.length,5);
  assert.equal(myPlanStagingWhenUiEnabled({}),false);
  assert.equal(myPlanStagingWhenUiEnabled(flags),true);
  assert.ok(MY_PLAN_WHEN_UI_WRITE_FLAGS.includes(
    "AI_EXECUTIVE_TARGET_STAGING_MY_PLAN_WHEN_UI_ENABLED"));
  assert.ok(MY_PLAN_WHEN_UI_WRITE_FLAGS.includes(
    "AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED"));
  for(const flag of MY_PLAN_WHEN_UI_WRITE_FLAGS){
    for(const val of [undefined,"false","1","TRUE","true ",""]){
      assert.equal(myPlanStagingWhenUiEnabled({...flags,[flag]:val}),false,
        flag+"="+String(val));
    }
  }
  const pageSource=source("app/target-staging/my-plan/preview/page.tsx");
  assert.match(pageSource,/myPlanStagingWhenUiEnabled\(process\.env\)/);
  assert.match(pageSource,/whenWriteEnabled=\{whenWriteEnabled\}/);
  assert.match(pageSource,/notFound\(\)/);
  assert.doesNotMatch(pageSource,/NEXT_PUBLIC_/);
  assert.doesNotMatch(source("lib/target-staging-my-plan-when-ui-gate.ts"),
    /NEXT_PUBLIC_/);
});

test("UI-04b: human-readable 44px actions are gated per task/Area",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const css=source("app/target-staging/my-plan/preview/preview.css");
  assert.match(ui,/whenWriteEnabled=false/);
  assert.match(ui,/\{canWhen&&<div className="stagingMyPlanWhenControls"/);
  assert.match(ui,/myPlanWhenTarget\(date,choice\)/);
  assert.match(ui,/task\.whenOn!==target/);
  assert.match(ui,/onClick=\{\(\)=>onWhen\(task,target\)\}/);
  assert.match(ui,/Naplánovat osobně na dnešek:/);
  assert.match(ui,/Naplánovat osobně na zítřek:/);
  assert.match(ui,/canWhen=\{canWhen\}/);
  assert.match(css,/stagingMyPlanWhenControls button\s*\{[\s\S]*?min-height:44px/);
});

test("UI-04b: synchronous cross-family lock and no stale visible rows during uncertain write",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(ui,/if\(!whenWriteEnabled\|\|statusOperation\.current\|\|whenOperation\.current\|\|/);
  assert.match(ui,/whenOperation\.current=op; \/\/ Synchronous cross-family submission lock/);
  assert.match(ui,/if\(!statusWriteEnabled\|\|statusOperation\.current\|\|whenOperation\.current\|\|/);
  assert.match(ui,/whenAction\.kind==="uncertain"\|\|/);
  assert.match(ui,/const anyPending=actionPending\|\|whenPending/);
  assert.match(ui,/const canWhen=whenWriteEnabled&&!anyPending&&/);
  assert.match(ui,/followToday&&date!==null&&date===localMyPlanDate\(\)/);
  assert.match(ui,/const canComplete=statusWriteEnabled&&!anyPending/);
  assert.match(ui,/\{!anyPending&&<>/);
  assert.match(ui,/disabled=\{anyPending\}/);
  assert.match(ui,/if\(statusOperation\.current\|\|whenOperation\.current\|\|anyPending\|\|/);
  const start=ui.indexOf("async function changeWhen(");
  const end=ui.indexOf("async function verifyUncertainWhenReceipt()",start);
  assert.ok(start>0&&end>start);
  const method=ui.slice(start,end);
  assert.match(method,/invalidate\("stale",true\); \/\/ Hide potentially stale rows/);
  assert.match(method,/op\.command=command/);
  assert.match(method,/uncertainWhen\.current=context; \/\/ In-memory only/);
  assert.match(method,/const result=await dispatchMyPlanWhen\(command,fetch,op\.controller\.signal\)/);
  assert.match(method,/result\.kind==="uncertain"/);
  assert.match(method,/refreshAfterStatus\(\)/);
  assert.doesNotMatch(method,/localStorage|indexedDB|sessionStorage|serviceWorker/);
});

test("UI-04b: uncertain receipt never dispatches another PATCH; list-error recovery is GET only",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const start=ui.indexOf("async function verifyUncertainWhenReceipt()");
  const end=ui.indexOf("function retryUncertainWhenRead()",start);
  const receipt=ui.slice(start,end);
  assert.match(receipt,/checkMyPlanWhenReceipt\(/);
  assert.match(receipt,/receipt\.kind==="committed"/);
  assert.match(receipt,/receipt\.reason==="signed-out"/);
  assert.match(receipt,/setWhenAction\(\{kind:"uncertain"\}\)/);
  assert.doesNotMatch(receipt,/dispatchMyPlanWhen|prepareMyPlanWhen|method:"PATCH"/);
  const retry=ui.slice(end,ui.indexOf("async function verifyUncertainReceipt()",end));
  assert.match(retry,/function retryUncertainWhenRead\(\)/);
  assert.match(retry,/state\.status!=="error"/);
  assert.match(retry,/invalidate\("stale",true\)/);
  assert.match(retry,/setRefresh\(n=>n\+1\)/);
  assert.doesNotMatch(retry,/dispatchMyPlanWhen|prepareMyPlanWhen\(/);
  assert.match(ui,/Znovu ověřit osobní přehled \(bez zápisu\)/);
  assert.match(ui,/Ověřit původní osobní potvrzení/);
  assert.match(ui,/uncertainWhen\.current!==null&&/);
});

test("UI-04b: hide/offline, signed-out and manual context switch remove prior-actor Undo",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(ui,/privacyEpoch\.current\+\+;\s*confirmedWhen\.current=null/);
  assert.match(ui,/whenOperation\.current\?\.controller\.abort\(\)/);
  assert.match(ui,/const hide=\(\)=>\{\s*privacyChange\(\)/);
  assert.match(ui,/const offline=\(\)=>\{\s*privacyChange\(\)/);
  assert.match(ui,/if\(op\.privacyEpoch!==privacyEpoch\.current\)\{/);
  assert.match(ui,/if\(result\.reason==="signed-out"\)\{[\s\S]*?confirmedWhen\.current=null/);
  assert.match(ui,/function resetFeedback\(\)\{[\s\S]*?uncertainWhen\.current=null;[\s\S]*?confirmedWhen\.current=null/);
  assert.match(ui,/function refreshPlan\(\)\{[\s\S]*?keepConfirmedWhenOnRefresh/);
  assert.match(ui,/Znovu načíst osobní plán \(Undo zůstane\)/);
});

test("UI-04b: original actor-bound receipt then a fresh private CAS reverses the intended value",async()=>{
  const calls=[];
  const mock=async(url,opts)=>{
    calls.push({method:opts.method,url,body:opts.body?JSON.parse(opts.body):undefined});
    if(opts.method==="POST"){
      assert.deepEqual(JSON.parse(opts.body),command);
      assert.equal(url,
        "/api/target-staging/task-temporal/personal-when/command/receipt");
      return good({status:"committed"});
    }
    assert.equal(opts.method,"GET");
    assert.equal(opts.credentials,"same-origin");
    return good(snapshot);
  };
  const prepared=await prepareConfirmedWhenUndo(confirmed,mock);
  assert.equal(prepared.kind,"ready");
  assert.equal(prepared.command.whenOn,previousWhenOn);
  assert.equal(prepared.command.expectedPrivateEpoch,4);
  assert.equal(prepared.command.expectedPlanRevision,0);
  assert.notEqual(prepared.command.commandId,command.commandId);
  assert.deepEqual(calls.map(x=>x.method),["POST","GET"]);
  const result=await dispatchMyPlanWhen(prepared.command,async(url,opts)=>{
    assert.equal(url,"/api/target-staging/task-temporal/personal-when/command");
    calls.push({method:opts.method,url});
    assert.equal(opts.method,"PATCH");
    return good({ok:true});
  });
  assert.equal(result.kind,"committed");
  assert.deepEqual(calls.map(x=>x.method),["POST","GET","PATCH"]);
});

test("UI-04b: receipt 503 and private CAS 503 retain confirmed Undo without PATCH",async()=>{
  let calls=[];
  const receiptDown=await prepareConfirmedWhenUndo(confirmed,async(url,opts)=>{
    calls.push(opts.method);
    return good({error:"down"},503);
  });
  assert.deepEqual(receiptDown,{kind:"retry",reason:"unavailable"});
  assert.deepEqual(calls,["POST"]);
  calls=[];
  const casDown=await prepareConfirmedWhenUndo(confirmed,async(url,opts)=>{
    calls.push(opts.method);
    return opts.method==="POST"?good({status:"committed"}):
      good({error:"down"},503);
  });
  assert.deepEqual(casDown,{kind:"retry",reason:"unavailable"});
  assert.deepEqual(calls,["POST","GET"]);
  calls=[];
  const denied=await prepareConfirmedWhenUndo(confirmed,async(url,opts)=>{
    calls.push(opts.method);
    return good({error:"revoked"},401);
  });
  assert.deepEqual(denied,{kind:"signed-out"});
  assert.deepEqual(calls,["POST"]);
});

test("UI-04b: concurrent private plan edits cannot be clobbered by stale Undo",async()=>{
  for(const actual of ["2026-11-09",null]){
    const calls=[];
    const r=await prepareConfirmedWhenUndo(confirmed,async(url,opts)=>{
      calls.push(opts.method);
      return opts.method==="POST"?good({status:"committed"}):
        good({...snapshot,whenOn:actual});
    });
    assert.deepEqual(r,{kind:"retry",reason:"stale"});
    assert.deepEqual(calls,["POST","GET"]);
  }
  assert.equal(validConfirmedWhen(confirmed),true);
  assert.equal(validConfirmedWhen({...confirmed,previousWhenOn:"2026-02-29"}),false);
  const action={kind:"committed",taskId:command.taskId,
    areaId:command.writeAreaId,whenOn:command.whenOn};
  assert.equal(keepConfirmedWhenOnRefresh(action,confirmed),true);
  assert.equal(keepConfirmedWhenOnRefresh({...action,taskId:"other"},confirmed),false);
  assert.equal(keepConfirmedWhenOnRefresh({...action,areaId:"other"},confirmed),false);
  assert.equal(keepConfirmedWhenOnRefresh({...action,kind:"uncertain"},confirmed),false);
  assert.equal(keepConfirmedWhenOnRefresh(action,null),false);
});

test("UI-04b: confirmed personal day survives failed list read and manual GET-only retry",async()=>{
  const action={kind:"committed",taskId:command.taskId,
    areaId:command.writeAreaId,whenOn:command.whenOn};
  const calls=[];
  const fetchRead=async(fail)=>fetchMyPlanSlice({
    evaluationDate:"2026-11-06",areaFilter:"all",
  },async(url,opts)=>{
    calls.push(opts.method);
    assert.equal(opts.method,"GET");
    assert.equal(opts.cache,"no-store");
    return fail?good({error:"unavailable"},503):good(page);
  });
  assert.deepEqual(await fetchRead(true),{ok:false,reason:"unavailable"});
  assert.equal(keepConfirmedWhenOnRefresh(action,confirmed),true);
  assert.equal((await fetchRead(false)).ok,true);
  assert.deepEqual(calls,["GET","GET"]);
  const undo=await prepareConfirmedWhenUndo(confirmed,async(url,opts)=>
    opts.method==="POST"?good({status:"committed"}):good(snapshot));
  assert.equal(undo.kind,"ready");
});

test("UI-04b: production UI untouched and personal when remains actor-only",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const prod=source("app/ui/lumi-app-root.tsx");
  assert.doesNotMatch(prod,/target-staging-my-plan-when-client|whenWriteEnabled/);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|indexedDB|serviceWorker/);
  assert.doesNotMatch(ui,/method:\s*["'](?:PATCH|PUT|DELETE)/);
  assert.match(ui,/whenWriteEnabled&&whenAction\.kind==="uncertain"/);
  assert.match(ui,/whenAction\.undoable&&/);
});
