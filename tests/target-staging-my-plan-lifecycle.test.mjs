import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  msUntilNextLocalMyPlanDay,resumeMyPlanDate,
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

test("lifecycle hooks abort and hide old actor data, revalidate after resume",()=>{
  const root=path.join(import.meta.dirname,"..");
  const ui=readFileSync(path.join(root,
    "app/ui/target-staging-my-plan-preview.tsx"),"utf8");
  const required=[
    'document.addEventListener("visibilitychange",visibility)',
    'window.addEventListener("focus",foreground)',
    'window.addEventListener("pageshow",foreground)',
    'window.addEventListener("offline",offline)',
    'window.addEventListener("online",online)',
    'msUntilNextLocalMyPlanDay()',
    'const chosen=resumeMyPlanDate(date,followToday,new Date())',
    'current.current?.abort()',
    'setState({status:"error",reason})',
    'setFollowToday(false)',
    'setFollowToday(true)',
    'Do vybraného dne včetně',
  ];
  for(const fragment of required)
    assert.ok(ui.includes(fragment),fragment);
  assert.match(ui,/clearTimeout\(clockTimer\)/);
  assert.match(ui,/removeEventListener\("visibilitychange",visibility\)/);
  assert.match(ui,/removeEventListener\("pageshow",foreground\)/);
  assert.match(ui,/setDate\(chosen.evaluationDate\)/);
  assert.match(ui,/invalidate\("stale",true\)/);
  assert.match(ui,/if\(refreshing\)setState\(\{status:"loading"\}\)/);
  // Only read GET in both the old and hardened view.
  assert.doesNotMatch(ui,/method:\s*["'](?:PATCH|POST|PUT|DELETE)/);
});
