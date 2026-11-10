import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {
  noteEditReloadMarker,reserveNoteEditReload,confirmNoteEditReload,
} from "../lib/target-note-edit-reload.ts";
import {
  recoverNoteEditAfterReload,NOTE_EDIT_RECOVERY_TIMEOUT_MS,
} from "../lib/target-note-reload-status-client.ts";

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
  assert.doesNotMatch(panel,/noteEditReloadMarker/,"read-only detail is independent of write recovery");
});
