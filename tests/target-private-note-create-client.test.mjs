import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {validPrivateNoteCreateCommand,privateNoteCreatePreflight,
  sendPrivateNoteCreate,recoverPrivateNoteCreate} from
  "../lib/target-private-note-create-client.ts";
import {privateNoteCreateMarker,reservePrivateNoteCreate,
  confirmPrivateNoteCreate,confirmRecoveredPrivateNoteCreate} from "../lib/target-note-create-reload.ts";
import {runPrivateNoteCreate,trackedPrivateNoteCreate,
  releaseTrackedPrivateNoteCreate} from "../lib/target-private-note-create-coordinator.ts";
import {targetPrivateNoteCreateUiEnabled,TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS} from
  "../lib/target-private-note-create-ui-gate.ts";
import {TARGET_PRIVATE_NOTE_AREA_UI_FLAGS} from
  "../lib/target-private-note-area-ui-gate.ts";
const generation="A".repeat(43);
const header={"content-type":"application/json","cache-control":"no-store"};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:header});
const command=()=>({noteId:randomUUID(),commandId:randomUUID(),
  areaId:"private-personal",restoreGeneration:randomUUID(),
  title:"Soukromá",body:"Zápis pouze do vybrané Oblasti"});
const storage=()=>{
  const saved=new Map();
  return {getItem:k=>saved.get(k)??null,setItem:(k,v)=>{saved.set(k,v);},
    removeItem:k=>{saved.delete(k);},clear:()=>saved.clear(),toObject:()=>Object.fromEntries(saved)};
};
test("write UI gate is separately default-off and leaves pure Area preview usable",()=>{
  const all=Object.fromEntries([...TARGET_PRIVATE_NOTE_AREA_UI_FLAGS,
    ...TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS].map(k=>[k,"true"]));
  assert.equal(targetPrivateNoteCreateUiEnabled(all),true);
  for(const flag of TARGET_PRIVATE_NOTE_CREATE_UI_FLAGS){
    assert.equal(targetPrivateNoteCreateUiEnabled({...all,[flag]:undefined}),false);
  }
  assert.equal(targetPrivateNoteCreateUiEnabled({...all,
    AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_CREATE_ENABLED:"false"}),false);
});
test("strict create payload, preflight and receipt never accept unexpected data",async()=>{
  const cmd=command(),signal=new AbortController().signal;
  assert.equal(validPrivateNoteCreateCommand(cmd),true);
  assert.equal(validPrivateNoteCreateCommand({...cmd,projectId:"shared"}),false);
  assert.equal(validPrivateNoteCreateCommand({...cmd,title:""}),false);
  assert.equal(validPrivateNoteCreateCommand({...cmd,restoreGeneration:"bad"}),false);
  const preview=await privateNoteCreatePreflight(cmd.areaId,signal,async(url,opts)=>{
    assert.equal(url,"/api/target-staging/notes/create-preview");
    assert.equal(opts.method,"POST");assert.equal(opts.cache,"no-store");
    assert.equal(opts.credentials,"same-origin");assert.equal(opts.redirect,"error");
    assert.equal(opts.headers["x-lumi-target-protocol"],"1");
    assert.deepEqual(JSON.parse(opts.body),{areaId:cmd.areaId});
    return response({restoreGeneration:cmd.restoreGeneration});
  });
  assert.deepEqual(preview,{ok:true,restoreGeneration:cmd.restoreGeneration});
  assert.deepEqual(await privateNoteCreatePreflight(cmd.areaId,signal,
    async()=>response({restoreGeneration:cmd.restoreGeneration,owner:"private"})),
    {ok:false,reason:"unavailable"});
  assert.equal(await sendPrivateNoteCreate(cmd,signal,async(url,opts)=>{
    assert.equal(url,"/api/target-staging/notes");
    assert.equal(opts.method,"POST");
    assert.deepEqual(JSON.parse(opts.body),cmd);
    return response({ok:true,noteId:cmd.noteId},201);
  }),"saved");
  assert.equal(await sendPrivateNoteCreate(cmd,signal,
    async()=>response({ok:true,noteId:cmd.noteId,replayed:true},200)),"saved");
  assert.equal(await sendPrivateNoteCreate(cmd,signal,
    async()=>response({ok:true,noteId:cmd.noteId,body:"leak"},201)),"uncertain");
  assert.equal(await sendPrivateNoteCreate(cmd,signal,
    async()=>response({error:"Staging unavailable"},503)),"uncertain");
  assert.equal(await recoverPrivateNoteCreate(cmd.commandId,signal,
    async()=>response({status:"not_recorded"})),"not_recorded");
  assert.equal(await recoverPrivateNoteCreate(cmd.commandId,signal,
    async()=>response({status:"committed"})),"committed");
  assert.equal(await recoverPrivateNoteCreate(cmd.commandId,signal,
    async()=>response({status:"committed",noteId:cmd.noteId})),"unavailable");
  assert.equal(await recoverPrivateNoteCreate(cmd.commandId,signal,
    async()=>response({error:"session_revoked"},401)),"denied");
});
test("tab marker stores ONLY exact opaque UUID and generation; no new command after ambiguity",()=>{
  const prior=globalThis.sessionStorage;const store=storage();
  globalThis.sessionStorage=store;
  try{
    const first=command(),second=command();
    assert.deepEqual(privateNoteCreateMarker(generation),{kind:"clear"});
    assert.equal(reservePrivateNoteCreate(generation,first.commandId),true);
    assert.equal(reservePrivateNoteCreate(generation,second.commandId),false);
    assert.equal(reservePrivateNoteCreate(generation,first.commandId),true);
    const data=JSON.stringify(store.toObject());
    assert.ok(data.includes(first.commandId));
    assert.equal(data.includes(first.title),false);
    assert.equal(data.includes(first.body),false);
    assert.equal(data.includes(first.areaId),false);
    assert.equal(data.includes(first.noteId),false);
    assert.deepEqual(privateNoteCreateMarker(generation),
      {kind:"blocked",commandId:first.commandId});
    assert.equal(confirmPrivateNoteCreate(generation,second.commandId),false);
    assert.equal(confirmPrivateNoteCreate(generation,first.commandId),true);
    assert.deepEqual(privateNoteCreateMarker(generation),{kind:"clear"});
    assert.equal(reservePrivateNoteCreate(generation,second.commandId),true);
    const other="B".repeat(43);
    assert.deepEqual(privateNoteCreateMarker(other),
      {kind:"blocked",commandId:second.commandId},
      "an in-flight CREATE may commit after session rotation");
    assert.equal(reservePrivateNoteCreate(other,command().commandId),false);
    assert.equal(confirmPrivateNoteCreate(other,second.commandId),false);
    assert.equal(confirmRecoveredPrivateNoteCreate(other,randomUUID()),false);
    assert.equal(confirmRecoveredPrivateNoteCreate(other,second.commandId),true);
    assert.equal(privateNoteCreateMarker(other).kind,"clear");
  }finally{if(prior===undefined)delete globalThis.sessionStorage;
    else globalThis.sessionStorage=prior;}
});
test("runtime coordinator survives owner UI unmount, clears positive receipt, never retries uncertain request",async()=>{
  const prior=globalThis.sessionStorage;globalThis.sessionStorage=storage();
  let dispose=null;
  const runtime={known:()=>true,generation:()=>generation,
    register:x=>{dispose=x.dispose;return ()=>{dispose=null;}}};
  try{
    let release,posts=0;
    const delayed=new Promise(resolve=>{release=resolve;});
    const first=command();
    const pending=runPrivateNoteCreate(runtime,generation,first,async()=>{
      posts++;await delayed;return "saved";
    });
    assert.deepEqual(privateNoteCreateMarker(generation),
      {kind:"blocked",commandId:first.commandId});
    assert.equal(await runPrivateNoteCreate(runtime,generation,command(),
      async()=>{posts++;return "saved";}),"conflict");
    assert.equal(posts,1);
    release();
    assert.equal(await pending,"saved");
    assert.equal(privateNoteCreateMarker(generation).kind,"clear");
    assert.equal(trackedPrivateNoteCreate(runtime,generation),null);
    assert.equal(posts,1);
    const second=command();
    assert.equal(await runPrivateNoteCreate(runtime,generation,second,
      async()=>{posts++;return "uncertain";}),"uncertain");
    assert.equal(privateNoteCreateMarker(generation).kind,"blocked");
    releaseTrackedPrivateNoteCreate(runtime,generation,second.commandId);
    assert.equal(await runPrivateNoteCreate(runtime,generation,command(),
      async()=>{posts++;return "saved";}),"conflict");
    assert.equal(posts,2);
    dispose?.();
  }finally{if(prior===undefined)delete globalThis.sessionStorage;
    else globalThis.sessionStorage=prior;}
});

test("an ambiguous CREATE stays blocked after authentication rotation",async()=>{
  const original=globalThis.sessionStorage;globalThis.sessionStorage=storage();
  const first=command(),other="B".repeat(43);
  const runtime=gen=>({known:()=>true,generation:()=>gen,register:()=>()=>{}});
  try{
    assert.equal(await runPrivateNoteCreate(runtime(generation),generation,first,
      async()=> "uncertain"),"uncertain");
    assert.deepEqual(privateNoteCreateMarker(other),
      {kind:"blocked",commandId:first.commandId});
    let posts=0;
    assert.equal(await runPrivateNoteCreate(runtime(other),other,command(),
      async()=>{posts++;return "saved";}),"conflict");
    assert.equal(posts,0);
    const signal=new AbortController().signal;
    for(const reply of [
      response({status:"not_recorded"}),
      response({error:"Not found"},404),
      response({error:"session_revoked"},401),
    ]){
      assert.notEqual(await recoverPrivateNoteCreate(first.commandId,signal,
        async()=>reply),"committed");
      assert.equal(privateNoteCreateMarker(other).kind,"blocked");
    }
    assert.equal(await recoverPrivateNoteCreate(first.commandId,signal,
      async()=>response({status:"committed"})),"committed");
    assert.equal(confirmRecoveredPrivateNoteCreate(other,first.commandId),true);
    assert.equal(privateNoteCreateMarker(other).kind,"clear");
    assert.equal(await runPrivateNoteCreate(runtime(other),other,command(),
      async()=>{posts++;return "saved";}),"saved");
    assert.equal(posts,1);
  }finally{if(original===undefined)delete globalThis.sessionStorage;
    else globalThis.sessionStorage=original;}
});
