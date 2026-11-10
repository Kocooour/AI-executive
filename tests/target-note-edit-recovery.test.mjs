import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  forgetTrackedNoteEdit,runTrackedNoteEdit,subscribeTrackedNoteEdit,trackedNoteEdit,
  TARGET_NOTE_EDIT_WRITE_TIMEOUT_MS,
} from "../lib/target-note-edit-recovery.ts";

const gen="b7ab0e6e-d01f-44ed-babe-e9b69e84dbaa";
const rotated="c169f26b-07a4-49c5-a4ca-3eb2d00c6f32";
const id="1dbe798b-8ae4-46a8-98ae-51ac73dd31b8";
const command={
  commandId:"f3d18d63-9073-48f7-8d25-6c81f23b9a01",
  expectedRevision:"a".repeat(64),restoreGeneration:gen,
  writeAreaId:"private-area",title:"My note",body:"Private draft",
};
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
function fakeRuntime(){
  let generation=gen,known=true;
  const registered=new Set();
  const flush=()=>{
    const old=[...registered];registered.clear();
    for(const entry of old)entry.dispose();
  };
  return {
    generation:()=>generation,
    known:()=>known,
    register:(entry)=>{
      if(!known){entry.dispose();return ()=>{};}
      registered.add(entry);
      return ()=>registered.delete(entry);
    },
    rotate:(next)=>{generation=next;flush();},
    signOut:()=>{known=false;generation="unknown-revoked";flush();},
    dispose:()=>{known=false;flush();},
    count:()=>registered.size,
  };
}

test("a detached inspector retains the exact command when a PATCH acknowledgement is lost",async()=>{
  const runtime=fakeRuntime();let release;let calls=0;const observed=[];
  const detach=subscribeTrackedNoteEdit(runtime,gen,id,()=>{
    observed.push(trackedNoteEdit(runtime,gen,id)?.phase??"cleared");
  });
  const send=async()=>{calls++;return await new Promise(resolve=>{release=resolve;});};
  const first=runTrackedNoteEdit(runtime,gen,id,command,send);
  const also=runTrackedNoteEdit(runtime,gen,id,command,send);
  assert.strictEqual(also,first,"no duplicate write while a PATCH is pending");
  await Promise.resolve();
  assert.equal(calls,1);
  assert.equal(runtime.count(),1,"the coordinator is registered independently of the inspector");
  assert.equal(trackedNoteEdit(runtime,gen,id).phase,"saving");
  detach(); // inspector is gone, runtime still owns command
  assert.equal(runtime.count(),1);
  release({outcome:"uncertain"}); // server committed, but the ACK was lost
  assert.deepEqual(await first,{outcome:"uncertain"});
  assert.deepEqual(trackedNoteEdit(runtime,gen,id),{command,phase:"uncertain"});
  const replayed=[];
  const retry=async(noteId,c,signal)=>{
    replayed.push({noteId,command:c,aborted:signal.aborted});
    return {outcome:"saved",replayed:true};
  };
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,command,retry),
    {outcome:"saved",replayed:true});
  assert.deepEqual(replayed,[{noteId:id,command,aborted:false}]);
  assert.equal(trackedNoteEdit(runtime,gen,id).phase,"saved");
  forgetTrackedNoteEdit(runtime,gen,id);
  assert.equal(trackedNoteEdit(runtime,gen,id),null);
  assert.ok(observed.includes("saving"));
});

test("a never-settling PATCH times out to UNCERTAIN and allows only the original UUID to retry",async()=>{
  const runtime=fakeRuntime();let firstSignal;let lateResolve;
  const start=Date.now();
  const first=runTrackedNoteEdit(runtime,gen,id,command,async(_id,_command,signal)=>{
    firstSignal=signal;
    return await new Promise(resolve=>{lateResolve=resolve;}); // ignores abort!
  },15);
  assert.deepEqual(await first,{outcome:"uncertain"});
  assert.ok(Date.now()-start<2000,"timeout must settle the coordinator even when fetch ignores abort");
  assert.equal(firstSignal.aborted,true);
  assert.deepEqual(trackedNoteEdit(runtime,gen,id),{command,phase:"uncertain"});
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,
    {...command,commandId:"d6aa2d77-fd6a-4600-8e03-e7ed0aec0511"},
    async()=>({outcome:"saved",replayed:false})),{outcome:"conflict"});
  const calls=[];
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,command,
    async(_id,c)=>{calls.push(c);return {outcome:"saved",replayed:true};}),
    {outcome:"saved",replayed:true});
  assert.deepEqual(calls,[command]);
  // A late reply to the timed-out first fetch cannot override this result.
  lateResolve({outcome:"denied"});
  await Promise.resolve();
  assert.equal(trackedNoteEdit(runtime,gen,id).phase,"saved");
  assert.equal(TARGET_NOTE_EDIT_WRITE_TIMEOUT_MS,20_000);
});

test("changed UUID/content cannot replace an ambiguous command",async()=>{
  const runtime=fakeRuntime();
  await runTrackedNoteEdit(runtime,gen,id,command,async()=>({outcome:"uncertain"}));
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,
    {...command,commandId:"d6aa2d77-fd6a-4600-8e03-e7ed0aec0511"},
    async()=>({outcome:"saved",replayed:false})),{outcome:"conflict"});
  assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,
    {...command,body:"different"},
    async()=>({outcome:"saved",replayed:false})),{outcome:"conflict"});
  assert.equal(trackedNoteEdit(runtime,gen,id).command.commandId,command.commandId);
});

test("REAL runtime generation rotation purges drafts even after the last detail unsubscribed",async()=>{
  const runtime=fakeRuntime();let signal;let resolveRequest;
  const detach=subscribeTrackedNoteEdit(runtime,gen,id,()=>{});
  const pending=runTrackedNoteEdit(runtime,gen,id,command,async(_id,_command,s)=>{
    signal=s;return await new Promise(resolve=>{resolveRequest=resolve;});
  });
  await Promise.resolve();
  detach(); // no inspector subscription remains
  assert.equal(runtime.count(),1);
  assert.equal(signal.aborted,false);
  runtime.rotate(rotated); // runtime's register()/dispose(), NOT a synthetic subsequent lookup
  assert.equal(runtime.count(),0);
  assert.equal(signal.aborted,true);
  assert.equal(trackedNoteEdit(runtime,gen,id),null,"a stale generation cannot recreate the old bucket");
  assert.equal(trackedNoteEdit(runtime,rotated,id),null);
  assert.deepEqual(await pending,{outcome:"denied"});
  resolveRequest({outcome:"saved",replayed:false}); // late result cannot reintroduce secret
  await Promise.resolve();
  assert.equal(trackedNoteEdit(runtime,rotated,id),null);
});

test("runtime signout/dispose eagerly erases detached private commands and fails closed",async()=>{
  for(const scenario of ["signOut","dispose"]){
    const runtime=fakeRuntime();
    const detach=subscribeTrackedNoteEdit(runtime,gen,id,()=>{});
    await runTrackedNoteEdit(runtime,gen,id,command,async()=>({outcome:"uncertain"}));
    detach();
    assert.equal(runtime.count(),1);
    runtime[scenario]();
    assert.equal(runtime.count(),0);
    assert.equal(trackedNoteEdit(runtime,gen,id),null);
    assert.deepEqual(await runTrackedNoteEdit(runtime,gen,id,command,async()=>({
      outcome:"saved",replayed:false,
    })),{outcome:"denied"});
    assert.equal(runtime.count(),0);
  }
});

test("a revoked in-flight command never dispatches a queued network request",async()=>{
  const runtime=fakeRuntime();let called=0;
  const pending=runTrackedNoteEdit(runtime,gen,id,command,async()=>{
    called++;return {outcome:"saved",replayed:false};
  });
  runtime.signOut(); // before Promise.resolve().then dispatches PATCH
  assert.deepEqual(await pending,{outcome:"denied"});
  assert.equal(called,0);
  assert.equal(trackedNoteEdit(runtime,gen,id),null);
});

test("denial is observable and cannot become a success",async()=>{
  const runtime=fakeRuntime(),transitions=[];
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

test("note UI retains exact-command retry after revision change and redacts revoked detail",()=>{
  const editor=read("app/ui/target-note-editor.tsx");
  const panel=read("app/ui/target-detail-panel.tsx");
  assert.match(editor,/const stale=d\.command===null&&note\.revision!==d\.revision/);
  assert.match(editor,/if\(!retry&&note\.revision!==draft\.revision\)/);
  assert.match(editor,/void runTrackedNoteEdit\(runtime,boundGeneration\.current,note\.id,command\)/);
  assert.match(editor,/onAccessRefused\(\)/);
  assert.match(editor,/loadNoteEditPreview\(note\.id,signal\.signal,editReadFetch\)/);
  assert.match(editor,/result\.preview\.writeAreaId!==tracked\.command\.writeAreaId/);
  assert.match(panel,/const invalidateAndReload=useCallback\(\(\)=>\{\s*epoch\.current\+\+;/);
  assert.match(panel,/setState\(\{kind:"loading"\}\)/);
  assert.match(panel,/onAccessRefused=\{invalidateAndReload\}/);
});


test("integration: real target runtime eagerly purges detached note drafts on refresh rotation and refusal",async()=>{
  const {createTargetClientRuntime}=await import("../lib/target-client-runtime.ts");
  for(const scenario of ["rotation","refusal"]){
    const first="A".repeat(43),second="B".repeat(43);
    let calls=0;
    const runtime=createTargetClientRuntime({
      fetch:async()=>{
        calls++;
        const status=scenario==="refusal"&&calls>1?401:200;
        return new Response(JSON.stringify(status===200?
          {generation:calls===1?first:second}:{error:"Signed out"}),{
          status,headers:{"content-type":"application/json","cache-control":"no-store"},
        });
      },
      window:null,broadcastChannelFactory:null,
    });
    for(let n=0;n<20&&!runtime.known();n++)
      await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(runtime.generation(),first);
    const unsubscribe=subscribeTrackedNoteEdit(runtime,first,id,()=>{});
    let signal,settleWrite;
    const pending=runTrackedNoteEdit(runtime,first,id,command,
      async(_id,_command,s)=>{signal=s;return await new Promise(resolve=>{settleWrite=resolve;});});
    await Promise.resolve();
    unsubscribe(); // zero editors, coordinator remains registered with runtime
    assert.ok(trackedNoteEdit(runtime,first,id));
    if(scenario==="rotation"){
      assert.equal(await runtime.refresh(),"ok");
      assert.equal(runtime.generation(),second);
    }else{
      const refresh=runtime.reportRefusal();
      assert.equal(runtime.known(),false,"reportRefusal must synchronously revoke the prior token");
      await refresh;
    }
    assert.equal(signal.aborted,true,"runtime itself aborts the detached command on auth change");
    assert.equal(trackedNoteEdit(runtime,first,id),null,"old private draft must be gone");
    assert.deepEqual(await pending,{outcome:"denied"});
    settleWrite({outcome:"saved",replayed:false});
    await Promise.resolve();
    assert.equal(trackedNoteEdit(runtime,first,id),null);
    runtime.dispose();
  }
});


test("a stale editor cannot clear a different generation's authorized command",async()=>{
  const runtime=fakeRuntime();
  runtime.rotate(rotated);
  const newCommand={...command,commandId:"d6aa2d77-fd6a-4600-8e03-e7ed0aec0511"};
  await runTrackedNoteEdit(runtime,rotated,id,newCommand,async()=>({outcome:"uncertain"}));
  assert.equal(trackedNoteEdit(runtime,rotated,id)?.command.commandId,newCommand.commandId);
  assert.equal(trackedNoteEdit(runtime,gen,id),null);
  forgetTrackedNoteEdit(runtime,gen,id);
  assert.equal(trackedNoteEdit(runtime,rotated,id)?.command.commandId,newCommand.commandId);
  runtime.dispose();
});
