import assert from "node:assert/strict";
import {test} from "node:test";
import {
  anyTargetUiEdit,NO_TARGET_UI_EDITS,targetUiConfig,TARGET_UI_EDITS_FLAGS,
  TARGET_UI_EDIT_NOTE_FLAGS,TARGET_UI_EDIT_TASK_CONTEXT_FLAGS,TARGET_UI_EDIT_WHEN_FLAGS,
}from "../lib/target-ui-config.ts";
import {editCopy}from "../lib/target-edit-copy.ts";
import {isTargetReadRequest,routeTargetFetch}from "../lib/target-edit-fetch.ts";
import {emitTargetChange,subscribeTargetChange,targetChangeListenerCount}from "../lib/target-data-invalidation.ts";

const T="true";
const base={
  AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED:T,AI_EXECUTIVE_TARGET_UI_ENABLED:T,
  AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED:T,
  AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED:T,
};
const editsOn={...base,AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED:T,AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:T};
const task={AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED:T};
const when={AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_ENABLED:T,AI_EXECUTIVE_TARGET_STAGING_HTTP_PERSONAL_WHEN_WRITE_ENABLED:T};
const note={AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED:T};
const all={...editsOn,...task,...when,...note};

test("edits are off by default and with only the read flags: identical to R3-FE-4a",()=>{
  assert.deepEqual(targetUiConfig(base).edits,NO_TARGET_UI_EDITS);
  assert.deepEqual(targetUiConfig({...base,...task,...when,...note,AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED:T}).edits,NO_TARGET_UI_EDITS,
    "server write flags alone never show a control");
  assert.deepEqual(targetUiConfig({...base,AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED:T}).edits,NO_TARGET_UI_EDITS);
  assert.equal(anyTargetUiEdit(undefined),false);
  assert.equal(anyTargetUiEdit(NO_TARGET_UI_EDITS),false);
});

test("every edit needs the new UI flag, the details flag and the base write flag",()=>{
  for(const name of ["AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED","AI_EXECUTIVE_TARGET_UI_DETAILS_ENABLED","AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED"]){
    const env={...all};delete env[name];
    assert.deepEqual(targetUiConfig(env).edits,NO_TARGET_UI_EDITS,name);
    for(const bad of ["1","TRUE","yes","false",""])
      assert.deepEqual(targetUiConfig({...all,[name]:bad}).edits,NO_TARGET_UI_EDITS,name+bad);
  }
  assert.deepEqual(TARGET_UI_EDITS_FLAGS.slice(-2),["AI_EXECUTIVE_TARGET_UI_EDITS_ENABLED","AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED"]);
});

test("full flag set enables every control",()=>{
  assert.deepEqual(targetUiConfig(all).edits,{taskTitle:true,taskStatus:true,taskWhen:true,taskDelete:true,noteEdit:true,noteDelete:true});
});

test("matrix: each family needs exactly its own server flags; a missing one removes only that control",()=>{
  for(const name of TARGET_UI_EDIT_TASK_CONTEXT_FLAGS){
    const env={...all};delete env[name];
    // TEMPORAL_ENABLED is also the task-detail flag, so without it no task edit exists at all.
    const detailGone=name==="AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED";
    assert.deepEqual(targetUiConfig(env).edits,
      {taskTitle:false,taskStatus:false,taskWhen:!detailGone,taskDelete:false,noteEdit:true,noteDelete:true},name);
  }
  for(const name of TARGET_UI_EDIT_WHEN_FLAGS){
    const env={...all};delete env[name];
    assert.deepEqual(targetUiConfig(env).edits,
      {taskTitle:true,taskStatus:true,taskWhen:false,taskDelete:true,noteEdit:true,noteDelete:true},name);
  }
  for(const name of TARGET_UI_EDIT_NOTE_FLAGS){
    const env={...all};delete env[name];
    assert.deepEqual(targetUiConfig(env).edits,
      {taskTitle:true,taskStatus:true,taskWhen:true,taskDelete:true,noteEdit:false,noteDelete:false},name);
  }
});

test("the detail kind flags still gate: no task detail -> no task edits, no note detail -> no note edits",()=>{
  const noTask={...all};delete noTask.AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_ENABLED;
  assert.deepEqual(targetUiConfig(noTask).edits,{taskTitle:false,taskStatus:false,taskWhen:false,taskDelete:false,noteEdit:true,noteDelete:true});
  const noNote={...all};delete noNote.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED;
  assert.deepEqual(targetUiConfig(noNote).edits,{taskTitle:true,taskStatus:true,taskWhen:true,taskDelete:true,noteEdit:false,noteDelete:false});
});

test("copy tables: identical key sets, every write kind has a message in both languages",()=>{
  const walk=(value,prefix="")=>typeof value==="function"?[prefix]
    :value&&typeof value==="object"?Object.entries(value).flatMap(([k,v])=>walk(v,prefix+k+".")):[prefix];
  assert.deepEqual(walk(editCopy.cs).sort(),walk(editCopy.en).sort());
  for(const language of ["cs","en"]){
    const c=editCopy[language];
    for(const kind of ["taskTitle","taskStatus","taskWhen","taskDelete","noteEdit","noteDelete"]){
      assert.ok(c.pending[kind].length>0&&c.committed[kind].length>0,language+kind);
    }
    for(const kind of ["taskTitle","taskStatus","taskWhen"])assert.ok(c.undone[kind].length>0);
    for(const text of [c.conflict,c.uncertain,c.offline,c.readOnly,...Object.values(c.errors)])
      assert.ok(!/\b(40[0-9]|50[0-9]|revision|CAS|uuid|http)\b/i.test(text),"calm copy: "+text);
  }
  assert.notEqual(editCopy.cs.conflict,editCopy.en.conflict);
  assert.match(editCopy.cs.confirmDeleteTask("A"),/„A“/);
});

test("fetch routing: reads and receipt checks queue, writes never occupy the read slot",()=>{
  const get=(url)=>isTargetReadRequest(url,{method:"GET"});
  assert.equal(get("/api/target-staging/task-temporal/status?taskId=a"),true);
  assert.equal(isTargetReadRequest("/x"),true);
  const post=(url)=>isTargetReadRequest(url,{method:"POST"});
  assert.equal(post("/api/target-staging/tasks/a/title/status"),true);
  assert.equal(post("/api/target-staging/tasks/a/delete/status"),true);
  assert.equal(post("/api/target-staging/task-temporal/status/receipt"),true);
  assert.equal(post("/api/target-staging/tasks/a/delete"),false,"the delete write is a POST but not a read");
  assert.equal(isTargetReadRequest("/api/target-staging/task-temporal/status",{method:"PATCH"}),false);
  assert.equal(isTargetReadRequest("/api/target-staging/notes/a",{method:"DELETE"}),false);
  const calls=[];
  const routed=routeTargetFetch(async(input)=>{calls.push(["queued",String(input)]);return new Response("");},
    async(input)=>{calls.push(["direct",String(input)]);return new Response("");});
  return Promise.all([
    routed("/a/status",{method:"POST"}),routed("/a/delete",{method:"POST"}),routed("/a"),routed("/a",{method:"PATCH"}),
  ]).then(()=>assert.deepEqual(calls.map(c=>c[0]),["queued","direct","queued","direct"]));
});

test("change bus: subscribers get the notice, a throwing subscriber does not block the others, unsubscribe works",()=>{
  const seen=[];
  const before=targetChangeListenerCount();
  const off1=subscribeTargetChange(()=>{throw new Error("boom");});
  const off2=subscribeTargetChange(change=>seen.push(change));
  emitTargetChange({kind:"task",id:"a",change:"updated"});
  assert.deepEqual(seen,[{kind:"task",id:"a",change:"updated"}]);
  off1();off2();
  emitTargetChange({kind:"note",id:"b",change:"deleted"});
  assert.equal(seen.length,1);
  assert.equal(targetChangeListenerCount(),before);
});
