import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {
  validStructureCommand,sendStructureCreate,checkStructureCreateStatus,
  recoverStructureCreate,
} from "../lib/target-private-structure-create-client.ts";
import {
  structureCreateMarker,runStructureCreate,verifyStructureCreate,
} from "../lib/target-private-structure-create-coordinator.ts";
import {
  TARGET_PRIVATE_PROJECT_CREATE_FLAGS,TARGET_PROJECT_TASK_CREATE_FLAGS,
  targetPrivateProjectCreateUiEnabled,targetProjectTaskCreateUiEnabled,
} from "../lib/target-private-structure-create-ui-gate.ts";
import {TARGET_PRIVATE_NOTE_AREA_UI_FLAGS}
  from "../lib/target-private-note-area-ui-gate.ts";
import {isTargetReadRequest} from "../lib/target-edit-fetch.ts";

const headers={"content-type":"application/json","cache-control":"no-store"};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers});
const project=()=>({projectId:randomUUID(),commandId:randomUUID(),
  areaId:"private-area",restoreGeneration:randomUUID(),title:"Projekt"});
const child=(projectId="project:legacy-123")=>({taskId:randomUUID(),commandId:randomUUID(),
  projectId,restoreGeneration:randomUUID(),title:"Úkol"});
const generation="a".repeat(43);
const runtime=()=>({known:()=>true,generation:()=>generation,register:()=>()=>{}});
const storage=()=>{const data=new Map();return {data,getItem:k=>data.get(k)??null,
  setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
async function withStorage(fn){
  const previous=globalThis.sessionStorage;
  const s=storage();globalThis.sessionStorage=s;
  try{return await fn(s);}
  finally{if(previous===undefined)delete globalThis.sessionStorage;
    else globalThis.sessionStorage=previous;}
}

test("R3 A/3: project and child task UI flags default off, independent and exact",()=>{
  const all=Object.fromEntries([...TARGET_PRIVATE_NOTE_AREA_UI_FLAGS,
    ...TARGET_PRIVATE_PROJECT_CREATE_FLAGS,...TARGET_PROJECT_TASK_CREATE_FLAGS]
    .map(name=>[name,"true"]));
  assert.equal(targetPrivateProjectCreateUiEnabled({}),false);
  assert.equal(targetProjectTaskCreateUiEnabled({}),false);
  assert.equal(targetPrivateProjectCreateUiEnabled(all),true);
  assert.equal(targetProjectTaskCreateUiEnabled(all),true);
  for(const flag of Object.keys(all)){
    const reduced={...all,[flag]:undefined};
    if(TARGET_PRIVATE_PROJECT_CREATE_FLAGS.includes(flag)||
      TARGET_PRIVATE_NOTE_AREA_UI_FLAGS.includes(flag))
      assert.equal(targetPrivateProjectCreateUiEnabled(reduced),false,flag);
    if(TARGET_PROJECT_TASK_CREATE_FLAGS.includes(flag)||
      TARGET_PRIVATE_NOTE_AREA_UI_FLAGS.includes(flag))
      assert.equal(targetProjectTaskCreateUiEnabled(reduced),false,flag);
  }
  assert.equal(targetPrivateProjectCreateUiEnabled({...all,
    AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECTS_CREATE_ENABLED:"false"}),false);
  assert.equal(targetProjectTaskCreateUiEnabled({...all,
    AI_EXECUTIVE_TARGET_STAGING_HTTP_PROJECT_TASKS_CREATE_ENABLED:"false"}),false);
});

test("R3 A/3: strict, exact command contract, lowercase new UUIDs and legacy parent",()=>{
  const p=project(),t=child();
  assert.equal(validStructureCommand("project",p),true);
  assert.equal(validStructureCommand("project-task",t),true);
  assert.equal(validStructureCommand("project-task",{...t,areaId:"private-area"}),false);
  assert.equal(validStructureCommand("project-task",{...t,projectId:"not a valid id"}),false);
  assert.equal(validStructureCommand("project-task",{...t,projectId:"abc/def"}),true);
  assert.equal(validStructureCommand("project",{...p,projectId:p.projectId.toUpperCase()}),false);
  assert.equal(validStructureCommand("project-task",{...t,taskId:t.taskId.toUpperCase()}),false);
  assert.equal(validStructureCommand("project",{...p,title:"  title  "}),false);
  assert.equal(validStructureCommand("project",{...p,areaId:"shared area"}),false);
  assert.equal(validStructureCommand("project-task",{...t,title:"a".repeat(4097)}),false);
});

test("R3 A/3: one create POST, exact success or uncertain; status/recovery are queued READS",async()=>{
  const signal=new AbortController().signal;
  for(const [kind,cmd,id,path] of [
    ["project",project(),null,"/api/target-staging/projects"],
    ["project-task",child(),null,"/api/target-staging/project-tasks"],
  ]){
    const expected=kind==="project"?cmd.projectId:cmd.taskId;
    let posts=0;
    const fetcher=async(url,options)=>{
      posts++;
      assert.equal(url,path);
      assert.equal(options.method,"POST");
      assert.equal(options.credentials,"same-origin");
      assert.equal(options.redirect,"error");
      assert.equal(options.cache,"no-store");
      assert.deepEqual(JSON.parse(options.body),cmd);
      return json({ok:true,id:expected},201);
    };
    assert.equal(await sendStructureCreate(kind,cmd,signal,fetcher),"saved");
    assert.equal(posts,1);
    assert.equal(await sendStructureCreate(kind,cmd,signal,
      async()=>json({ok:true,id:expected,replayed:true},200)),"saved");
    for(const malformed of [json({ok:true,id:expected,actor:"unexpected"},201),
      json({ok:true,id:randomUUID()},201),json({ok:true,id:expected,replayed:false},200),
      json({error:"timed out"},503)]){
      assert.equal(await sendStructureCreate(kind,cmd,signal,async()=>malformed),"uncertain");
    }
    const status=await checkStructureCreateStatus(kind,cmd,signal,async(url,options)=>{
      assert.equal(url,path+"/create-status");
      assert.deepEqual(JSON.parse(options.body),cmd);
      return json({status:"committed",id:expected});
    });
    assert.deepEqual(status,{status:"committed",id:expected});
    assert.equal(await checkStructureCreateStatus(kind,cmd,signal,
      async()=>json({status:"committed",id:randomUUID()})),"unavailable");
    const recovery=await recoverStructureCreate(kind,cmd.commandId,null,signal,
      async(url,options)=>{
        assert.equal(url,path+"/create-recovery");
        assert.deepEqual(JSON.parse(options.body),{commandId:cmd.commandId});
        return json({status:"committed",id:expected});
      });
    assert.deepEqual(recovery,{status:"committed",id:expected});
    assert.equal(await checkStructureCreateStatus(kind,cmd,signal,
      async()=>json({status:"not_recorded"})),"not_recorded");
    assert.equal(isTargetReadRequest(path+"/create-status",{method:"POST"}),true);
    assert.equal(isTargetReadRequest(path+"/create-recovery",{method:"POST"}),true);
    assert.equal(isTargetReadRequest(path,{method:"POST"}),false);
    void id;
  }
});

test("R3 A/3: dropped response blocks duplicate POST; not_recorded never releases",async()=>withStorage(async s=>{
  const actor=runtime(),cmd=project();
  let writes=0;
  assert.equal(await runStructureCreate(actor,generation,"project",cmd,
    async()=>{writes++;return "uncertain";}),"uncertain");
  assert.equal(writes,1);
  assert.equal(structureCreateMarker().status,"blocked");
  assert.equal(await runStructureCreate(actor,generation,"project",project(),
    async()=>{writes++;return "saved";}),"blocked");
  assert.equal(writes,1);
  const marker=JSON.stringify([...s.data.values()][0]);
  assert.ok(!marker.includes(cmd.title)&&!marker.includes(cmd.areaId)&&
    !marker.includes(cmd.projectId));
  assert.equal(await verifyStructureCreate(actor,generation,new AbortController().signal,
    async()=> "not_recorded"),"not_recorded");
  assert.equal(structureCreateMarker().status,"blocked");
  assert.deepEqual(await verifyStructureCreate(actor,generation,new AbortController().signal,
    async()=>({status:"committed",id:cmd.projectId})),
    {status:"committed",id:cmd.projectId});
  assert.equal(structureCreateMarker().status,"clear");
}));

test("R3 A/3: reload retains only opaque command ID; verified recovery clears it",async()=>withStorage(async()=>{
  const old=runtime(),cmd=child();
  assert.equal(await runStructureCreate(old,generation,"project-task",cmd,
    async()=> "uncertain"),"uncertain");
  // Simulate a page reload: different runtime has no original command.
  const fresh=runtime(),signal=new AbortController().signal;
  const result=await verifyStructureCreate(fresh,generation,signal,
    async()=>{throw Error("must not use status without original command");},
    async(kind,id,parent)=>{
      assert.equal(kind,"project-task");assert.equal(id,cmd.commandId);
      assert.equal(parent,null);
      return {status:"committed",id:cmd.taskId};
    });
  assert.deepEqual(result,{status:"committed",id:cmd.taskId});
  assert.equal(structureCreateMarker().status,"clear");
}));

test("R3 A/3: authorized screen wiring, no create in shared scope, no client Area for child",()=>{
  const list=readFileSync(new URL("../app/ui/target-scope-lists.tsx",import.meta.url),"utf8");
  const detail=readFileSync(new URL("../app/ui/target-detail-panel.tsx",import.meta.url),"utf8");
  const component=readFileSync(new URL("../app/ui/target-private-project-create.tsx",import.meta.url),"utf8");
  assert.match(list,/scope!=="shared"/);
  assert.match(detail,/page\.project\.areaKind==="private"/);
  assert.match(component,/kind==="project-task"/);
  assert.match(component,/projectId:projectId!/);
  assert.doesNotMatch(component,/taskId:id,commandId,projectId:projectId!,areaId/);
});
