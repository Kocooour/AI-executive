import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {validPrivateTaskAreaId,validPrivateTaskTitle,validPrivateTaskCreateCommand,
  sendPrivateTaskCreate,checkPrivateTaskCreateReceipt} from
  "../lib/target-private-task-create-client.ts";
import {privateTaskCreateMarker,reservePrivateTaskCreate,
  runPrivateTaskCreate,trackedPrivateTaskCreate,checkTrackedPrivateTaskCreate}
  from "../lib/target-private-task-create-coordinator.ts";
import {TARGET_PRIVATE_TASK_CREATE_UI_FLAGS,targetPrivateTaskCreateUiEnabled}
  from "../lib/target-private-task-create-ui-gate.ts";
import {TARGET_PRIVATE_NOTE_AREA_UI_FLAGS}
  from "../lib/target-private-note-area-ui-gate.ts";
import {TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS}
  from "../lib/target-private-note-create-ui-gate.ts";

const gen="A".repeat(43);
const headers={"content-type":"application/json","cache-control":"no-store"};
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers});
const command=()=>({
  taskId:randomUUID(),commandId:randomUUID(),areaId:"area-private",
  restoreGeneration:randomUUID(),title:"Soukromý úkol",
});
const mockStorage=()=>{
  const data=new Map();
  return {getItem:k=>data.get(k)??null,setItem:(k,v)=>{data.set(k,v);},
    removeItem:k=>{data.delete(k);},data};
};
function withStorage(fn){
  const old=globalThis.sessionStorage;const storage=mockStorage();
  globalThis.sessionStorage=storage;
  const done=()=>{if(old===undefined)delete globalThis.sessionStorage;
    else globalThis.sessionStorage=old;};
  try{
    const result=fn(storage);
    if(result&&typeof result.then==="function")return result.finally(done);
    done();return result;
  }catch(error){done();throw error;}
}
const runtime=(generation=gen)=>({
  known:()=>true,generation:()=>generation,register:()=>()=>{},
});
test("R3-FE-6 task UI is default-off and requires every existing private Area/notes transport gate",()=>{
  const enabled=Object.fromEntries([...TARGET_PRIVATE_NOTE_AREA_UI_FLAGS,
    ...TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS,
    ...TARGET_PRIVATE_TASK_CREATE_UI_FLAGS].map(k=>[k,"true"]));
  assert.equal(targetPrivateTaskCreateUiEnabled({}),false);
  assert.equal(targetPrivateTaskCreateUiEnabled(enabled),true);
  for(const name of Object.keys(enabled)){
    assert.equal(targetPrivateTaskCreateUiEnabled({...enabled,[name]:undefined}),false,name);
    assert.equal(targetPrivateTaskCreateUiEnabled({...enabled,[name]:"TRUE"}),false,name);
  }
  assert.equal(targetPrivateTaskCreateUiEnabled({...enabled,
    AI_EXECUTIVE_TARGET_STAGING_HTTP_TASKS_CREATE_ENABLED:"true",
    AI_EXECUTIVE_TARGET_UI_PRIVATE_TASK_CREATE_ENABLED:"false"}),false);
});
test("task wire accepts exact 201/200 and content-free receipt; rejects malformed/extra responses",async()=>{
  const cmd=command(),signal=new AbortController().signal;
  assert.equal(validPrivateTaskCreateCommand(cmd),true);
  assert.equal(validPrivateTaskAreaId(cmd.areaId),true);
  assert.equal(validPrivateTaskAreaId("bad area"),false);
  assert.equal(validPrivateTaskCreateCommand({...cmd,projectId:"x"}),false);
  assert.equal(validPrivateTaskCreateCommand({...cmd,taskId:cmd.taskId.toUpperCase()}),false);
  assert.equal(validPrivateTaskCreateCommand({...cmd,title:" x "}),false);
  assert.equal(validPrivateTaskTitle("hello\nworld"),false);
  assert.equal(validPrivateTaskTitle("a".repeat(4097)),false);
  let posts=0;
  assert.equal(await sendPrivateTaskCreate(cmd,signal,async(url,options)=>{
    posts++;
    assert.equal(url,"/api/target-staging/tasks");
    assert.equal(options.method,"POST");
    assert.equal(options.credentials,"same-origin");
    assert.equal(options.redirect,"error");
    assert.equal(options.cache,"no-store");
    assert.equal(options.headers["x-lumi-target-protocol"],"1");
    assert.deepEqual(JSON.parse(options.body),cmd);
    return json({ok:true,taskId:cmd.taskId},201);
  }),"saved");
  assert.equal(await sendPrivateTaskCreate(cmd,signal,
    async()=>json({ok:true,taskId:cmd.taskId,replayed:true},200)),"saved");
  for(const bad of [
    json({ok:true,taskId:cmd.taskId,actor:"foreign"},201),
    json({ok:true,taskId:randomUUID()},201),
    json({ok:true,taskId:cmd.taskId,replayed:false},200),
    json({error:"conflict"},409),
    json({error:"Not found"},404),
    new Response("<html>redirect</html>",{status:200,headers:{"content-type":"text/html"}}),
  ])assert.equal(await sendPrivateTaskCreate(cmd,signal,async()=>bad),"uncertain");
  assert.equal(posts,1,"CREATE is not automatically retried");
  assert.equal(await checkPrivateTaskCreateReceipt(cmd,signal,async(url,options)=>{
    assert.equal(url,"/api/target-staging/tasks/create-status");
    assert.deepEqual(JSON.parse(options.body),cmd,
      "the ENTIRE original command must be provided for digest verification");
    return json({status:"committed"});
  }),"committed");
  assert.equal(await checkPrivateTaskCreateReceipt(cmd,signal,
    async()=>json({status:"not_recorded"})),"not_recorded");
  assert.equal(await checkPrivateTaskCreateReceipt(cmd,signal,
    async()=>json({status:"committed",taskId:cmd.taskId})),"unavailable");
  assert.equal(await checkPrivateTaskCreateReceipt(cmd,signal,
    async()=>json({error:"unauthorized"},401)),"denied");
  assert.equal(await checkPrivateTaskCreateReceipt(cmd,signal,
    async()=>new Response(JSON.stringify({status:"committed"}),{status:200,
      headers:{"content-type":"application/json"}})),"unavailable");
});
test("tab stores opaque UUID only; no title, Area or restore token; generation rotation cannot release it",()=>withStorage(storage=>{
  const cmd=command();
  assert.deepEqual(privateTaskCreateMarker(gen),{kind:"clear"});
  assert.equal(reservePrivateTaskCreate(gen,cmd.commandId),true);
  assert.equal(reservePrivateTaskCreate(gen,randomUUID()),false);
  const raw=JSON.stringify([...storage.data]);
  assert.ok(raw.includes(cmd.commandId));
  for(const secret of [cmd.title,cmd.areaId,cmd.taskId,cmd.restoreGeneration])
    assert.equal(raw.includes(secret),false,secret);
  assert.deepEqual(privateTaskCreateMarker("B".repeat(43)),
    {kind:"blocked",commandId:cmd.commandId});
}));
test("uncertain POST remains blocked after not_recorded, clears ONLY on an exact committed receipt",()=>withStorage(async()=>{
  const rt=runtime(),cmd=command();
  let posts=0,receiptCalls=0;
  assert.equal(await runPrivateTaskCreate(rt,gen,cmd,async()=>{
    posts++;return "uncertain";
  }),"uncertain");
  assert.equal(privateTaskCreateMarker(gen).kind,"blocked");
  assert.deepEqual(trackedPrivateTaskCreate(rt,gen),
    {phase:"uncertain",commandId:cmd.commandId});
  assert.equal(await runPrivateTaskCreate(rt,gen,command(),
    async()=>{posts++;return "saved";}),"blocked");
  const signal=new AbortController().signal;
  assert.equal(await checkTrackedPrivateTaskCreate(rt,gen,signal,async(original)=>{
    receiptCalls++;assert.deepEqual(original,cmd);return "not_recorded";
  }),"not_recorded");
  assert.equal(privateTaskCreateMarker(gen).kind,"blocked");
  assert.equal(await checkTrackedPrivateTaskCreate(rt,gen,signal,async(original)=>{
    receiptCalls++;assert.deepEqual(original,cmd);return "committed";
  }),"committed");
  assert.equal(privateTaskCreateMarker(gen).kind,"clear");
  assert.equal(trackedPrivateTaskCreate(rt,gen),null);
  assert.equal(posts,1);assert.equal(receiptCalls,2);
}));
test("reload loses private text yet keeps safe block; other generation has no receipt command",()=>withStorage(async()=>{
  const original=runtime(),cmd=command();
  assert.equal(await runPrivateTaskCreate(original,gen,cmd,
    async()=> "uncertain"),"uncertain");
  const newRuntime=runtime();
  assert.equal(await checkTrackedPrivateTaskCreate(newRuntime,gen,
    new AbortController().signal,async()=>{throw Error("must not fetch");}),
    "missing-command");
  assert.equal(privateTaskCreateMarker(gen).kind,"blocked");
  assert.equal(await runPrivateTaskCreate(runtime("B".repeat(43)),"B".repeat(43),command(),
    async()=> "saved"),"blocked");
}));
test("server success before modal unmount unlocks without a second POST",()=>withStorage(async()=>{
  const cmd=command(),rt=runtime();
  let resolve,posts=0;
  const pending=new Promise(r=>{resolve=r;});
  const create=runPrivateTaskCreate(rt,gen,cmd,async()=>{
    posts++;await pending;return "saved";
  });
  assert.equal(privateTaskCreateMarker(gen).kind,"blocked");
  resolve();
  assert.equal(await create,"saved");
  assert.equal(privateTaskCreateMarker(gen).kind,"clear");
  assert.equal(posts,1);
}));
test("main shell wiring preserves note-only default, no Search tab, distinct task consent and feedback",()=>{
  const root=readFileSync(new URL("../app/ui/lumi-app-root.tsx",import.meta.url),"utf8");
  const page=readFileSync(new URL("../app/page.tsx",import.meta.url),"utf8");
  const quick=readFileSync(new URL("../app/ui/target-private-quick-capture.tsx",import.meta.url),"utf8");
  const form=readFileSync(new URL("../app/ui/target-private-task-area-chooser.tsx",import.meta.url),"utf8");
  assert.match(page,/targetPrivateTaskCreateUiEnabled\(process\.env\)/);
  assert.match(root,/targetPrivateTaskCreate\s*\?\s*<TargetPrivateQuickCapture/);
  assert.match(root,/onClick=\{\(\)=>openAreaChooser\(false,"note"\)\}/);
  assert.match(root,/target-private-task-created/);
  assert.match(quick,/onClick=\{\(\)=>setKind\("task"\)\}/);
  assert.match(quick,/onClick=\{\(\)=>setKind\("note"\)\}/);
  assert.match(form,/privateNoteCreatePreflight\(selected\.id/);
  assert.match(form,/loadPrivateNoteAreaChoices\(/);
  assert.match(form,/flushSync\(hide\)/);
  assert.match(form,/checkTrackedPrivateTaskCreate\(/);
  assert.doesNotMatch(quick,/localStorage|IndexedDB/);
});
