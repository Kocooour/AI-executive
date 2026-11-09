import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {createTargetClientRuntime} from "../lib/target-client-runtime.ts";
import {createRefusalBudget,targetMyPlanGate} from "../lib/target-my-plan-embed.ts";

const root=path.resolve(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");
const GEN_A="A".repeat(43);
const GEN_B="B".repeat(43);

function fakeSession(generations){
  const calls=[];
  const fetchFake=async url=>{
    calls.push(String(url));
    const next=generations.shift();
    if(next==="401")return new Response("{}",{status:401});
    if(next==="404")return new Response("{}",{status:404});
    if(next==="500")return new Response("{}",{status:500});
    if(next==="net")throw new TypeError("network");
    return new Response(JSON.stringify({generation:next}),{
      status:200,headers:{"content-type":"application/json","cache-control":"no-store"},
    });
  };
  return {fetchFake,calls};
}
class Channel{
  static last=null;
  constructor(){Channel.last=this;this.l=[];}
  addEventListener(_t,fn){this.l.push(fn);}
  close(){}
  emit(data){for(const fn of this.l)fn({data});}
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
const make=generations=>{
  const session=fakeSession(generations);
  const runtime=createTargetClientRuntime({
    fetch:session.fetchFake,window:null,broadcastChannelFactory:()=>new Channel(),
  });
  return {runtime,...session};
};
const gate=(runtime,blocked=false)=>targetMyPlanGate(runtime,runtime.generation(),runtime.lastOutcome(),blocked);

test("gate: no runtime or no generation yet -> checking, never ready (no read)",async()=>{
  assert.deepEqual(targetMyPlanGate(null,""),{kind:"checking"});
  assert.deepEqual(targetMyPlanGate(null,GEN_A),{kind:"checking"});
  const {runtime}=make([GEN_A]);
  assert.deepEqual(gate(runtime),{kind:"checking"}); // before the first answer
  await settle();
  assert.deepEqual(gate(runtime),{kind:"ready",generation:GEN_A});
  runtime.dispose();
  assert.deepEqual(targetMyPlanGate(runtime,GEN_A),{kind:"signed_out"});
});

test("gate: 401 on the first verification -> signed out, never ready",async()=>{
  const {runtime}=make(["401"]);
  await settle();
  assert.equal(gate(runtime).kind,"signed_out");
  runtime.dispose();
});

test("generation change (reportRefusal then new login) re-keys the plan; old generation is never ready again",async()=>{
  const {runtime}=make([GEN_A,GEN_B]);
  await settle();
  const first=gate(runtime);
  assert.equal(first.generation,GEN_A);
  const refused=runtime.reportRefusal("session_revoked");
  // Immediately after the refusal the old generation is unusable.
  assert.equal(targetMyPlanGate(runtime,GEN_A).kind,"signed_out");
  assert.equal(gate(runtime).kind,"signed_out");
  await refused;
  const second=gate(runtime);
  assert.deepEqual(second,{kind:"ready",generation:GEN_B});
  assert.notEqual(second.generation,first.generation); // React key changes -> remount
  assert.equal(targetMyPlanGate(runtime,GEN_A).kind,"signed_out");
  runtime.dispose();
});

test("signed-out broadcast makes the gate signed_out at once",async()=>{
  const {runtime}=make([GEN_A,GEN_A]);
  await settle();
  assert.equal(gate(runtime).kind,"ready");
  Channel.last.emit("signed-out");
  assert.equal(gate(runtime).kind,"signed_out");
  runtime.dispose();
});

test("component source: key by generation, read only when ready, refusal reported",()=>{
  const source=read("app/ui/target-my-plan.tsx");
  assert.match(source,/targetMyPlanGate\(runtime,generation,outcome,blocked\)/);
  assert.match(source,/<TargetStagingMyPlanPreview key=\{gate\.generation\} embedded/);
  assert.match(source,/reportRefusal\("session_revoked"\)/);
  assert.match(source,/failure=\{gate\.kind==="signed_out"\?"signed-out":undefined\}/);
  // No reload loop: every status action re-verifies through the runtime.
  assert.doesNotMatch(source,/location\.reload/);
  assert.match(source,/export default function TargetMyPlan/);
  assert.match(source,/statusWriteEnabled=\{gates\.statusWrite\} whenWriteEnabled=\{gates\.whenWrite\}/);
  // The preview (the only reader) is created only on the ready branch.
  assert.equal((source.match(/<TargetStagingMyPlanPreview/g)??[]).length,1);
  assert.ok(source.indexOf('gate.kind==="checking"')<source.indexOf("<TargetStagingMyPlanPreview"));
  assert.ok(source.indexOf('gate.kind==="signed_out"')<source.indexOf("<TargetStagingMyPlanPreview"));
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|console\./);
});

test("preview source: refusal effect on signed-out read state; embedded drops page chrome",()=>{
  const source=read("app/ui/target-staging-my-plan-preview.tsx");
  assert.match(source,/state\.status==="error"&&state\.reason==="signed-out"\)refusalRef\.current\?\.\(\)/);
  assert.match(source,/embedded\?"section":"main"/);
  assert.match(source,/\{!embedded&&<header>/);
  // Own privacy-hide behaviour is retained.
  assert.match(source,/document\.visibilityState==="hidden"\|\|!navigator\.onLine/);
  assert.match(source,/addEventListener\("visibilitychange"/);
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB/);
});

test("flag off: the root loads the target screen lazily and only for target mode; page mounts nothing new",()=>{
  const rootSource=read("app/ui/lumi-app-root.tsx");
  assert.match(rootSource,/dynamic\(\(\) => import\("\.\/target-my-plan"\), \{ ssr: false \}\)/);
  assert.doesNotMatch(rootSource,/^import .*target-my-plan/m);
  assert.match(rootSource,/const targetPlan = Boolean\(targetMyPlan\?\.enabled\) && mobileDesignV1Preview && app\.mobilePlanPreviewActive && view === "Today"/);
  assert.match(rootSource,/targetPlan && targetMyPlan\s*\n\s*\? <TargetMyPlan gates=\{targetMyPlan\} \/>\s*\n\s*: <EntityList app=\{app\} \/>/);
  // Legacy pieces that would claim legacy data are suppressed in target mode.
  assert.match(rootSource,/!targetPlan && <TodayTop/);
  assert.match(rootSource,/!targetPlan && <TodayFooter/);
  assert.match(rootSource,/!targetPlan && <TodayHeaderMeta/);
  assert.match(rootSource,/data-plan-source="target-staging"/);
  assert.match(rootSource,/data-plan-source="legacy-today"/);
  const page=read("app/page.tsx");
  assert.match(page,/const config = targetUiEnabled\(\) \? targetUiConfig\(process\.env\) : null/);
  assert.match(page,/const targetData = config\?\.myPlan\.enabled === true/);
  assert.match(page,/: <LumiAppRoot \/>/); // flag off: no prop, no provider
  assert.doesNotMatch(page,/target-my-plan|fetch\(|target-staging\//);
});

test("no module outside the target screen fetches /api/target-staging for the main app root",()=>{
  for(const file of ["app/ui/lumi-app-root.tsx","app/page.tsx"])
    assert.doesNotMatch(read(file),/api\/target-staging|fetch\(/,file);
});

test("first verification fails (5xx / network) -> unavailable with retry, not endless checking",async()=>{
  for(const failure of ["500","net"]){
    const {runtime}=make([failure,GEN_A]);
    await settle();
    assert.equal(runtime.lastOutcome(),"unavailable",failure);
    assert.deepEqual(gate(runtime),{kind:"unavailable"},failure);
    assert.equal(await runtime.refresh(),"ok");
    assert.deepEqual(gate(runtime),{kind:"ready",generation:GEN_A});
    runtime.dispose();
  }
});

test("404 from the session route -> feature_off (distinct copy), never ready",async()=>{
  const {runtime}=make(["404"]);
  await settle();
  assert.equal(runtime.lastOutcome(),"feature_off");
  assert.deepEqual(gate(runtime),{kind:"feature_off"});
  runtime.dispose();
});

test("outcome subscribers are notified on change only and cleared on dispose",async()=>{
  const {runtime}=make([GEN_A,GEN_A,"500"]);
  let n=0;
  const off=runtime.subscribeOutcome(()=>n++);
  await settle();
  assert.equal(n,1); // null -> ok
  await runtime.refresh();
  assert.equal(n,1); // ok -> ok: no notification
  await runtime.refresh();
  assert.equal(n,2); // ok -> unavailable
  assert.deepEqual(gate(runtime),{kind:"ready",generation:GEN_A}); // a known generation stays usable
  off();
  runtime.dispose();
});

test("refusal budget stops a refusal -> re-verify -> remount loop",async()=>{
  // Server drift: every My Plan read refused, the session route keeps confirming.
  const {runtime,calls}=make(Array(20).fill(GEN_A));
  await settle();
  let clock=0;
  const budget=createRefusalBudget({limit:2,windowMs:60_000,now:()=>clock});
  let blocked=false,mounts=0;
  for(let i=0;i<10;i++){
    const g=gate(runtime,blocked);
    if(g.kind!=="ready")break;
    mounts++;
    // The mounted plan reads, gets 401, and reports a refusal.
    if(!budget.admit()){blocked=true;break;}
    await runtime.reportRefusal("session_revoked");
  }
  assert.equal(blocked,true);
  assert.equal(mounts,3);
  assert.deepEqual(gate(runtime,blocked),{kind:"refused"});
  assert.equal(calls.length,3); // initial + two admitted re-verifications
  // Outside the window (or after reset) a refusal is admitted again.
  clock+=60_000;
  assert.equal(budget.admit(),true);
  budget.reset();
  assert.equal(budget.admit(),true);
  assert.equal(budget.admit(),true);
  assert.equal(budget.admit(),false);
  runtime.dispose();
});

test("component source: refusal budget, outcome subscription and unblock on external generation change",()=>{
  const source=read("app/ui/target-my-plan.tsx");
  assert.match(source,/createRefusalBudget\(\)/);
  assert.match(source,/if\(!budget\.current\.admit\(\)\)\{setBlocked\(true\);return;\}/);
  assert.match(source,/subscribeOutcome/);
  assert.match(source,/lastOutcome\(\)/);
  assert.match(source,/target-my-plan-unavailable/);
  assert.match(source,/target-my-plan-feature-off/);
});

test("nav labels never claim legacy data in target mode",()=>{
  for(const file of ["app/ui/views/mobile-nav.tsx","app/ui/views/sidebar.tsx"]){
    const source=read(file);
    assert.match(source,/targetPlan = false/,file);
    assert.match(source,/serverový plán ze stagingu/,file);
    assert.match(source,/server plan from staging/,file);
  }
  const rootSource=read("app/ui/lumi-app-root.tsx");
  assert.match(rootSource,/<Sidebar app=\{app\} targetPlan=\{Boolean\(targetMyPlan\?\.enabled\)\} \/>/);
  assert.match(rootSource,/<MobileNav app=\{app\} targetPlan=\{Boolean\(targetMyPlan\?\.enabled\)\} \/>/);
});
