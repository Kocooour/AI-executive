import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {test,after} from "node:test";

const root=mkdtempSync(path.join(os.tmpdir(),"lumi-r2d4i-bundle-"));
const legacy=path.join(root,"legacy");
mkdirSync(legacy);writeFileSync(path.join(legacy,"sentinel"),"unchanged");
const old=process.env.AI_EXECUTIVE_DATA_DIR;
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
const {bootstrapIsolatedTargetStore}=await import("../lib/target-store-bootstrap.ts");
const {readAuthorizedAttentionCandidatePage}=await import("../lib/target-attention-read-model.ts");
const {readAuthorizedMyPlanDayTaskPage}=await import("../lib/target-my-plan-day-task-read-model.ts");
const {readAuthorizedTitleSearchPage}=await import("../lib/target-authorized-title-search.ts");
const {TargetStagingSessionAuthority}=await import("../lib/target-staging-session-authority.ts");
const {serializeTargetContextBundleForProvider,MAX_CONTEXT_BUNDLE_BYTES,
  resolveAuthorizedTargetContextBundle}=await import("../lib/target-context-bundle.ts");

let count=0;const fixtures=[];
function fixture(){
  const stage=bootstrapIsolatedTargetStore({
    stagingDirectory:path.join(root,"stage-"+(++count)),ownerUserId:"alice",
  });
  const db=new DatabaseSync(stage.databasePath);
  db.exec("PRAGMA foreign_keys=ON");
  for(const who of ["bob","carol","erin"]){
    db.prepare("INSERT INTO identities(id) VALUES (?)").run(who);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run(who+"-ws",who);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,?,'private',?,?,'unassigned')")
      .run(who+"-private",who,who+"-ws",who);
  }
  for(const [ws,owner] of [["family","alice"],["hidden","erin"]]){
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'shared',?)").run(ws,owner);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES (?,?,'shared',?,?)")
      .run(ws+"-area",ws,ws,owner);
  }
  for(const [area,who,role] of [
    ["family-area","alice","admin"],["family-area","bob","editor"],
    ["family-area","carol","viewer"],["hidden-area","erin","admin"],
  ])db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES (?,?,?)").run(area,who,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('project','family-area','Family')").run();
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('bob-proj','bob-private','Bob secret project')").run();
  const put=db.prepare("INSERT INTO tasks(id,area_id,project_id,title,assignee_user_id,due_on) VALUES (?,?,?,?,?,?)");
  for(const row of [
    ["b-over","bob-private",null,"Bob overdue",null,"2026-11-03"],
    ["b-today","bob-private",null,"Bob due today",null,"2026-11-04"],
    ["b-tom","bob-private",null,"Bob due tomorrow",null,"2026-11-05"],
    ["b-3days","bob-private",null,"Bob due in 3 days",null,"2026-11-07"],
    ["b-passed","bob-private",null,"Bob plan passed",null,null],
    ["b-planned-today","bob-private",null,"Bob planned today",null,null],
    ["b-done","bob-private",null,"Bob done",null,"2026-11-01"],
    ["alice-private",stage.unassignedAreaId,null,"Alice only secret",null,"2026-11-01"],
    ["erin-private","erin-private",null,"Erin only secret",null,"2026-11-01"],
    ["s-mine","family-area",null,"Shared mine","bob","2026-11-02"],
    ["s-unassigned","family-area",null,"Unassigned secret",null,"2026-11-01"],
    ["s-alice","family-area",null,"Alice shared secret","alice","2026-11-01"],
    ["s-child",null,"project","Inherited Area","bob","2026-11-03"],
    ["hidden","hidden-area",null,"Hidden secret","erin","2026-11-01"],
  ])put.run(...row);
  db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='b-done'").run();
  const plan=db.prepare("INSERT INTO personal_task_plans(user_id,task_id,when_on) VALUES (?,?,?)");
  for(const row of [
    ["bob","b-passed","2026-11-03"],["bob","b-planned-today","2026-11-04"],
    ["alice","s-alice","2026-11-01"],["alice","alice-private","2026-10-01"],
    ["erin","erin-private","2026-10-01"],
  ])plan.run(...row);
  const note=db.prepare("INSERT INTO notes(id,area_id,project_id,title,body) VALUES (?,?,?,?,?)");
  note.run("n-family","family-area",null,"Family note secret","BODY-SENTINEL-FAMILY");
  note.run("n-bob","bob-private",null,"Bob private note secret","BODY-SENTINEL-BOB");
  note.run("n-erin","erin-private",null,"Erin private note secret","BODY-SENTINEL-ERIN");
  note.run("n-alice",stage.unassignedAreaId,null,"Alice private note secret","BODY-SENTINEL-ALICE");
  const reader=new DatabaseSync(stage.databasePath,{readOnly:true});
  const store={stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration};
  const authority=new TargetStagingSessionAuthority(store);
  const fx={db,reader,authority,stage,store};fixtures.push(fx);
  return fx;
}
after(()=>{
  for(const f of fixtures){f.authority.close();f.reader.close();f.db.close();}
  if(old===undefined)delete process.env.AI_EXECUTIVE_DATA_DIR;
  else process.env.AI_EXECUTIVE_DATA_DIR=old;
  assert.equal(readFileSync(path.join(legacy,"sentinel"),"utf8"),"unchanged");
  rmSync(root,{recursive:true,force:true});
});
const NOON=Date.parse("2026-11-04T11:00:00Z");
const TZ="Europe/Prague";
const req=(purpose,scope,extra={})=>({purpose,scope,
  query:purpose==="find"?"secret":null,nowMs:NOON,timeZone:TZ,maxItems:50,...extra});
const bundle=(f,actor,purpose,scope,extra)=>f.authority.resolveContextBundle(actor,req(purpose,scope,extra));
const ids=b=>b.items.map(i=>i.id);
const gen=f=>f.stage.restoreGeneration;
const att=(f,actor,filter="all")=>readAuthorizedAttentionCandidatePage(f.reader,{
  actorUserId:actor,areaFilter:filter,view:"active",evaluatedAtMs:NOON,timeZone:TZ,
  limit:100,offset:0,restoreGeneration:gen(f)});
const day=(f,actor,window,through,filter="all")=>readAuthorizedMyPlanDayTaskPage(f.reader,{
  actorUserId:actor,areaFilter:filter,window,evaluationDate:"2026-11-04",throughDate:through,
  limit:100,offset:0,restoreGeneration:gen(f)});
const search=(f,actor,scope,q="secret")=>readAuthorizedTitleSearchPage(f.reader,{
  actorUserId:actor,scope,query:q,limit:50,offset:0,restoreGeneration:gen(f)});

test("what_matters equals attention union today's plan, deduplicated, deterministic",()=>{
  const f=fixture();
  const b=bundle(f,"bob","what_matters","my-plan");
  const a=att(f,"bob"),t=day(f,"bob","today",null);
  const expected=[...a.items.map(i=>i.taskId),
    ...t.tasks.map(i=>i.taskId).filter(id=>!a.items.some(x=>x.taskId===id))];
  assert.deepEqual(ids(b),expected);
  assert.equal(new Set(ids(b)).size,ids(b).length);
  assert.ok(ids(b).includes("b-planned-today"),"plan-only task has no attention");
  assert.equal(b.items.find(i=>i.id==="b-planned-today").attention,undefined);
  const over=b.items.find(i=>i.id==="b-over");
  assert.deepEqual(over.attention,{ruleId:"deadline_overdue",severity:1,relevantOn:"2026-11-03",lifecycle:"active"});
  assert.equal(over.provenance.source,"attention");
  assert.equal(typeof over.provenance.revision,"number");
  assert.equal(b.items.find(i=>i.id==="s-mine").assignedToMe,true);
  assert.equal(b.items.find(i=>i.id==="b-over").assignedToMe,undefined);
  assert.equal(b.truncated,false);
  assert.equal(b.evaluationDate,"2026-11-04");
  assert.deepEqual(b,bundle(f,"bob","what_matters","my-plan"));
  // personal / shared narrow the same population
  assert.deepEqual(ids(bundle(f,"bob","what_matters","shared")),
    [...att(f,"bob","shared").items.map(i=>i.taskId),
      ...day(f,"bob","today",null,"shared").tasks.map(i=>i.taskId)
        .filter(id=>!att(f,"bob","shared").items.some(x=>x.taskId===id))]);
  assert.ok(ids(bundle(f,"bob","what_matters","personal")).every(id=>id.startsWith("b-")));
});

test("plan_today equals today + next day with attention attached",()=>{
  const f=fixture();
  const b=bundle(f,"bob","plan_today","my-plan");
  const today=day(f,"bob","today",null).tasks.map(t=>t.taskId);
  const next=day(f,"bob","upcoming","2026-11-05").tasks.map(t=>t.taskId);
  assert.deepEqual(ids(b),[...today,...next]);
  assert.ok(next.includes("b-tom"));
  const a=att(f,"bob");
  for(const i of b.items){
    const x=a.items.find(y=>y.taskId===i.id);
    assert.equal(i.attention?.ruleId,x?.ruleId);
    assert.equal(i.provenance.source,x?"attention":"my_plan");
  }
  assert.ok(!ids(b).includes("b-3days"));
  assert.deepEqual(b,bundle(f,"bob","plan_today","my-plan"));
});

test("find equals authorized title search, titles only",()=>{
  const f=fixture();
  for(const scope of ["all","personal","shared"]){
    const b=bundle(f,"bob","find",scope);
    const s=search(f,"bob",scope);
    assert.deepEqual(b.items.map(i=>[i.kind,i.id,i.title,i.areaKind]),
      s.items.map(i=>[i.kind,i.id,i.title,i.areaKind]));
    for(const i of b.items)assert.equal(i.provenance.source,"title_search");
  }
  const all=bundle(f,"bob","find","all");
  assert.ok(ids(all).includes("n-bob")&&ids(all).includes("n-family"));
  assert.ok(all.items.some(i=>i.kind==="note"));
  assert.equal(bundle(f,"bob","find","all",{maxItems:2}).truncated,true);
  assert.equal(bundle(f,"bob","find","all",{maxItems:2}).items.length,2);
});

const FORBIDDEN_FOR={
  bob:["Alice only secret","Erin only secret","Hidden secret","Alice private note",
    "Erin private note","BODY-SENTINEL-ALICE","BODY-SENTINEL-ERIN"],
  carol:["Alice only secret","Erin only secret","Hidden secret","Bob ","Bob private",
    "Alice private note","Erin private note","BODY-SENTINEL-ALICE","BODY-SENTINEL-ERIN","BODY-SENTINEL-BOB"],
  erin:["Alice only secret","Bob ","Unassigned secret","Alice shared secret","Family",
    "BODY-SENTINEL-ALICE","BODY-SENTINEL-BOB","BODY-SENTINEL-FAMILY"],
};
const OTHERS={bob:["alice","carol","erin"],carol:["alice","bob","erin"],erin:["alice","bob","carol"]};
test("privacy matrix: no foreign titles, ids, Areas, bodies or witness leak",()=>{
  const f=fixture();
  const areaIds=["bob-private","carol-private","erin-private","family-area","hidden-area",
    "bob-ws","family","hidden",f.stage.unassignedAreaId];
  for(const actor of ["bob","carol","erin"]){
    for(const [purpose,scope] of [["what_matters","my-plan"],["what_matters","personal"],
      ["what_matters","shared"],["plan_today","my-plan"],["plan_today","personal"],
      ["plan_today","shared"],["find","all"],["find","personal"],["find","shared"]]){
      const b=bundle(f,actor,purpose,scope);
      assert.ok(b,`${actor} ${purpose} ${scope}`);
      const json=serializeTargetContextBundleForProvider(b);
      assert.equal(typeof json,"string");
      const parsed=JSON.parse(json);
      assert.deepEqual(Object.keys(parsed),["bundleVersion","purpose","scope","generatedAtMs",
        "timeZone","evaluationDate","items","truncated","revision"]);
      for(const i of parsed.items)for(const k of Object.keys(i))
        assert.ok(["kind","id","title","areaKind","assignedToMe","dueOn","whenOn","attention",
          "provenance"].includes(k),k);
      for(const s of FORBIDDEN_FOR[actor])assert.ok(!json.includes(s),`${actor} ${purpose}/${scope} leaks ${s}`);
      for(const o of OTHERS[actor])assert.ok(!json.includes(`"${o}"`)&&!json.includes(o+"-"),`${actor} sees id ${o}`);
      for(const a of areaIds.filter(x=>x!==actor+"-private"&&!(actor==="erin"&&x.startsWith("hidden"))))assert.ok(!json.includes(`"${a}"`),`${actor} sees area ${a}`);
      assert.ok(!json.includes("BODY-SENTINEL"),"no note bodies");
      for(const w of ["witness","linearization","areaEpochs","areaId","assignee"])
        assert.ok(!json.includes(w),w);
      if(purpose!=="find"){
        assert.ok(!json.includes("Unassigned secret")&&!json.includes("Alice shared secret"));
      }
    }
  }
  // viewer carol: nothing in my-plan purposes, shared items in find
  assert.deepEqual(bundle(f,"carol","what_matters","my-plan").items,[]);
  assert.deepEqual(bundle(f,"carol","plan_today","my-plan").items,[]);
  const cf=bundle(f,"carol","find","shared");
  assert.ok(ids(cf).includes("s-unassigned")&&ids(cf).includes("s-alice"));
  // editor bob: assigned only
  assert.ok(!ids(bundle(f,"bob","what_matters","my-plan")).includes("s-unassigned"));
  assert.ok(!ids(bundle(f,"bob","what_matters","my-plan")).includes("s-alice"));
  // foreign erin never sees family items
  assert.ok(!ids(bundle(f,"erin","find","all")).some(id=>id.startsWith("s-")||id.startsWith("n-fam")));
  // whenOn only the actor's own
  const aliceWhen=bundle(f,"bob","what_matters","my-plan").items.filter(i=>i.id==="s-alice");
  assert.equal(aliceWhen.length,0);
  assert.ok(bundle(f,"bob","what_matters","my-plan").witness);
  assert.equal("witness" in JSON.parse(serializeTargetContextBundleForProvider(
    bundle(f,"bob","what_matters","my-plan"))),false);
});

test("revocation, reassignment, completion, dismissal change bundle and revision",()=>{
  const f=fixture();
  const base=bundle(f,"bob","what_matters","my-plan");
  assert.ok(ids(base).includes("s-mine"));
  // dismissed attention: task stays in plan but loses attention
  f.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state) VALUES ('bob','b-over','deadline_overdue','2026-11-03','dismissed')").run();
  const dismissed=bundle(f,"bob","what_matters","my-plan");
  assert.equal(dismissed.items.find(i=>i.id==="b-over").attention,undefined);
  assert.equal(dismissed.items.find(i=>i.id==="b-over").provenance.source,"my_plan");
  assert.notEqual(dismissed.revision,base.revision);
  // snoozed attention likewise
  f.db.prepare("INSERT INTO personal_attention_states(user_id,task_id,rule_id,occurrence_on,state,snoozed_until_ms) VALUES ('bob','b-today','deadline_soon','2026-11-04','snoozed',?)").run(NOON+1000);
  assert.equal(bundle(f,"bob","what_matters","my-plan").items.find(i=>i.id==="b-today").attention,undefined);
  // reassigned away
  f.db.prepare("UPDATE tasks SET assignee_user_id='alice' WHERE id='s-mine'").run();
  const re=bundle(f,"bob","what_matters","my-plan");
  assert.ok(!ids(re).includes("s-mine"));
  assert.ok(!ids(re).includes("s-child")===false);
  // completed
  f.db.prepare("UPDATE tasks SET status='completed',completed_at_ms=1793800000000 WHERE id='b-planned-today'").run();
  assert.ok(!ids(bundle(f,"bob","what_matters","my-plan")).includes("b-planned-today"));
  // membership removed: no shared items, not even in find
  const before=bundle(f,"bob","find","shared");
  assert.ok(ids(before).includes("s-unassigned"));
  f.db.prepare("UPDATE tasks SET assignee_user_id=NULL WHERE assignee_user_id='bob'").run();
  f.db.prepare("DELETE FROM area_members WHERE area_id='family-area' AND user_id='bob'").run();
  const after_=bundle(f,"bob","find","shared");
  assert.deepEqual(after_.items,[]);
  assert.notEqual(after_.revision,before.revision);
  assert.ok(!ids(bundle(f,"bob","what_matters","my-plan")).includes("s-child"));
  assert.ok(!ids(bundle(f,"bob","plan_today","my-plan")).includes("s-child"));
});

test("validation: purpose/scope combos, query, bounds, zone, clock, keys",()=>{
  const f=fixture();
  const bad=[
    req("what_matters","all"),req("plan_today","all"),req("find","my-plan"),
    req("nope","my-plan"),req("what_matters","my-plan",{query:"secret"}),
    req("plan_today","my-plan",{query:""}),
    req("find","all",{query:null}),req("find","all",{query:""}),req("find","all",{query:"a"}),
    req("find","all",{query:" secret"}),req("find","all",{query:"x".repeat(81)}),
    req("find","all",{query:"a\u0000b"}),req("find","all",{query:5}),
    req("find","all",{maxItems:0}),req("find","all",{maxItems:51}),
    req("find","all",{maxItems:1.5}),req("find","all",{maxItems:"3"}),
    req("find","all",{maxItems:null}),
    req("find","all",{timeZone:"Mars/Olympus"}),req("find","all",{timeZone:""}),
    req("find","all",{timeZone:5}),
    req("find","all",{nowMs:-1}),req("find","all",{nowMs:1.5}),
    req("find","all",{nowMs:Number.MAX_SAFE_INTEGER+2}),req("find","all",{nowMs:"1"}),
    req("find","all",{nowMs:NaN}),
    {...req("find","all"),extra:1},{...req("find","all"),actorUserId:"alice"},
    (()=>{const r=req("find","all");delete r.query;return r;})(),
    null,[],"x",undefined,
  ];
  for(const r of bad)assert.equal(f.authority.resolveContextBundle("bob",r),null,JSON.stringify(r));
  assert.ok(f.authority.resolveContextBundle("bob",req("find","all",{maxItems:1})));
  assert.ok(f.authority.resolveContextBundle("bob",req("find","all",{maxItems:50})));
  assert.ok(f.authority.resolveContextBundle("bob",req("find","all",{query:"x".repeat(80)})));
  // db-level: bad actor / generation
  const db=f.reader;
  const ok={...req("find","all"),actorUserId:"bob",restoreGeneration:gen(f)};
  assert.ok(resolveAuthorizedTargetContextBundle(db,ok));
  assert.equal(resolveAuthorizedTargetContextBundle(db,{...ok,actorUserId:"bad actor"}),null);
  assert.equal(resolveAuthorizedTargetContextBundle(db,{...ok,restoreGeneration:"nope"}),null);
  assert.equal(resolveAuthorizedTargetContextBundle(db,{...ok,actorUserId:"nobody"}),null);
  assert.equal(resolveAuthorizedTargetContextBundle(db,{...ok,extra:1}),null);
});

test("byte cap drops lowest-priority items deterministically and sets truncated",()=>{
  const f=fixture();
  const put=f.db.prepare("INSERT INTO tasks(id,area_id,title,due_on) VALUES (?,?,?,?)");
  for(let n=0;n<20;n++)put.run("long-"+String(n).padStart(2,"0"),"bob-private",
    String(n).padStart(2,"0")+"x".repeat(3000),"2026-11-01");
  const full=bundle(f,"bob","what_matters","my-plan",{maxItems:50});
  const json=serializeTargetContextBundleForProvider(full);
  assert.ok(Buffer.byteLength(json)<=MAX_CONTEXT_BUNDLE_BYTES);
  assert.equal(full.truncated,true);
  assert.ok(full.items.length<50);
  const again=bundle(f,"bob","what_matters","my-plan",{maxItems:50});
  assert.deepEqual(again,full);
  // kept items are a prefix of the uncapped priority order
  const small=bundle(f,"bob","what_matters","my-plan",{maxItems:3});
  assert.deepEqual(ids(full).slice(0,3),ids(small).slice(0,3));
  assert.equal(small.truncated,true);
  // whole payload is a pure function of kept items: revision differs from small
  assert.notEqual(full.revision,small.revision);
  const smallEnough=bundle(f,"carol","what_matters","my-plan");
  assert.equal(smallEnough.truncated,false);
});

test("authority: closed, unknown or malformed actor return null",()=>{
  const f=fixture();
  assert.ok(f.authority.resolveContextBundle("carol",req("find","all")));
  assert.equal(f.authority.resolveContextBundle("nobody",req("find","all")),null);
  assert.equal(f.authority.resolveContextBundle("a client actor",req("find","all")),null);
  assert.equal(f.authority.resolveContextBundle(null,req("find","all")),null);
  f.authority.close();
  assert.equal(f.authority.resolveContextBundle("carol",req("find","all")),null);
});

test("fail closed (never partial) on a corrupt own plan row or a blank emitted title",()=>{
  for(const bad of ["garbage","2026-13-40"]){
    const f=fixture();
    assert.ok(bundle(f,"bob","plan_today","my-plan"));
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    f.db.prepare("UPDATE personal_task_plans SET when_on=? WHERE user_id='bob' AND task_id='b-passed'").run(bad);
    f.db.exec("PRAGMA ignore_check_constraints=OFF");
    for(const p of [["what_matters","my-plan"],["plan_today","my-plan"],["find","all"]])
      assert.equal(bundle(f,"bob",...p),null,bad+" "+p.join("/"));
    assert.ok(bundle(f,"alice","what_matters","my-plan"),"another user's bundle is unaffected");
  }
  const f=fixture();
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db.prepare("UPDATE tasks SET title='   ' WHERE id='b-over'").run();
  f.db.exec("PRAGMA ignore_check_constraints=OFF");
  assert.equal(bundle(f,"bob","what_matters","my-plan"),null);
});
