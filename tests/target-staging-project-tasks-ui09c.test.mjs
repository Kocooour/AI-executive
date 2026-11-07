import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {
  readableProjectId,parseProjectTasksPage,loadProjectTasksPage,appendProjectTasksPage,
} from "../lib/target-staging-project-tasks-client.ts";

const project={id:"family",title:"Rodinný projekt",areaId:"shared-area",areaKind:"shared"};
const task=(id,area="shared-area")=>({
  id,title:"Úkol "+id,projectId:"family",areaId:area,effectiveAreaId:area,
  areaKind:"shared",assignedToMe:id==="a",
});
const payload=(tasks=[task("a")],hasMore=false,nextCursor=null)=>({
  project,tasks,hasMore,nextCursor,
});
const json=(body,options={})=>Response.json(body,{
  status:options.status??200,
  headers:{"cache-control":"no-store","content-type":"application/json",
    ...options.headers},
});
const root=path.join(import.meta.dirname,"..");
const read=file=>readFileSync(path.join(root,file),"utf8");

test("UI-09c server preview is default-off, isolated and not indexed",()=>{
  const page=read("app/target-staging/projects/[projectId]/preview/page.tsx");
  assert.ok(page.includes('AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED'));
  assert.ok(page.includes('AI_EXECUTIVE_TARGET_STAGING_PROJECT_TASKS_CLIENT_PREVIEW_ENABLED'));
  assert.match(page,/notFound\(\)/);
  assert.match(page,/index:false,follow:false/);
  assert.match(page,/force-dynamic/);
  assert.match(page,/key=\{projectId\}/);
  for(const file of ["app/ui/views/sidebar.tsx","app/ui/views/mobile-nav.tsx",
    "app/ui/navigation.ts"]){
    assert.ok(!read(file).includes("/target-staging/projects/"),file);
  }
});

test("strict project page parser accepts only matching inherited-ACL rows",()=>{
  const v=parseProjectTasksPage(payload(),{projectId:"family",limit:25});
  assert.deepEqual(v?.project,project);
  assert.equal(v?.tasks[0].assignedToMe,true);
  const privateProject={id:"secret",title:"Soukromý",areaId:"private-area",areaKind:"private"};
  const privateRow={id:"a",title:"Soukromý úkol",projectId:"secret",
    areaId:"private-area",effectiveAreaId:"private-area",areaKind:"private"};
  assert.ok(parseProjectTasksPage({project:privateProject,tasks:[privateRow],
    hasMore:false,nextCursor:null},{projectId:"secret",limit:25}));
  for(const bad of [
    {...payload(),project:{...project,members:["alice"]}},
    {...payload(),project:{...project,id:"other"}},
    {...payload(),project:{...project,areaKind:"private"}},
    payload([task("a","forbidden-area")]),
    payload([{...task("a"),assigneeUserId:"somebody"}]),
    payload([{...task("a"),assignedToMe:undefined}]),
    payload([task("b"),task("a")]),
    payload([task("a"),task("a")]),
    payload([task("a")],true,"YQ.Yg"),
    {...payload(),hasMore:false,nextCursor:"YQ.Yg"},
    {...payload(),tasks:[{...task("a"),body:"Private note body"}]},
  ]){
    assert.equal(parseProjectTasksPage(bad,{projectId:"family",limit:25}),null);
  }
  assert.equal(parseProjectTasksPage(payload([task("a"),task("b")]),
    {projectId:"family",limit:1}),null);
  assert.equal(readableProjectId(".."),false);
  assert.equal(readableProjectId("\ud800"),false);
  assert.equal(readableProjectId("x".repeat(513)),false);
});

test("read uses exactly one same-origin no-store GET and never sends actor/Area",async()=>{
  let calls=0;
  const result=await loadProjectTasksPage({projectId:"family",limit:25},async(url,init)=>{
    calls++;
    assert.equal(url,"/api/target-staging/projects/family/tasks?limit=25");
    assert.equal(init.method,"GET");
    assert.equal(init.credentials,"same-origin");
    assert.equal(init.cache,"no-store");
    assert.equal(init.redirect,"error");
    assert.equal(init.headers.accept,"application/json");
    return json(payload());
  });
  assert.equal(calls,1);
  assert.equal(result.ok,true);
  assert.equal(result.page?.project.title,"Rodinný projekt");
});

test("HTTP 401, 404, 409 and malformed response fail without rows",async()=>{
  for(const [status,reason] of [[401,"signed-out"],[403,"signed-out"],
    [404,"not-found"],[409,"stale"],[503,"unavailable"]]){
    const result=await loadProjectTasksPage({projectId:"family"},
      async()=>json({error:"Not found"},{status}));
    assert.deepEqual(result,{ok:false,reason});
  }
  for(const headers of [
    {"cache-control":"public,max-age=30"},
    {"cache-control":"private"},
    {"cache-control":'private="x, no-store, y"'},
    {"cache-control":'max-age=60, foo="no-store"'},
    {"content-type":"text/html"},
  ]){
    const result=await loadProjectTasksPage({projectId:"family"},
      async()=>json(payload(),{headers}));
    assert.deepEqual(result,{ok:false,reason:"invalid-response"});
  }
});

test("append rejects cross-page ID replay, stale project and unbounded pages",()=>{
  const old=payload([task("a")],true,"YQ.Yg");
  const ok=appendProjectTasksPage(old,payload([task("b")]),"YQ.Yg");
  assert.equal(ok?.tasks.length,2);
  assert.equal(appendProjectTasksPage(old,payload([task("a")]),"YQ.Yg"),null);
  assert.equal(appendProjectTasksPage(old,{
    ...payload([task("b")]),project:{...project,title:"Renamed"},
  },"YQ.Yg"),null);
  assert.equal(appendProjectTasksPage(old,payload([task("b")],true,"YQ.Yg"),"YQ.Yg"),null);
  assert.equal(appendProjectTasksPage(old,payload([task("b")]),"other.cursor"),null);
});

test("abort immediately invalidates a fetch even if the adapter never settles",async()=>{
  const controller=new AbortController();
  let requested=0;
  const promise=loadProjectTasksPage({projectId:"family",signal:controller.signal},
    async()=>{requested++;return new Promise(()=>{});});
  controller.abort();
  const result=await promise;
  assert.equal(requested,1);
  assert.deepEqual(result,{ok:false,reason:"aborted"});
});

test("UI-09c hides old titles during read and wipes on visibility, focus, offline, pagehide",()=>{
  const ui=read("app/ui/target-staging-project-tasks-preview.tsx");
  for(const marker of [
    'setView({status:"loading"})',
    'const ready=view.status==="ready"?view.page:null',
    'if(next)statusRef.current?.focus()',
    'running.current?.abort()',
    'setView(reason?{status:"error",reason}:{status:"empty"})',
    'window.addEventListener("pagehide",hide)',
    'window.addEventListener("blur",hide)',
    'window.addEventListener("focus",hide)',
    'window.addEventListener("offline",offline)',
    'document.addEventListener("visibilitychange",visible)',
    'if(event.persisted)hide()',
    'onClick={()=>{conceal();void read();}}',
  ])assert.ok(ui.includes(marker),marker);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|indexedDB|setTimeout|setInterval|fetch\(|\\.areaId\\}|assigneeUserId|memberRole/);
  assert.ok(ui.includes("Přiřazeno mně"));
  assert.ok(ui.includes("Načíst další úkoly"));
});
