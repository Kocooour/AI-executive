import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  msUntilNextLocalMyPlanDay,resumeMyPlanDate,
  initialMyPlanWakeGate,invalidateMyPlanWakeGate,consumeMyPlanWake,
} from "../lib/target-staging-my-plan-lifecycle.ts";
import {localMyPlanDate} from "../lib/target-staging-my-plan-client.ts";

test("midnight deadline uses the NEXT local calendar date across month/year",()=>{
  for(const [y,m,d] of [[2026,10,5],[2026,11,31],[2028,1,28],[2028,1,29]]){
    const now=new Date(y,m,d,23,59,50,0);
    const due=new Date(y,m,d+1,0,0,0,0);
    assert.equal(msUntilNextLocalMyPlanDay(now),due.getTime()-now.getTime());
    assert.equal(msUntilNextLocalMyPlanDay(now),10_000);
    assert.equal(localMyPlanDate(new Date(due.getTime()+2_000)),
      localMyPlanDate(due));
  }
});

test("midnight calculation handles 23-hour spring and 25-hour autumn in Prague",()=>{
  const original=process.env.TZ;
  process.env.TZ="Europe/Prague";
  try{
    for(const [year,month,day,hours] of [[2026,2,29,23],[2026,9,25,25]]){
      const start=new Date(year,month,day,0,0,0);
      const tomorrow=new Date(year,month,day+1,0,0,0);
      assert.equal(msUntilNextLocalMyPlanDay(start),
        tomorrow.getTime()-start.getTime());
      assert.equal(msUntilNextLocalMyPlanDay(start),hours*3600_000);
    }
  }finally{
    if(original===undefined)delete process.env.TZ;
    else process.env.TZ=original;
  }
});

test("only follow-today date automatically advances after midnight",()=>{
  const previous="2026-12-31";
  const next=new Date(2027,0,1,0,0,10);
  assert.deepEqual(resumeMyPlanDate(previous,true,next),{
    evaluationDate:"2027-01-01",changed:true,
  });
  assert.deepEqual(resumeMyPlanDate(previous,false,next),{
    evaluationDate:previous,changed:false,
  });
  assert.deepEqual(resumeMyPlanDate("2027-01-01",true,next),{
    evaluationDate:"2027-01-01",changed:false,
  });
});

test("rapid hidden to visible transition always triggers reauthorization",()=>{
  let gate=initialMyPlanWakeGate();
  const initial=consumeMyPlanWake(gate,10_000);
  assert.equal(initial.reload,true);
  gate=initial.gate;
  const sameFocus=consumeMyPlanWake(gate,10_100);
  assert.equal(sameFocus.reload,false,"duplicate focus without a hide is coalesced");
  gate=invalidateMyPlanWakeGate(sameFocus.gate);
  assert.equal(gate.requiresReauthorization,true);
  const shown=consumeMyPlanWake(gate,10_120);
  assert.equal(shown.reload,true,"hide/show within 120ms must reauthorize");
  assert.equal(shown.gate.requiresReauthorization,false);
  const visibleFocus=consumeMyPlanWake(shown.gate,10_140);
  assert.equal(visibleFocus.reload,false,"visibility+focus pair reuses new read");
  gate=invalidateMyPlanWakeGate(visibleFocus.gate);
  const secondHide=consumeMyPlanWake(gate,10_145);
  assert.equal(secondHide.reload,true,"each new hidden cycle requires a read");
  assert.equal(consumeMyPlanWake(secondHide.gate,10_150,true).reload,true,
    "explicit online/midnight wake cannot be debounced");
  assert.equal(consumeMyPlanWake(secondHide.gate,9_999).reload,true,
    "clock moving backwards must revalidate");
});

test("pagehide/pageshow BFCache restore forces recheck with or without visibilitychange",()=>{
  const first=consumeMyPlanWake(initialMyPlanWakeGate(),10_000);
  assert.equal(first.reload,true);
  // No visibilitychange occurred. pagehide must still mark the old result invalid.
  const hidden=invalidateMyPlanWakeGate(first.gate);
  const restored=consumeMyPlanWake(hidden,10_100);
  assert.equal(restored.reload,true,"BFCache return under 350ms must refresh ACL");
  assert.equal(restored.gate.requiresReauthorization,false);
  // Some BFCache restores fire pageshow(persisted) even without pagehide callback.
  const persisted=consumeMyPlanWake(first.gate,10_100,true);
  assert.equal(persisted.reload,true,"persisted pageshow must force recheck");
  // Normal duplicate pageshow/focus without navigation remains coalesced.
  assert.equal(consumeMyPlanWake(restored.gate,10_140).reload,false);
});

test("lifecycle hooks abort and hide old actor data, revalidate after resume",()=>{
  const root=path.join(import.meta.dirname,"..");
  const ui=readFileSync(path.join(root,
    "app/ui/target-staging-my-plan-preview.tsx"),"utf8");
  const required=[
    'document.addEventListener("visibilitychange",visibility)',
    'window.addEventListener("focus",foreground)',
    'window.addEventListener("pagehide",pagehide)',
    'window.addEventListener("pageshow",pageshow)',
    'const pagehide=()=>hide()',
    'const pageshow=(event:PageTransitionEvent)=>wake(event.persisted)',
    'window.addEventListener("offline",offline)',
    'window.addEventListener("online",online)',
    'msUntilNextLocalMyPlanDay()',
    'const attempt=consumeMyPlanWake(wakeGate,Date.now(),force)',
    'wakeGate=invalidateMyPlanWakeGate(wakeGate)',
    'if(document.visibilityState==="hidden")hide()',
    'if(!attempt.reload)return',
    'const chosen=resumeMyPlanDate(date,followToday,new Date())',
    'current.current?.abort()',
    'setState({status:"error",reason})',
    'setFollowToday(false)',
    'setFollowToday(true)',
    'Do vybraného dne včetně',
  ];
  for(const fragment of required)
    assert.ok(ui.includes(fragment),fragment);
  assert.doesNotMatch(ui,/now-lastAwake<350/);
  assert.match(ui,/const hide=\(\)=>\{/);
  assert.match(ui,/if\(!navigator.onLine\)\{/);
  assert.match(ui,/clearTimeout\(clockTimer\)/);
  assert.match(ui,/removeEventListener\("visibilitychange",visibility\)/);
  assert.match(ui,/removeEventListener\("pagehide",pagehide\)/);
  assert.match(ui,/removeEventListener\("pageshow",pageshow\)/);
  assert.match(ui,/setDate\(chosen.evaluationDate\)/);
  assert.match(ui,/invalidate\("stale",true\)/);
  assert.match(ui,/if\(refreshing\)setState\(\{status:"loading"\}\)/);
  // Only read GET in both the old and hardened view.
  assert.doesNotMatch(ui,/method:\s*["'](?:PATCH|POST|PUT|DELETE)/);
});
