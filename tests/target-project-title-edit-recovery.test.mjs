import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  forgetTrackedProjectTitleEdit,runTrackedProjectTitleEdit,subscribeTrackedProjectTitleEdit,trackedProjectTitleEdit,
  TARGET_PROJECT_TITLE_EDIT_WRITE_TIMEOUT_MS,
} from "../lib/target-project-title-edit-recovery.ts";

const gen="b7ab0e6e-d01f-44ed-babe-e9b69e84dbaa";
const rotated="c169f26b-07a4-49c5-a4ca-3eb2d00c6f32";
const id="1dbe798b-8ae4-46a8-98ae-51ac73dd31b8";
const command={
  commandId:"f3d18d63-9073-48f7-8d25-6c81f23b9a01",
  expectedRevision:"a".repeat(64),restoreGeneration:gen,
  writeAreaId:"private-area",title:"My project",
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
  const detach=subscribeTrackedProjectTitleEdit(runtime,gen,id,()=>{
    observed.push(trackedProjectTitleEdit(runtime,gen,id)?.phase??"cleared");
  });
  const send=async()=>{calls++;return await new Promise(resolve=>{release=resolve;});};
  const first=runTrackedProjectTitleEdit(runtime,gen,id,command,send);
  const also=runTrackedProjectTitleEdit(runtime,gen,id,command,send);
  assert.strictEqual(also,first,"no duplicate write while a PATCH is pending");
  await Promise.resolve();
  assert.equal(calls,1);
  assert.equal(runtime.count(),1,"the coordinator is registered independently of the inspector");
  assert.equal(trackedProjectTitleEdit(runtime,gen,id).phase,"saving");
  detach(); // inspector is gone, runtime still owns command
  assert.equal(runtime.count(),1);
  release({outcome:"uncertain"}); // server committed, but the ACK was lost
  assert.deepEqual(await first,{outcome:"uncertain"});
  assert.deepEqual(trackedProjectTitleEdit(runtime,gen,id),{command,phase:"uncertain"});
  const replayed=[];
  const retry=async(projectId,c,signal)=>{
    replayed.push({projectId,command:c,aborted:signal.aborted});
    return {outcome:"saved",replayed:true};
  };
  assert.deepEqual(await runTrackedProjectTitleEdit(runtime,gen,id,command,retry),
    {outcome:"saved",replayed:true});
  assert.deepEqual(replayed,[{projectId:id,command,aborted:false}]);
  assert.equal(trackedProjectTitleEdit(runtime,gen,id).phase,"saved");
  forgetTrackedProjectTitleEdit(runtime,gen,id);
  assert.equal(trackedProjectTitleEdit(runtime,gen,id),null);
  assert.ok(observed.includes("saving"));
});

test("a never-settling PATCH times out to UNCERTAIN and allows only the original UUID to retry",async()=>{
  const runtime=fakeRuntime();let firstSignal;let lateResolve;
  const start=Date.now();
  const first=runTrackedProjectTitleEdit(runtime,gen,id,command,async(_id,_command,signal)=>{
    firstSignal=signal;
    return await new Promise(resolve=>{lateResolve=resolve;}); // ignores abort!
  },15);
  assert.deepEqual(await first,{outcome:"uncertain"});
  assert.ok(Date.now()-start<2000,"timeout must settle the coordinator even when fetch ignores abort");
  assert.equal(firstSignal.aborted,true);
  assert.deepEqual(trackedProjectTitleEdit(runtime,gen,id),{command,phase:"uncertain"});
  assert.deepEqual(await runTrackedProjectTitleEdit(runtime,gen,id,
    {...command,commandId:"d6aa2d77-fd6a-4600-8e03-e7ed0aec0511"},
    async()=>({outcome:"saved",replayed:false})),{outcome:"conflict"});
  const calls=[];
  assert.deepEqual(await runTrackedProjectTitleEdit(runtime,gen,id,command,
    async(_id,c)=>{calls.push(c);return {outcome:"saved",replayed:true};}),
    {outcome:"saved",replayed:true});
  assert.deepEqual(calls,[command]);
  // A late reply to the timed-out first fetch cannot override this result.
  lateResolve({outcome:"denied"});
  await Promise.resolve();
  assert.equal(trackedProjectTitleEdit(runtime,gen,id).phase,"saved");
  assert.equal(TARGET_PROJECT_TITLE_EDIT_WRITE_TIMEOUT_MS,20_000);
});

test("changed UUID/content cannot replace an ambiguous command",async()=>{
  const runtime=fakeRuntime();
  await runTrackedProjectTitleEdit(runtime,gen,id,command,async()=>({outcome:"uncertain"}));
  assert.deepEqual(await runTrackedProjectTitleEdit(runtime,gen,id,
    {...command,commandId:"d6aa2d77-fd6a-4600-8e03-e7ed0aec0511"},
    async()=>({outcome:"saved",replayed:false})),{outcome:"conflict"});
  assert.deepEqual(await runTrackedProjectTitleEdit(runtime,gen,id,
    {...command,title:"different"},
    async()=>({outcome:"saved",replayed:false})),{outcome:"conflict"});
  assert.equal(trackedProjectTitleEdit(runtime,gen,id).command.commandId,command.commandId);
});

test("REAL runtime generation rotation purges drafts even after the last detail unsubscribed",async()=>{
  const runtime=fakeRuntime();let signal;let resolveRequest;
  const detach=subscribeTrackedProjectTitleEdit(runtime,gen,id,()=>{});
  const pending=runTrackedProjectTitleEdit(runtime,gen,id,command,async(_id,_command,s)=>{
    signal=s;return await new Promise(resolve=>{resolveRequest=resolve;});
  });
  await Promise.resolve();
  detach(); // no inspector subscription remains
  assert.equal(runtime.count(),1);
  assert.equal(signal.aborted,false);
  runtime.rotate(rotated); // runtime's register()/dispose(), NOT a synthetic subsequent lookup
  assert.equal(runtime.count(),0);
  assert.equal(signal.aborted,true);
  assert.equal(trackedProjectTitleEdit(runtime,gen,id),null,"a stale generation cannot recreate the old bucket");
  assert.equal(trackedProjectTitleEdit(runtime,rotated,id),null);
  assert.deepEqual(await pending,{outcome:"denied"});
  resolveRequest({outcome:"saved",replayed:false}); // late result cannot reintroduce secret
  await Promise.resolve();
  assert.equal(trackedProjectTitleEdit(runtime,rotated,id),null);
});

test("runtime signout/dispose eagerly erases detached private commands and fails closed",async()=>{
  for(const scenario of ["signOut","dispose"]){
    const runtime=fakeRuntime();
    const detach=subscribeTrackedProjectTitleEdit(runtime,gen,id,()=>{});
    await runTrackedProjectTitleEdit(runtime,gen,id,command,async()=>({outcome:"uncertain"}));
    detach();
    assert.equal(runtime.count(),1);
    runtime[scenario]();
    assert.equal(runtime.count(),0);
    assert.equal(trackedProjectTitleEdit(runtime,gen,id),null);
    assert.deepEqual(await runTrackedProjectTitleEdit(runtime,gen,id,command,async()=>({
      outcome:"saved",replayed:false,
    })),{outcome:"denied"});
    assert.equal(runtime.count(),0);
  }
});

test("a revoked in-flight command never dispatches a queued network request",async()=>{
  const runtime=fakeRuntime();let called=0;
  const pending=runTrackedProjectTitleEdit(runtime,gen,id,command,async()=>{
    called++;return {outcome:"saved",replayed:false};
  });
  runtime.signOut(); // before Promise.resolve().then dispatches PATCH
  assert.deepEqual(await pending,{outcome:"denied"});
  assert.equal(called,0);
  assert.equal(trackedProjectTitleEdit(runtime,gen,id),null);
});

test("denial is observable and cannot become a success",async()=>{
  const runtime=fakeRuntime(),transitions=[];
  const unsubscribe=subscribeTrackedProjectTitleEdit(runtime,gen,id,()=>{
    transitions.push(trackedProjectTitleEdit(runtime,gen,id)?.phase);
  });
  assert.deepEqual(await runTrackedProjectTitleEdit(runtime,gen,id,command,
    async()=>({outcome:"denied"})),{outcome:"denied"});
  assert.deepEqual(transitions,["saving","denied"]);
  unsubscribe();
  forgetTrackedProjectTitleEdit(runtime,gen,id);
  assert.equal(trackedProjectTitleEdit(runtime,gen,id),null);
});


test('unsent draft survives detail unmount and offline in same generation but is erased on identity change',async()=>{
  const {projectTitleDraft,setProjectTitleDraft,forgetProjectTitleDraft}=await import('../lib/target-project-title-edit-recovery.ts');
  const runtime=fakeRuntime(),draft={original:'Before',title:'Unsaved private',writeAreaId:'area',expectedRevision:'a'.repeat(64),restoreGeneration:gen,principalBinding:'A'.repeat(43)};
  setProjectTitleDraft(runtime,gen,id,draft);
  assert.deepEqual(projectTitleDraft(runtime,gen,id),draft);
  // Inspector unmount and network status do not dispose runtime; callers must
  // revalidate the project's writer ACL before displaying this draft again.
  assert.equal(runtime.count(),1);assert.deepEqual(projectTitleDraft(runtime,gen,id),draft);
  runtime.rotate(rotated);
  assert.equal(projectTitleDraft(runtime,gen,id),null);
  assert.equal(projectTitleDraft(runtime,rotated,id),null);
  setProjectTitleDraft(runtime,rotated,id,draft);forgetProjectTitleDraft(runtime,rotated,id);
  assert.equal(projectTitleDraft(runtime,rotated,id),null);
});

test('successful detached write invalidates project lists even without a mounted inspector',async()=>{
 const runtime=fakeRuntime(),originalWindow=globalThis.window;
 const events=[];globalThis.window={dispatchEvent:event=>events.push(event.type)};
 try{
   const detach=subscribeTrackedProjectTitleEdit(runtime,gen,id,()=>{});
   let release;const pending=runTrackedProjectTitleEdit(runtime,gen,id,command,()=>new Promise(resolve=>{release=resolve}));
   await Promise.resolve();detach();release({outcome:'saved',replayed:false});await pending;
   assert.deepEqual(events,['lumi-target-project-title-updated']);
 }finally{if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;}
});


test('unsent draft recovery detects title ABA, Area change and restore',async()=>{
 const {projectTitleDraftConflicts}=await import('../lib/target-project-title-edit-recovery.ts');
 const draft={original:'Before',title:'Draft',writeAreaId:'area',expectedRevision:'a'.repeat(64),restoreGeneration:gen,principalBinding:'A'.repeat(43)};
 const same={writeAreaId:'area',expectedRevision:draft.expectedRevision,restoreGeneration:gen,
    principalBinding:draft.principalBinding};
 assert.equal(projectTitleDraftConflicts(draft,same,'Before'),false);
 assert.equal(projectTitleDraftConflicts(draft,{...same,expectedRevision:'b'.repeat(64)},'Before'),true);
 assert.equal(projectTitleDraftConflicts(draft,{...same,restoreGeneration:rotated},'Before'),true);
 assert.equal(projectTitleDraftConflicts(draft,{...same,writeAreaId:'other'},'Before'),true);
  assert.equal(projectTitleDraftConflicts(draft,{...same,principalBinding:'B'.repeat(43)},'Before'),true);
});
