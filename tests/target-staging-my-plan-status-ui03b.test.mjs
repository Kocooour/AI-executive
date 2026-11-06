import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  MY_PLAN_STATUS_UI_WRITE_FLAGS,myPlanStagingWriteUiEnabled,
} from "../lib/target-staging-my-plan-ui-write-gate.ts";

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
  const prod=source("app/page.tsx");
  assert.doesNotMatch(prod,/TargetStagingMyPlanPreview|target-staging-my-plan-status-client/);
});

test("task completion uses square control with screen reader label and large touch target",()=>{
  const ui=source("app/ui/target-staging-my-plan-preview.tsx");
  const css=source("app/target-staging/my-plan/preview/preview.css");
  assert.match(ui,/statusWriteEnabled=false/);
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
  assert.match(method,/op\.command=prepared\.command/);
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
  assert.match(ui,/disabled=\{actionPending\}/);
  assert.match(ui,/\{!actionPending&&<>[\s\S]*?<PlanDay/);
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
  assert.match(ui,/action\.kind==="committed"&&action\.status==="completed"/);
  assert.match(ui,/action\.taskId===task\.taskId&&action\.areaId===task\.areaId/);
  assert.match(ui,/Vrátit dokončení \(Undo\)/);
  assert.match(ui,/areaId:action\.areaId,[\s\S]*?\},"open"\)/);
  assert.doesNotMatch(ui,/checkMyPlanStatusReceipt\(.*"open"/);
});
