import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {parseTaskPreview,readStagingTaskPreview} from "../lib/target-staging-task-preview-client.ts";
import {fakeServer,json,taskBody,TASK,TASK_DETAIL,REV} from "./support/edit-fake-server.mjs";

test("task detail parser accepts an authorized opaque CAS without changing the preview",async()=>{
  const base=taskBody("O");
  const revisioned={...base,expectedRevision:REV};
  assert.equal(parseTaskPreview(revisioned,TASK),null,"the public JSON DTO must remain exact");
  assert.deepEqual(parseTaskPreview(base,TASK),base.task,"read-only viewers retain the old DTO");
  const authorized=fakeServer({[TASK_DETAIL]:()=>json(base,200,{"x-lumi-task-revision":REV})});
  assert.deepEqual(await readStagingTaskPreview(TASK,new AbortController().signal,authorized.fetchFake),
    {ok:true,task:base.task,expectedRevision:REV});
  const viewer=fakeServer({[TASK_DETAIL]:()=>json(base)});
  assert.deepEqual(await readStagingTaskPreview(TASK,new AbortController().signal,viewer.fetchFake),
    {ok:true,task:base.task});
});

test("task detail rejects malformed or missing JSON fields and rejects invalid CAS response headers",async()=>{
  const base=taskBody("O");
  for(const revision of ["","A".repeat(64),"x".repeat(64),REV+"0",12,null]){
    assert.equal(parseTaskPreview({...base,expectedRevision:revision},TASK),null);
  }
  assert.equal(parseTaskPreview({...base,expectedRevision:REV,extra:"hidden"},TASK),null);
  assert.equal(parseTaskPreview({expectedRevision:REV},TASK),null);
  for(const value of ["",REV+"0","x".repeat(64),"A".repeat(64)]){
    const server=fakeServer({[TASK_DETAIL]:()=>json(base,200,{"x-lumi-task-revision":value})});
    const result=await readStagingTaskPreview(TASK,new AbortController().signal,server.fetchFake);
    assert.deepEqual(result,{ok:false,reason:"invalid-response"});
  }
});

test("server uses one authorized snapshot for task detail and CAS and leaks none to read-only viewers",()=>{
  const root=path.resolve(import.meta.dirname,"..");
  const worker=readFileSync(path.join(root,"scripts/target-staging-temporal-detail-child.mjs"),"utf8");
  const route=readFileSync(path.join(root,"app/api/target-staging/task-temporal/detail/route.ts"),"utf8");
  const parser=readFileSync(path.join(root,"lib/target-staging-read-process.ts"),"utf8");
  assert.match(worker,/AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED === "true"/);
  assert.match(worker,/AI_EXECUTIVE_TARGET_STAGING_HTTP_TEMPORAL_WRITE_ENABLED === "true"/);
  assert.match(worker,/readTemporalStatusPreview\(actor\.actor,taskId\)/);
  assert.match(worker,/revisioned\?\.detail \?\? authority\.readTemporalTaskDetail\(actor\.actor,taskId\)/);
  assert.match(route,/result\.expectedRevision \? \{"x-lumi-task-revision":result\.expectedRevision\} : \{\}/);
  assert.match(parser,/hasRevision && \(typeof result\.expectedRevision !== "string"/);
});
