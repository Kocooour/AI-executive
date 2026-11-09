import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  forgetTrackedNoteEdit,runTrackedNoteEdit,subscribeTrackedNoteEdit,trackedNoteEdit,
} from "../lib/target-note-edit-recovery.ts";

const gen="b7ab0e6e-d01f-44ed-babe-e9b69e84dbaa";
const id="1dbe798b-8ae4-46a8-98ae-51ac73dd31b8";
const command={
  commandId:"f3d18d63-9073-48f7-8d25-6c81f23b9a01",
  expectedRevision:"a".repeat(64),restoreGeneration:gen,
  writeAreaId:"private-area",title:"My note",body:"Private draft",
};
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("outstanding PATCH is owned by runtime, not detail unmount: lost ACK retains exact command",async()=>{
  const runtime={}; let release; let calls=0; const observed=[];
  const detach=subscribeTrackedNoteEdit(runtime,gen,id,()=>{
    observed.push(trackedNoteEdit(runtime,gen,id)?.phase??"cleared");
  });
  const send=async(_id,_command,_signal)=>{calls++;return await new Promise(r=>{release=r;});};
  const first=runTrackedNoteEdit(runtime,gen,id,command,send);
  const also=runTrackedNoteEdit(runtime,gen,id,command,send);
  assert.strictEqual(also,first,"a saving edit does not send a duplicate");
  await Promise.resolve();
  assert.equal(calls,1);
  assert.equal(trackedNoteEdit(runtime,gen,id).phase,"saving");
  detach(); // simulate inspector unmount, runtime/provider stays mounted
  release({outcome:"uncertain"}); // server already committed; its ACK was lost
  assert.deepEqual(await first,{outcome:"uncertain"});
  assert.deepEqual(trackedNoteEdit(runtime,gen,id),{command,phase:"uncertain"});
  const replayed=[];
  const retrySend=async(noteId,c,sig)=>{
    replayed.push({noteId,command:c,aborted:sig.aborted});
    return {outcome:"saved",replayed:true};
  };
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,command,retrySend),
    {outcome:"saved",replayed:true});
  assert.deepEqual(replayed,[{noteId:id,command,aborted:false}]);
  assert.equal(trackedNoteEdit(runtime,gen,id).phase,"saved");
  // On a subsequent authorized detail the success marker can be dropped.
  forgetTrackedNoteEdit(runtime,gen,id);
  assert.equal(trackedNoteEdit(runtime,gen,id),null);
  assert.ok(observed.includes("saving"));
});

test("changed command UUID/content cannot replace an unresolved ambiguous operation",async()=>{
  const runtime={};
  await runTrackedNoteEdit(runtime,gen,id,command,async()=>({outcome:"uncertain"}));
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,
    {...command,commandId:"d6aa2d77-fd6a-4600-8e03-e7ed0aec0511"},
    async()=>({outcome:"saved",replayed:false})),{outcome:"conflict"});
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,
    {...command,body:"different"},
    async()=>({outcome:"saved",replayed:false})),{outcome:"conflict"});
  assert.equal(trackedNoteEdit(runtime,gen,id).command.commandId,command.commandId);
});

test("changing auth generation purges and aborts the old runtime's pending operation",async()=>{
  const runtime={};let signal;let resolveRequest;
  const pending=runTrackedNoteEdit(runtime,gen,id,command,async(_id,_command,s)=>{
    signal=s;return await new Promise(r=>{resolveRequest=r;});
  });
  await Promise.resolve();
  assert.equal(signal.aborted,false);
  assert.equal(trackedNoteEdit(runtime,"c169f26b-07a4-49c5-a4ca-3eb2d00c6f32",id),null);
  assert.equal(signal.aborted,true);
  assert.equal(trackedNoteEdit(runtime,gen,id),null,
    "an old generation must not reappear after invalidation");
  resolveRequest({outcome:"uncertain"});
  await pending;
  assert.equal(trackedNoteEdit(runtime,gen,id),null);
});

test("denial is observable and never silently converted into a success",async()=>{
  const runtime={};const transitions=[];
  const unsubscribe=subscribeTrackedNoteEdit(runtime,gen,id,()=>{
    transitions.push(trackedNoteEdit(runtime,gen,id)?.phase);
  });
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,command,
    async()=>({outcome:"denied"})),{outcome:"denied"});
  assert.deepEqual(transitions,["saving","denied"]);
  unsubscribe();
  forgetTrackedNoteEdit(runtime,gen,id);
  assert.equal(trackedNoteEdit(runtime,gen,id),null);
});

test("note UI uses exact-command retry after a changed revision; denied access hides parent immediately",()=>{
  const editor=read("app/ui/target-note-editor.tsx");
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.match(editor,/const stale=d\.command===null&&note\.revision!==d\.revision/);
  assert.match(editor,/if\(!retry&&note\.revision!==draft\.revision\)/);
  assert.match(editor,/void runTrackedNoteEdit\(runtime,boundGeneration\.current,note\.id,command\)/);
  assert.match(editor,/onAccessRefused\(\)/);
  assert.match(editor,/loadNoteEditPreview\(note\.id,signal\.signal,editReadFetch\)/);
  assert.match(editor,/result\.preview\.writeAreaId!==tracked\.command\.writeAreaId/);
  assert.doesNotMatch(editor,/controller\.current\?\.abort\(\);\s*setMode\(\{kind:"idle"\}\);\s*\/\/ abort PATCH/);
  assert.match(panel,/const invalidateAndReload=useCallback\(\(\)=>\{\s*epoch\.current\+\+;/);
  assert.match(panel,/setState\(\{kind:"loading"\}\)/);
  assert.match(panel,/onAccessRefused=\{invalidateAndReload\}/);
});
