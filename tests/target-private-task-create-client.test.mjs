import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {sendPrivateTaskCreate,recoverPrivateTaskCreate,
  validPrivateTaskCreateCommand} from "../lib/target-private-task-create-client.ts";
import {privateTaskCreateMarker,reservePrivateTaskCreate,
  confirmPrivateTaskCreate} from "../lib/target-private-task-create-reload.ts";
import {runPrivateTaskCreate,trackedPrivateTaskCreate,
  checkPrivateTaskCreate,subscribePrivateTaskCreate,hasPrivateTaskCreateCompletion,
  consumePrivateTaskCreateCompletion,subscribePrivateTaskCreateCompletion} from "../lib/target-private-task-create-coordinator.ts";
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
    assert.equal(await runPrivateTaskCreate(runtime,generation,{...cmd,title:" invalid "},
      async()=>{posts++;return "saved";}),"conflict");
    assert.equal(privateTaskCreateMarker(generation).kind,"clear");
    assert.equal(posts,0);
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

test("late successful POST is delivered after modal unmount, once, without a draft",async()=>{
  await withStorage(async store=>{
    const runtime={known:()=>true,generation:()=>generation,register:()=>()=>{}};
    const cmd=command();
    let finishRequest;
    const delayed=new Promise(resolve=>{finishRequest=resolve;});
    const completions=[];
    // Always-mounted root listener remains after the task modal is gone.
    const unsubscribeRoot=subscribePrivateTaskCreateCompletion(runtime,
      ()=>completions.push(hasPrivateTaskCreateCompletion(runtime,generation)));
    const inflight=runPrivateTaskCreate(runtime,generation,cmd,
      async()=>{await delayed;return "saved";});
    let modalEvents=0;
    const unsubscribeModal=subscribePrivateTaskCreate(runtime,generation,
      ()=>modalEvents++);
    // Closing the editor unsubscribes its listener, not the runtime-owned POST.
    unsubscribeModal();
    assert.equal(hasPrivateTaskCreateCompletion(runtime,generation),false);
    finishRequest();
    assert.equal(await inflight,"saved");
    assert.deepEqual(completions,[true],"root receives late verified success");
    assert.equal(modalEvents,0,"unmounted task editor cannot receive events");
    assert.equal(hasPrivateTaskCreateCompletion(runtime,generation),true);
    assert.equal(consumePrivateTaskCreateCompletion(runtime,generation),true);
    assert.equal(consumePrivateTaskCreateCompletion(runtime,generation),false,
      "completion is consumed exactly once");
    assert.equal(store.toString().includes(cmd.title),false);
    assert.equal(privateTaskCreateMarker(generation).kind,"clear");
    unsubscribeRoot();
  });
});
test("acknowledged CREATE delivered after root listener mounts late",async()=>{
  await withStorage(async ()=>{
    const runtime={known:()=>true,generation:()=>generation,register:()=>()=>{}};
    assert.equal(await runPrivateTaskCreate(runtime,generation,command(),
      async()=> "saved"),"saved");
    assert.equal(hasPrivateTaskCreateCompletion(runtime,generation),true);
    let deliveries=0;
    const unsub=subscribePrivateTaskCreateCompletion(runtime,()=>deliveries++);
    assert.equal(deliveries,0,"observer can probe an already buffered completion");
    assert.equal(consumePrivateTaskCreateCompletion(runtime,generation),true);
    assert.equal(consumePrivateTaskCreateCompletion(runtime,generation),false);
    unsub();
  });
});
test("committed receipt never unlocks or notifies when storage removal fails",async()=>{
  await withStorage(async store=>{
    const runtime={known:()=>true,generation:()=>generation,register:()=>()=>{}};
    const cmd=command();
    let notifications=0;
    const un=subscribePrivateTaskCreateCompletion(runtime,()=>notifications++);
    assert.equal(await runPrivateTaskCreate(runtime,generation,cmd,
      async()=> "uncertain"),"uncertain");
    const realRemove=store.removeItem;
    store.removeItem=()=>{throw Error("sessionStorage unavailable");};
    assert.equal(await checkPrivateTaskCreate(runtime,generation,
      new AbortController().signal,async()=> "committed"),"unavailable");
    assert.deepEqual(privateTaskCreateMarker(generation),
      {kind:"blocked",commandId:cmd.commandId});
    assert.equal(hasPrivateTaskCreateCompletion(runtime,generation),false);
    assert.equal(notifications,0);
    store.removeItem=realRemove;
    assert.equal(await checkPrivateTaskCreate(runtime,generation,
      new AbortController().signal,async()=> "committed"),"committed");
    assert.equal(notifications,1);
    assert.equal(consumePrivateTaskCreateCompletion(runtime,generation),true);
    un();
  });
});
test("identity rotation during receipt reconciliation cannot deliver or clear marker",async()=>{
  await withStorage(async ()=>{
    let gen=generation;
    const runtime={known:()=>true,generation:()=>gen,register:()=>()=>{}};
    const cmd=command();
    assert.equal(await runPrivateTaskCreate(runtime,generation,cmd,
      async()=> "uncertain"),"uncertain");
    gen="B".repeat(43);
    assert.equal(await checkPrivateTaskCreate(runtime,generation,
      new AbortController().signal,async()=> "committed"),"unavailable");
    assert.equal(hasPrivateTaskCreateCompletion(runtime,generation),false);
    assert.deepEqual(privateTaskCreateMarker(gen),
      {kind:"blocked",commandId:cmd.commandId});
    gen=generation;
    assert.equal(await checkPrivateTaskCreate(runtime,generation,
      new AbortController().signal,async()=> "committed"),"committed");
    assert.equal(consumePrivateTaskCreateCompletion(runtime,generation),true);
  });
});
test("task completion hook is separate from unmounted editor and defers while hidden",async()=>{
  const {readFileSync}=await import("node:fs");
  const {fileURLToPath}=await import("node:url");
  const {resolve}=await import("node:path");
  const src=path=>readFileSync(resolve(fileURLToPath(new URL("..",import.meta.url)),path),"utf8");
  const root=src("app/ui/lumi-app-root.tsx");
  const bridge=src("app/ui/target-private-task-completion.tsx");
  const editor=src("app/ui/target-private-task-creator.tsx");
  assert.match(root,/taskCapture&&<TargetPrivateTaskCompletion/);
  assert.match(root,/taskCreatedNotice/);
  assert.match(root,/if\(!areaChooserOpen\|\|captureKind!=="task"\)return;/);
  assert.doesNotMatch(editor,/onCreated\(/,"modal must not own final success notification");
  assert.match(bridge,/runtime\.refresh\(\)/,"fresh session verification required");
  assert.match(bridge,/document\.visibilityState!=="visible"\|\|!navigator\.onLine/);
  assert.match(bridge,/consumePrivateTaskCreateCompletion/);
});
