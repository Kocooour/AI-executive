import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {
  noteEditReloadMarker,reserveNoteEditReload,confirmNoteEditReload,rejectFreshNoteEditReload,
} from "../lib/target-note-edit-reload.ts";
import {
  recoverNoteEditAfterReload,NOTE_EDIT_RECOVERY_TIMEOUT_MS,
} from "../lib/target-note-reload-status-client.ts";
import {
  forgetTrackedNoteEdit,runTrackedNoteEdit,subscribeTrackedNoteEdit,trackedNoteEdit,
} from "../lib/target-note-edit-recovery.ts";
import {saveNoteEdit} from "../lib/target-staging-note-edit-client.ts";
import {NOTE_EDIT_COMMAND_HEADER,stampNoteEditPrecommit}
  from "../lib/target-note-edit-precommit.ts";

const A="A".repeat(43),B="B".repeat(43);
const id="4c977f1a-f9e8-4b6c-b2a8-53818c6c471e";
const other="4b977f1a-f9e8-4b6c-b2a8-53818c6c471e";
const data=new Map();
const storage={
  getItem:key=>data.has(key)?data.get(key):null,
  setItem:(key,val)=>data.set(key,String(val)),
  removeItem:key=>data.delete(key),
};
Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:storage});
const headers={"content-type":"application/json","cache-control":"no-store"};
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
const preCommitReply=(value,status)=>stampNoteEditPrecommit(
  new Request("https://lumi.test/",{headers:{[NOTE_EDIT_COMMAND_HEADER]:id}}),
  reply(value,status));

const noteId="note-in-edit";
const command={
  commandId:id,expectedRevision:"a".repeat(64),
  restoreGeneration:"88d20aae-362c-4e28-a547-90ec9db5a31e",
  writeAreaId:"private-area",title:"Private title",body:"Private content",
};
function fakeRuntime(){
  let generation=A,known=true;
  const disposables=new Set();
  const disposeAll=()=>{
    const entries=[...disposables];
    disposables.clear();
    for(const item of entries)item.dispose();
  };
  return {
    generation:()=>generation,
    known:()=>known,
    register:(item)=>{
      if(!known){item.dispose();return ()=>{};}
      disposables.add(item);
      return ()=>disposables.delete(item);
    },
    rotate:(value)=>{generation=value;disposeAll();},
    signOut:()=>{known=false;generation="unknown-revoked";disposeAll();},
  };
}

test("detached editor: first definitive 409 clears its tab marker in runtime coordinator",async()=>{
  data.clear();
  const runtime=fakeRuntime();
  assert.equal(reserveNoteEditReload(A,id),true);
  let finish;
  const detach=subscribeTrackedNoteEdit(runtime,A,noteId,()=>{});
  const flight=runTrackedNoteEdit(runtime,A,noteId,command,
    async()=>await new Promise(resolve=>{finish=resolve;}));
  await Promise.resolve();
  assert.equal(typeof finish,"function");
  assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
  detach(); // original editor gone BEFORE the server's 409
  finish({outcome:"conflict"});
  assert.deepEqual(await flight,{outcome:"conflict"});
  assert.equal(trackedNoteEdit(runtime,A,noteId).phase,"conflict");
  assert.deepEqual(noteEditReloadMarker(A),{kind:"clear"},
    "coordinator must clear marker without any mounted inspector");
  forgetTrackedNoteEdit(runtime,A,noteId); // user discards stale conflict UI
  assert.equal(reserveNoteEditReload(A,other),true,
    "a definitive first rejection must not block editing another note");
  const next={...command,commandId:other};
  assert.deepEqual(await runTrackedNoteEdit(runtime,A,"another-note",next,
    async()=>({outcome:"saved",replayed:false})),{outcome:"saved",replayed:false});
  assert.deepEqual(noteEditReloadMarker(A),{kind:"clear"});
});

test("detached editor: first pre-commit refusal releases the exact marker",async()=>{
  data.clear();
  const runtime=fakeRuntime();
  assert.equal(reserveNoteEditReload(A,id),true);
  let finish;
  const detach=subscribeTrackedNoteEdit(runtime,A,noteId,()=>{});
  const flight=runTrackedNoteEdit(runtime,A,noteId,command,
    (id,cmd,signal)=>saveNoteEdit(id,cmd,signal,
      async()=>await new Promise(resolve=>{finish=resolve;})));
  await Promise.resolve();
  detach();
  finish(preCommitReply({error:"Cross-origin request rejected"},403));
  assert.deepEqual(await flight,{outcome:"denied",rejectedBeforeCommit:true});
  assert.deepEqual(noteEditReloadMarker(A),{kind:"clear"});
  forgetTrackedNoteEdit(runtime,A,noteId);
  assert.equal(reserveNoteEditReload(A,other),true);
  data.clear();
});

test("an intermediary 403/404 after a possible commit never releases the marker",async()=>{
  for(const status of [403,404,400,409]){
    data.clear();
    const runtime=fakeRuntime();
    assert.equal(reserveNoteEditReload(A,id),true);
    const flight=runTrackedNoteEdit(runtime,A,noteId,command,
      (note,cmd,signal)=>saveNoteEdit(note,cmd,signal,
        async()=>reply({error:"Not found"},status)));
    assert.deepEqual(await flight,{outcome:"uncertain"});
    assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
    assert.equal(reserveNoteEditReload(A,other),false);
  }
  data.clear();
});

test("an ambiguous 401 and a refusal after an uncertain PATCH retain the marker",async()=>{
  for(const first of [
    {outcome:"denied"},
    {outcome:"uncertain"},
  ]){
    data.clear();
    const runtime=fakeRuntime();
    assert.equal(reserveNoteEditReload(A,id),true);
    assert.deepEqual(await runTrackedNoteEdit(runtime,A,noteId,command,
      async()=>first),first);
    if(first.outcome==="uncertain"){
      assert.deepEqual(await runTrackedNoteEdit(runtime,A,noteId,command,
        async()=>({outcome:"denied",rejectedBeforeCommit:true})),
      {outcome:"denied",rejectedBeforeCommit:true});
    }
    assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
    assert.equal(reserveNoteEditReload(A,other),false);
  }
  data.clear();
});

test("detached editor: first successful PATCH also clears only its exact tab marker",async()=>{
  data.clear();
  const runtime=fakeRuntime();
  assert.equal(reserveNoteEditReload(A,id),true);
  let finish;
  const detach=subscribeTrackedNoteEdit(runtime,A,noteId,()=>{});
  const flight=runTrackedNoteEdit(runtime,A,noteId,command,
    async()=>await new Promise(resolve=>{finish=resolve;}));
  await Promise.resolve();
  detach();
  finish({outcome:"saved",replayed:false});
  assert.deepEqual(await flight,{outcome:"saved",replayed:false});
  assert.deepEqual(noteEditReloadMarker(A),{kind:"clear"});
});

test("uncertain first PATCH then retry conflict leaves UUID barrier intact after unmount",async()=>{
  data.clear();
  const runtime=fakeRuntime();
  assert.equal(reserveNoteEditReload(A,id),true);
  assert.deepEqual(await runTrackedNoteEdit(runtime,A,noteId,command,
    async()=>({outcome:"uncertain"})),{outcome:"uncertain"});
  const detach=subscribeTrackedNoteEdit(runtime,A,noteId,()=>{});
  detach();
  assert.deepEqual(await runTrackedNoteEdit(runtime,A,noteId,command,
    async()=>({outcome:"conflict"})),{outcome:"conflict"});
  assert.equal(trackedNoteEdit(runtime,A,noteId).phase,"conflict");
  assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id},
    "409 after uncertain PATCH does not prove that the earlier write failed");
  forgetTrackedNoteEdit(runtime,A,noteId);
  assert.equal(reserveNoteEditReload(A,other),false);
  data.clear();
});

test("timeout then late first-PATCH conflict never unlocks a new command",async()=>{
  data.clear();
  const runtime=fakeRuntime();
  assert.equal(reserveNoteEditReload(A,id),true);
  let finish;
  const first=runTrackedNoteEdit(runtime,A,noteId,command,
    async()=>await new Promise(resolve=>{finish=resolve;}),12);
  await Promise.resolve();
  assert.deepEqual(await first,{outcome:"uncertain"});
  finish({outcome:"conflict"}); // arrives after the timeout's uncertain result
  await Promise.resolve();
  assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
  assert.deepEqual(await runTrackedNoteEdit(runtime,A,noteId,command,
    async()=>({outcome:"conflict"})),{outcome:"conflict"});
  assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
  data.clear();
});

test("revoked old runtime cannot erase a newer generation's marker",async()=>{
  data.clear();
  const runtime=fakeRuntime();
  assert.equal(reserveNoteEditReload(A,id),true);
  let finish;
  const old=runTrackedNoteEdit(runtime,A,noteId,command,
    async()=>await new Promise(resolve=>{finish=resolve;}));
  await Promise.resolve();
  runtime.rotate(B); // old coordinator is disposed and request is aborted
  assert.deepEqual(noteEditReloadMarker(B),{kind:"clear"});
  assert.equal(reserveNoteEditReload(B,other),true);
  finish({outcome:"saved",replayed:false});
  assert.deepEqual(await old,{outcome:"denied"});
  await Promise.resolve();
  assert.deepEqual(noteEditReloadMarker(B),{kind:"blocked",commandId:other});
  data.clear();
});

test("only UUID and server generation survive a simulated reload; changed UUID cannot replace it",()=>{
  data.clear();
  assert.deepEqual(noteEditReloadMarker(A),{kind:"clear"});
  assert.equal(reserveNoteEditReload(A,id),true);
  assert.equal(reserveNoteEditReload(A,other),false);
  assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
  const payload=[...data.values()].map(x=>JSON.parse(x));
  assert.deepEqual(payload,[{generation:A,commandId:id}]);
  assert.equal(JSON.stringify(payload).includes("noteId"),false);
  assert.equal(JSON.stringify(payload).includes("body"),false);
  assert.equal(JSON.stringify(payload).includes("title"),false);
  assert.equal(reserveNoteEditReload(A,id),true);
  assert.equal(confirmNoteEditReload(A,other),false);
  assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
  assert.equal(confirmNoteEditReload(A,id),true);
  assert.deepEqual(noteEditReloadMarker(A),{kind:"clear"});
});

test("definitive first-PATCH rejection can release only its own UUID",()=>{
  data.clear();
  assert.equal(reserveNoteEditReload(A,id),true);
  assert.equal(rejectFreshNoteEditReload(A,other),false);
  assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
  assert.equal(rejectFreshNoteEditReload(A,id),true);
  assert.deepEqual(noteEditReloadMarker(A),{kind:"clear"});
});

test("verified generation rotation invalidates old marker without leaking command data",()=>{
  data.clear();
  assert.equal(reserveNoteEditReload(A,id),true);
  assert.deepEqual(noteEditReloadMarker("unknown-revoked"),{kind:"unavailable"});
  assert.deepEqual(noteEditReloadMarker(B),{kind:"clear"});
  assert.deepEqual(noteEditReloadMarker(A),{kind:"clear"});
  assert.equal(data.size,0);
});

test("invalid or forbidden storage fails closed; never converts unresolved write to a new one",()=>{
  data.clear();
  assert.equal(reserveNoteEditReload(A,id),true);
  const [key]=data.keys();
  data.set(key,"not-json");
  assert.deepEqual(noteEditReloadMarker(A),{kind:"unavailable"});
  assert.equal(reserveNoteEditReload(A,other),false);
  data.clear();
  const old=globalThis.sessionStorage;
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:{
    getItem:()=>{throw Error("permission denied");},
    setItem:()=>{throw Error("permission denied");},
    removeItem:()=>{throw Error("permission denied");},
  }});
  assert.deepEqual(noteEditReloadMarker(A),{kind:"unavailable"});
  assert.equal(reserveNoteEditReload(A,id),false);
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:old});
});

test("the recovery transport reads current writer's content-free receipt and never sends a PATCH",async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,method:options.method,body:options.body,cache:options.cache});
    return reply({status:"committed"});
  };
  const result=await recoverNoteEditAfterReload(id,new AbortController().signal,fetchImpl);
  assert.equal(result,"committed");
  assert.deepEqual(calls,[{
    url:"/api/target-staging/notes/edit-recovery",method:"POST",
    body:JSON.stringify({commandId:id}),cache:"no-store",
  }]);
});

test("not_recorded, denied and malformed success can never unlock the marker",async()=>{
  data.clear();reserveNoteEditReload(A,id);
  for(const [result,fetcher] of [
    ["not_recorded",async()=>reply({status:"not_recorded"})],
    ["denied",async()=>reply({error:"Not found"},404)],
    ["unavailable",async()=>reply({status:"other"})],
    ["unavailable",async()=>reply({status:"committed",body:"leak"})],
  ]){
    assert.equal(await recoverNoteEditAfterReload(id,new AbortController().signal,fetcher),result);
    assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
  }
  assert.equal(await recoverNoteEditAfterReload(id,new AbortController().signal,
    async()=>new Response("x".repeat(2000),{status:200,headers})), "unavailable");
  assert.deepEqual(noteEditReloadMarker(A),{kind:"blocked",commandId:id});
  data.clear();
});

test("a never-settling receipt fetch has a bounded timeout even if it ignores abort",async()=>{
  let signal;
  const start=Date.now();
  const result=await recoverNoteEditAfterReload(id,new AbortController().signal,
    async(_url,init)=>{signal=init.signal;return await new Promise(()=>{});},12);
  assert.equal(result,"unavailable");
  assert.equal(signal.aborted,true);
  assert.ok(Date.now()-start<2000);
  assert.equal(NOTE_EDIT_RECOVERY_TIMEOUT_MS,8_000);
});

test("UI wiring retains main shared detail and unrelated reads while only writes are blocked",()=>{
  const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
  const root=read("app/ui/lumi-app-root.tsx");
  const editor=read("app/ui/target-note-editor.tsx");
  const panel=read("app/ui/target-detail-panel.tsx");
  const recovery=read("lib/target-note-edit-recovery.ts");
  assert.match(root,/TargetDetailPanel/);
  assert.match(root,/targetNoteEdit/);
  assert.match(panel,/TargetNoteEditor/);
  assert.match(recovery,/TARGET_NOTE_EDIT_WRITE_TIMEOUT_MS=20_000/);
  assert.match(editor,/reserveNoteEditReload\(boundGeneration\.current,command\.commandId\)/);
  assert.match(editor,/recoverNoteEditAfterReload\(marker\.commandId,signal\.signal\)/);
  assert.match(editor,/confirmNoteEditReload\(boundGeneration\.current,marker\.commandId\)/);
  assert.match(recovery,/const firstDispatch=existing===undefined/);
  assert.match(recovery,/rejectFreshNoteEditReload\(generation,entry\.command\.commandId\)/);
  assert.doesNotMatch(editor,/freshCommand|ambiguousCommands|rejectFreshNoteEditReload/,
    "first result classification must outlive the unmounted editor");
  assert.doesNotMatch(panel,/noteEditReloadMarker/,"read-only detail is independent of write recovery");
});
