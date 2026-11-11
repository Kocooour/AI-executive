import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {sendPrivateTaskCreate,recoverPrivateTaskCreate,
  validPrivateTaskCreateCommand} from "../lib/target-private-task-create-client.ts";
import {privateTaskCreateMarker,reservePrivateTaskCreate,
  confirmPrivateTaskCreate} from "../lib/target-private-task-create-reload.ts";
import {runPrivateTaskCreate,trackedPrivateTaskCreate,
  checkPrivateTaskCreate} from "../lib/target-private-task-create-coordinator.ts";
import {targetPrivateTaskCreateUiEnabled,TARGET_PRIVATE_TASK_CREATE_UI_FLAGS}
  from "../lib/target-private-task-create-ui-gate.ts";
import {TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS}
  from "../lib/target-private-note-create-ui-gate.ts";
import {TARGET_PRIVATE_NOTE_AREA_UI_FLAGS}
  from "../lib/target-private-note-area-ui-gate.ts";
const generation="A".repeat(43);
const json={"content-type":"application/json","cache-control":"no-store"};
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:json});
const command=()=>({taskId:randomUUID(),commandId:randomUUID(),areaId:"alice-private",
  restoreGeneration:randomUUID(),title:"Synthetic personal task"});
const fakeStore=()=>{
  const map=new Map();
  return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),
    removeItem:k=>map.delete(k),toString:()=>JSON.stringify(Object.fromEntries(map))};
};
const withStorage=async fn=>{
  const original=globalThis.sessionStorage;
  globalThis.sessionStorage=fakeStore();
  try{await fn(globalThis.sessionStorage);}finally{
    if(original===undefined)delete globalThis.sessionStorage;
    else globalThis.sessionStorage=original;
  }
};
test("task UI is independently default-off and tied to authenticated private Area preflight",()=>{
  const flags=[...TARGET_PRIVATE_NOTE_AREA_UI_FLAGS,
    ...TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS,...TARGET_PRIVATE_TASK_CREATE_UI_FLAGS];
  const env=Object.fromEntries(flags.map(k=>[k,"true"]));
  assert.equal(targetPrivateTaskCreateUiEnabled(env),true);
  for(const flag of flags){
    assert.equal(targetPrivateTaskCreateUiEnabled({...env,[flag]:"false"}),false,flag);
  }
});
test("private task command shape, IDs, origin and response DTO are strict",async()=>{
  const cmd=command(),signal=new AbortController().signal;
  assert.equal(validPrivateTaskCreateCommand(cmd),true);
  for(const mutation of [{actor:"alice"},{projectId:null},{title:" x "},
    {title:""},{areaId:"shared space"},{taskId:cmd.taskId.toUpperCase()}])
    assert.equal(validPrivateTaskCreateCommand({...cmd,...mutation}),false);
  assert.equal(await sendPrivateTaskCreate(cmd,signal,async(url,init)=>{
    assert.equal(url,"/api/target-staging/tasks");
    assert.equal(init.method,"POST");assert.equal(init.cache,"no-store");
    assert.equal(init.credentials,"same-origin");assert.equal(init.redirect,"error");
    assert.equal(init.headers["x-lumi-target-protocol"],"1");
    assert.deepEqual(JSON.parse(init.body),cmd);
    return response({ok:true,taskId:cmd.taskId},201);
  }),"saved");
  assert.equal(await sendPrivateTaskCreate(cmd,signal,
    async()=>response({ok:true,taskId:cmd.taskId,replayed:true},200)),"saved");
  for(const bad of [
    response({ok:true,taskId:cmd.taskId,title:"leak"},201),
    response({ok:true,taskId:cmd.taskId,replayed:false},200),
    response({error:"busy"},503),
    new Response('{"ok":true}',{status:201,headers:{"content-type":"application/json"}}),
  ])assert.equal(await sendPrivateTaskCreate(cmd,signal,async()=>bad),"uncertain");
  assert.equal(await recoverPrivateTaskCreate(cmd,signal,async(url,init)=>{
    assert.equal(url,"/api/target-staging/tasks/create-status");
    assert.deepEqual(JSON.parse(init.body),cmd,"recovery must supply full exact command");
    return response({status:"committed"});
  }),"committed");
  assert.equal(await recoverPrivateTaskCreate(cmd,signal,
    async()=>response({status:"not_recorded"})),"not_recorded");
  assert.equal(await recoverPrivateTaskCreate(cmd,signal,
    async()=>response({status:"committed",title:cmd.title})),"unavailable");
  assert.equal(await recoverPrivateTaskCreate(cmd,signal,
    async()=>response({error:"Not found"},404)),"denied");
});
test("tab marker stores only opaque commandId and auth generation, never private payload",async()=>{
  await withStorage(async store=>{
    const first=command(),another=command();
    assert.deepEqual(privateTaskCreateMarker(generation),{kind:"clear"});
    assert.equal(reservePrivateTaskCreate(generation,first.commandId),true);
    assert.equal(reservePrivateTaskCreate(generation,another.commandId),false);
    const serialized=store.toString();
    assert.ok(serialized.includes(first.commandId));
    for(const secret of [first.title,first.areaId,first.taskId,first.restoreGeneration])
      assert.equal(serialized.includes(secret),false);
    assert.equal(confirmPrivateTaskCreate("B".repeat(43),first.commandId),false);
    assert.equal(privateTaskCreateMarker("B".repeat(43)).kind,"blocked");
    assert.equal(confirmPrivateTaskCreate(generation,first.commandId),true);
    assert.equal(privateTaskCreateMarker(generation).kind,"clear");
  });
});
test("runtime preserves exact payload only in memory; no second POST after uncertainty",async()=>{
  await withStorage(async store=>{
    const runtime={known:()=>true,generation:()=>generation,register:()=>()=>{}};
    const cmd=command();
    let posts=0;
    assert.equal(await runPrivateTaskCreate(runtime,generation,cmd,
      async()=>{posts++;return "uncertain";}),"uncertain");
    assert.equal(posts,1);
    assert.deepEqual(trackedPrivateTaskCreate(runtime,generation),
      {phase:"uncertain",commandId:cmd.commandId});
    assert.equal(await runPrivateTaskCreate(runtime,generation,command(),
      async()=>{posts++;return "saved";}),"conflict");
    assert.equal(posts,1);
    assert.equal(await checkPrivateTaskCreate(runtime,generation,new AbortController().signal,
      async exact=>{
        assert.deepEqual(exact,cmd);
        return "not_recorded";
      }),"not_recorded");
    assert.equal(privateTaskCreateMarker(generation).kind,"blocked");
    assert.equal(await checkPrivateTaskCreate(runtime,generation,new AbortController().signal,
      async exact=>{assert.deepEqual(exact,cmd);return "committed";}),"committed");
    assert.equal(privateTaskCreateMarker(generation).kind,"clear");
    assert.equal(trackedPrivateTaskCreate(runtime,generation),null);
    assert.equal(store.toString().includes(cmd.title),false);
    assert.equal(await runPrivateTaskCreate(runtime,generation,command(),
      async()=>{posts++;return "saved";}),"saved");
    assert.equal(posts,2);
  });
});
test("after reload without original title, marker blocks all replacement commands",async()=>{
  await withStorage(async ()=>{
    const cmd=command();
    assert.equal(reservePrivateTaskCreate(generation,cmd.commandId),true);
    const runtime={known:()=>true,generation:()=>generation,register:()=>()=>{}};
    let posts=0;
    assert.equal(await checkPrivateTaskCreate(runtime,generation,
      new AbortController().signal),"unavailable");
    assert.equal(await runPrivateTaskCreate(runtime,generation,command(),
      async()=>{posts++;return "saved";}),"conflict");
    assert.equal(posts,0);
    assert.equal(privateTaskCreateMarker(generation).kind,"blocked");
  });
});
