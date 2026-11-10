import assert from "node:assert/strict";
import {test} from "node:test";
import {noteHash,noteIdFromHash} from "../lib/target-note-detail-navigation.ts";
import {preflightNoteEdit,patchNoteEdit,statusNoteEdit,recoverNoteEdit} from "../lib/target-note-edit-client.ts";
import {pendingNoteCommand,holdNoteCommand,clearNoteCommand,noteEditBlocked} from "../lib/target-note-pending-command.ts";

const headers={"content-type":"application/json","cache-control":"no-store"};
const proof={expectedRevision:"a".repeat(64),restoreGeneration:"88d20aae-362c-4e28-a547-90ec9db5a31e",writeAreaId:"private-area"};
const command={...proof,commandId:"4c977f1a-f9e8-4b6c-b2a8-53818c6c471e",title:"Edited",body:"Body"};
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
const genA="A".repeat(43),genB="B".repeat(43);
const tabData=new Map();
Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:{
  getItem:key=>tabData.has(key)?tabData.get(key):null,
  setItem:(key,value)=>tabData.set(key,String(value)),
  removeItem:key=>tabData.delete(key),
}});

test("note hash is only a strict selector and round-trips opaque IDs",()=>{
  assert.equal(noteIdFromHash(noteHash("my / note")),"my / note");
  for(const hash of ["#target-note=", "#target-note=%ZZ", "#target-note=..", "#target-note=id&scope=all"])
    assert.equal(noteIdFromHash(hash),null,hash);
});

test("edit uses one preflight, one PATCH and read-only reconciliation",async()=>{
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url,method:init.method,body:init.body,protocol:init.headers["x-lumi-target-protocol"]});
    if(init.method==="GET")return reply(proof);
    if(init.method==="PATCH")return reply({ok:true});
    return reply({status:"committed"});
  };
  const signal=new AbortController().signal;
  assert.deepEqual(await preflightNoteEdit("note-1",signal,fetcher),{ok:true,value:proof});
  assert.deepEqual(await patchNoteEdit("note-1",command,signal,fetcher),{ok:true,value:"committed"});
  assert.deepEqual(await statusNoteEdit("note-1",command,signal,fetcher),{ok:true,value:"committed"});
  assert.deepEqual(calls.map(x=>x.method),["GET","PATCH","POST"]);
  assert.equal(calls[0].body,undefined);
  assert.equal(calls[1].protocol,"1");
  assert.deepEqual(JSON.parse(calls[1].body),command);
  assert.equal(calls[2].url,"/api/target-staging/notes/note-1/edit/status");
});

test("failed or ambiguous PATCH is never retried by the transport",async()=>{
  let count=0;
  const fail=async()=>{count++;throw Error("connection lost");};
  assert.deepEqual(await patchNoteEdit("note-1",command,new AbortController().signal,fail),
    {ok:false,reason:"offline"});
  assert.equal(count,1);
  assert.deepEqual(await statusNoteEdit("note-1",command,new AbortController().signal,
    async()=>reply({status:"not_recorded"})),{ok:true,value:"not_recorded"});
  assert.deepEqual(await patchNoteEdit("note-1",command,new AbortController().signal,
    async()=>reply({error:"Revision conflict"},409)),{ok:false,reason:"stale"});
});

test("a pending command blocks later writes until reconciliation or verified generation change",()=>{
  assert.equal(holdNoteCommand(genA,"note-1",command),true);
  assert.equal(holdNoteCommand(genA,"note-2",{...command,commandId:"other"}),false);
  assert.equal(pendingNoteCommand(genA)?.noteId,"note-1");
  clearNoteCommand(genA,"wrong-id");
  assert.ok(pendingNoteCommand(genA));
  clearNoteCommand(genA,command.commandId);
  assert.equal(pendingNoteCommand(genA),null);
  assert.equal(holdNoteCommand(genA,"note-1",command),true);
  assert.equal(noteEditBlocked("unknown-local"),true);
  assert.equal(pendingNoteCommand(genB),null);
  assert.equal(noteEditBlocked(genB),false,"a verified new generation clears the old tab guard");
  assert.equal(holdNoteCommand(genB,"note-2",command),true);
  clearNoteCommand(genB,command.commandId);
  tabData.clear();
});

test("a reload retains only a content-free blocked marker, including not_recorded and 404",async()=>{
  assert.equal(holdNoteCommand(genA,"private-note",command),true);
  assert.deepEqual([...tabData.values()].map(x=>JSON.parse(x)),[{commandId:command.commandId,generation:genA}]);
  const fresh=await import("../lib/target-note-pending-command.ts?reload-guard-test");
  assert.equal(fresh.pendingNoteCommand(genA),null);
  assert.equal(fresh.lostNoteCommandId(genA),command.commandId);
  assert.equal(fresh.noteEditBlocked(genA),true);
  assert.equal(fresh.holdNoteCommand(genA,"private-note",command),false);
  assert.deepEqual(await recoverNoteEdit(command.commandId,new AbortController().signal,
    async()=>reply({status:"committed"})),{ok:true,value:"committed"});
  assert.deepEqual(await statusNoteEdit("private-note",command,new AbortController().signal,
    async()=>reply({status:"not_recorded"})),{ok:true,value:"not_recorded"});
  assert.deepEqual(await statusNoteEdit("private-note",command,new AbortController().signal,
    async()=>reply({error:"Not found"},404)),{ok:false,reason:"not-found"});
  assert.equal(noteEditBlocked(genA),true);
  fresh.clearRecoveredNoteCommand(genA,command.commandId);
  assert.equal(fresh.noteEditBlocked(genA),false);
  clearNoteCommand(genA,command.commandId);
});

test("edit transport rejects invalid and oversized successful bodies",async()=>{
  const signal=new AbortController().signal;
  assert.deepEqual(await preflightNoteEdit("note",signal,async()=>reply({...proof,actorId:"alice"})),
    {ok:false,reason:"invalid-response"});
  assert.deepEqual(await statusNoteEdit("note",command,signal,async()=>reply({status:"other"})),
    {ok:false,reason:"invalid-response"});
  assert.deepEqual(await preflightNoteEdit("note",signal,async()=>
    new Response(JSON.stringify(proof),{status:200,headers:{...headers,"content-length":"5000"}})),
    {ok:false,reason:"invalid-response"});
});
