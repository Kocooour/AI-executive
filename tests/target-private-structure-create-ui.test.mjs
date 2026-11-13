import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {
  validStructureCommand,sendStructureCreate,checkStructureCreateStatus,
  recoverStructureCreate,cancelStructureCreateCommand,
} from "../lib/target-private-structure-create-client.ts";
import {
  structureCreateMarker,runStructureCreate,verifyStructureCreate,cancelStructureCreate,
} from "../lib/target-private-structure-create-coordinator.ts";
import {
  TARGET_PRIVATE_PROJECT_CREATE_FLAGS,TARGET_PROJECT_TASK_CREATE_FLAGS,
  targetPrivateProjectCreateUiEnabled,targetProjectTaskCreateUiEnabled,
} from "../lib/target-private-structure-create-ui-gate.ts";
import {TARGET_PRIVATE_NOTE_AREA_UI_FLAGS}
  from "../lib/target-private-note-area-ui-gate.ts";
import {isTargetReadRequest} from "../lib/target-edit-fetch.ts";
import {loadStructureCreateTargets} from "../lib/target-private-structure-targets-client.ts";

const headers={"content-type":"application/json","cache-control":"no-store"};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers});
const project=()=>({projectId:randomUUID(),commandId:randomUUID(),
  areaId:"private-area",restoreGeneration:randomUUID(),title:"Projekt"});
const child=(projectId="project:legacy-123")=>({taskId:randomUUID(),commandId:randomUUID(),
  projectId,restoreGeneration:randomUUID(),title:"Úkol"});
const generation="a".repeat(43);
const ownerScope="b".repeat(43);
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
    if(TARGET_PRIVATE_PROJECT_CREATE_FLAGS.includes(flag))
      assert.equal(targetPrivateProjectCreateUiEnabled(reduced),false,flag);
    if(TARGET_PROJECT_TASK_CREATE_FLAGS.includes(flag))
      assert.equal(targetProjectTaskCreateUiEnabled(reduced),false,flag);
  }
  // Independent note flags may all be off while structure create remains enabled.
  const noNotes={...all,AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED:"false",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED:"false",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED:"false",
    AI_EXECUTIVE_TARGET_STAGING_HTTP_PRIVATE_NOTE_AREAS_ENABLED:"false",
    AI_EXECUTIVE_TARGET_UI_PRIVATE_NOTE_AREAS_ENABLED:"false"};
  assert.equal(targetPrivateProjectCreateUiEnabled(noNotes),true);
  assert.equal(targetProjectTaskCreateUiEnabled(noNotes),true);
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
  assert.equal(validStructureCommand("project-task",{...t,projectId:"..invalid\n"}),false);
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
  assert.equal(await runStructureCreate(actor,generation,"project",cmd,ownerScope,
    async()=>{writes++;return "uncertain";}),"uncertain");
  assert.equal(writes,1);
  assert.equal(structureCreateMarker().status,"blocked");
  assert.equal(await runStructureCreate(actor,generation,"project",project(),ownerScope,
    async()=>{writes++;return "saved";}),"blocked");
  assert.equal(writes,1);
  const marker=JSON.stringify([...s.data.values()][0]);
  assert.ok(!marker.includes(cmd.title)&&!marker.includes(cmd.areaId)&&
    !marker.includes(cmd.projectId));
  assert.equal(await verifyStructureCreate(actor,generation,ownerScope,new AbortController().signal,
    async()=> "not_recorded"),"not_recorded");
  assert.equal(structureCreateMarker().status,"blocked");
  assert.deepEqual(await verifyStructureCreate(actor,generation,ownerScope,new AbortController().signal,
    async()=>({status:"committed",id:cmd.projectId})),
    {status:"committed",id:cmd.projectId});
  assert.equal(structureCreateMarker().status,"clear");
}));

test("R3 A/3: reload retains only opaque command ID; verified recovery clears it",async()=>withStorage(async()=>{
  const old=runtime(),cmd=child();
  assert.equal(await runStructureCreate(old,generation,"project-task",cmd,ownerScope,
    async()=> "uncertain"),"uncertain");
  // Simulate a page reload: different runtime has no original command.
  const fresh=runtime(),signal=new AbortController().signal;
  const result=await verifyStructureCreate(fresh,generation,ownerScope,signal,
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
  assert.match(component,/kind==="project"/);
  assert.match(detail,/kind="project-task"/);
  assert.match(component,/projectId:projectId!/);
  assert.doesNotMatch(component,/taskId:id,commandId,projectId:projectId!,areaId/);
});

test("R3 A/3: structure-owned targets are strict and independent of note create",async()=>{
  const signal=new AbortController().signal,area="area:e2e:create:private",gen=randomUUID();
  let called=0;
  const ok=await loadStructureCreateTargets(signal,async(url,options)=>{
    called++;
    assert.equal(url,"/api/target-staging/projects/create-targets");
    assert.equal(options.method,"GET");
    assert.equal(options.cache,"no-store");
    return json({areas:[{id:area,title:"Tvoření"}],restoreGeneration:gen,ownerScope});
  });
  assert.equal(called,1);
  assert.deepEqual(ok,{ok:true,areas:[{id:area,title:"Tvoření"}],restoreGeneration:gen,ownerScope});
  for(const payload of [
    {areas:[{id:area,title:"Tvoření"}],restoreGeneration:"invalid",ownerScope},
    {areas:[{id:area,title:"Tvoření"}],restoreGeneration:gen,ownerScope,actor:"secret"},
    {areas:[{id:area,title:"Tvoření"},{id:area,title:"Duplicated"}],restoreGeneration:gen,ownerScope},
  ])assert.equal((await loadStructureCreateTargets(signal,async()=>json(payload))).ok,false);
});
test("R3 A/3: cancellation only releases after terminal server fence, never on not_recorded",async()=>withStorage(async()=>{
  for(const kind of ["project","project-task"]){
    const actor=runtime(),cmd=kind==="project"?project():child();
    assert.equal(await runStructureCreate(actor,generation,kind,cmd,ownerScope,
      async()=>"uncertain"),"uncertain");
    assert.equal(await verifyStructureCreate(actor,generation,ownerScope,new AbortController().signal,
      async()=>"not_recorded"),"not_recorded");
    assert.equal(structureCreateMarker().status,"blocked");
    const unsuccessful=await cancelStructureCreate(actor,generation,ownerScope,new AbortController().signal,
      async()=> "unavailable");
    assert.equal(unsuccessful,"unavailable");
    assert.equal(structureCreateMarker().status,"blocked");
    let requests=0;
    const cancelled=await cancelStructureCreate(actor,generation,ownerScope,new AbortController().signal,
      async(k,id,scope,signal)=>{
        assert.equal(scope,ownerScope);requests++;assert.equal(k,kind);assert.equal(id,cmd.commandId);
        assert.equal(signal.aborted,false);return "cancelled";
      });
    assert.equal(cancelled,"cancelled");
    assert.equal(requests,1);
    assert.equal(structureCreateMarker().status,"clear");
    assert.equal(await runStructureCreate(actor,generation,kind,
      kind==="project"?project():child(),ownerScope,async()=>"saved"),"saved");
    assert.equal(structureCreateMarker().status,"clear");
  }
}));
test("R3 A/3: cancel HTTP requires exact opaque status and cannot be queued",async()=>{
  const signal=new AbortController().signal,commandId=randomUUID();
  for(const kind of ["project","project-task"]){
    const path=kind==="project"?"/api/target-staging/projects":"/api/target-staging/project-tasks";
    assert.equal(isTargetReadRequest(path+"/create-cancel",{method:"POST"}),false);
    assert.equal(await cancelStructureCreateCommand(kind,commandId,ownerScope,signal,
      async(url,opts)=>{
        assert.equal(url,path+"/create-cancel");
        assert.deepEqual(JSON.parse(opts.body),{commandId,ownerScope});
        return json({status:"cancelled"});
      }),"cancelled");
    assert.equal(await cancelStructureCreateCommand(kind,commandId,ownerScope,signal,
      async()=>json({status:"settled"})),"settled");
    for(const reply of [json({status:"not_recorded"}),json({status:"cancelled",extra:true}),
      json({error:"fail"},503)])
      assert.equal(await cancelStructureCreateCommand(kind,commandId,ownerScope,signal,
        async()=>reply),"unavailable");
  }
});

test("R3 A/3: reauth of original actor safely cancels undelivered create; other actor cannot clear it",async()=>withStorage(async()=>{
  const old=runtime(),cmd=project(),nextGeneration="c".repeat(43);
  assert.equal(await runStructureCreate(old,generation,"project",cmd,ownerScope,
    async()=> "uncertain"),"uncertain");
  const newRuntime={known:()=>true,generation:()=>nextGeneration,register:()=>()=>{}};
  assert.equal(await verifyStructureCreate(newRuntime,nextGeneration,ownerScope,
    new AbortController().signal,async()=>{throw Error("no original command");},
    async()=> "not_recorded"),"not_recorded");
  assert.equal(structureCreateMarker().status,"blocked");
  let cancelled=0;
  assert.equal(await cancelStructureCreate(newRuntime,nextGeneration,"x".repeat(43),
    new AbortController().signal,async()=>{cancelled++;return "cancelled";}),
    "unavailable","other actor may not cancel and release original actor's marker");
  assert.equal(cancelled,0);
  assert.equal(structureCreateMarker().status,"blocked");
  assert.equal(await cancelStructureCreate(newRuntime,nextGeneration,ownerScope,
    new AbortController().signal,async(kind,commandId,scope)=>{
      cancelled++;assert.equal(kind,"project");assert.equal(commandId,cmd.commandId);
      assert.equal(scope,ownerScope);return "cancelled";
    }),"cancelled");
  assert.equal(cancelled,1);
  assert.equal(structureCreateMarker().status,"clear");
}));
test("R3 A/3: settled receipt recovers an authorized created ID; revoked record is not revealed",async()=>withStorage(async()=>{
  for(const kind of ["project","project-task"]){
    const actor=runtime(),cmd=kind==="project"?project():child(),id=kind==="project"?cmd.projectId:cmd.taskId;
    assert.equal(await runStructureCreate(actor,generation,kind,cmd,ownerScope,
      async()=> "uncertain"),"uncertain");
    let requests=0;
    const response=await cancelStructureCreate(actor,generation,ownerScope,
      new AbortController().signal,
      async()=>{requests++;return "settled";},
      async(k,commandId)=>{requests++;assert.equal(k,kind);assert.equal(commandId,cmd.commandId);
        return {status:"committed",id};});
    assert.deepEqual(response,{status:"settled",id});
    assert.equal(requests,2);
    assert.equal(structureCreateMarker().status,"clear");
  }
  const actor=runtime(),cmd=project();
  assert.equal(await runStructureCreate(actor,generation,"project",cmd,ownerScope,
    async()=> "uncertain"),"uncertain");
  assert.deepEqual(await cancelStructureCreate(actor,generation,ownerScope,
    new AbortController().signal,async()=> "settled",async()=> "denied"),
    {status:"settled",id:null},"a hidden/deleted/foreign row must not be surfaced");
  assert.equal(structureCreateMarker().status,"clear");
}));
