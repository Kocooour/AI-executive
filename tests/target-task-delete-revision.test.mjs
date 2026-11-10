import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {test} from "node:test";
import {parseTaskPreview,readStagingTaskPreview} from "../lib/target-staging-task-preview-client.ts";
import {fakeServer,json,taskBody,TASK,TASK_DETAIL,REV} from "./support/edit-fake-server.mjs";

test("task detail parser accepts an authorized opaque CAS without changing the preview",async()=>{
  const base=taskBody("O");
  const revisioned={...base,expectedRevision:REV};
  assert.deepEqual(parseTaskPreview(revisioned,TASK),base.task);
  assert.deepEqual(parseTaskPreview(base,TASK),base.task,"read-only viewers retain the old DTO");
  const authorized=fakeServer({[TASK_DETAIL]:()=>json(revisioned)});
  assert.deepEqual(await readStagingTaskPreview(TASK,new AbortController().signal,authorized.fetchFake),
    {ok:true,task:base.task,expectedRevision:REV});
  const viewer=fakeServer({[TASK_DETAIL]:()=>json(base)});
  assert.deepEqual(await readStagingTaskPreview(TASK,new AbortController().signal,viewer.fetchFake),
    {ok:true,task:base.task});
});

test("task detail parser fails closed on malformed revision, missing task and unexpected fields",()=>{
  const base=taskBody("O");
  for(const revision of ["","A".repeat(64),"x".repeat(64),REV+"0",12,null]){
    assert.equal(parseTaskPreview({...base,expectedRevision:revision},TASK),null);
  }
  assert.equal(parseTaskPreview({...base,expectedRevision:REV,extra:"hidden"},TASK),null);
  assert.equal(parseTaskPreview({expectedRevision:REV},TASK),null);
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
  assert.match(route,/result\.expectedRevision \? \{expectedRevision:result\.expectedRevision\} : \{\}/);
  assert.match(parser,/hasRevision && \(typeof result\.expectedRevision !== "string"/);
});
