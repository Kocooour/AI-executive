import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {parseTaskPreview, readStagingTaskPreview, validTaskPreviewId} from '../lib/target-staging-task-preview-client.ts';
import {stagingIndexDetailHref} from '../lib/target-staging-index-detail-links.ts';
const task={id:'t-1',title:'Úkol',projectId:null,areaId:'a',areaKind:'private',status:'open',completedAtMs:null,dueOn:null};
const response=(payload,status=200,headers={})=>new Response(JSON.stringify(payload),{status,headers:{'cache-control':'no-store','content-type':'application/json',...headers}});
test('task DTO strictly validates ID, fields, assignment and status',()=>{
  assert.deepEqual(parseTaskPreview({task},'t-1'),task);
  assert.deepEqual(parseTaskPreview({task:{...task,title:'č'.repeat(2049)}},'t-1'),{...task,title:'č'.repeat(2049)});
  assert.equal(parseTaskPreview({task:{...task,title:'x'.repeat(4097)}},'t-1'),null);
  const shared={...task,areaKind:'shared',assignedToMe:true};
  assert.deepEqual(parseTaskPreview({task:shared},'t-1'),shared);
  for(const item of [{...task,id:'other'},{...task,actor:'secret'}, {...task,assignedToMe:true}, {...shared,assignedToMe:'yes'}, {...task,status:'completed'}, {...task,title:'\ud800'}, {...task,dueOn:'bad'}]) assert.equal(parseTaskPreview({task:item},'t-1'),null);
});
test('preview rejects oversized or malformed title and transport IDs at its safety limits',()=>{
  const parse=changes=>parseTaskPreview({task:{...task,...changes}},'t-1');
  assert.ok(parse({title:'x'.repeat(4096)}));
  assert.equal(parse({title:'x'.repeat(4097)}),null);
  assert.equal(parse({title:'\ud800'}),null);
  for(const field of ['areaId','projectId']){
    assert.ok(parse({[field]:'č'.repeat(2048)})); // exactly 4096 UTF-8 bytes
    assert.equal(parse({[field]:'č'.repeat(2049)}),null);
    assert.equal(parse({[field]:'\ud800'}),null);
  }
});
test('explicit read is no-store and fails closed on denied, malformed and aborted responses',async()=>{
  let calls=0;
  const ok=await readStagingTaskPreview('t-1',new AbortController().signal,async (url,opts)=>{calls++;assert.equal(url,'/api/target-staging/task-temporal/detail?taskId=t-1');assert.equal(opts.cache,'no-store');assert.equal(opts.redirect,'error');return response({task});});
  assert.deepEqual(ok,{ok:true,task}); assert.equal(calls,1);
  for(const [status,reason] of [[401,'signed-out'],[404,'not-found'],[409,'stale'],[429,'rate-limited']]) assert.deepEqual(await readStagingTaskPreview('t-1',new AbortController().signal,async()=>response({error:'secret'},status)),{ok:false,reason});
  assert.deepEqual(await readStagingTaskPreview('t-1',new AbortController().signal,async()=>response({task},200,{'cache-control':'private'})),{ok:false,reason:'invalid-response'});
  const c=new AbortController(); const pending=readStagingTaskPreview('t-1',c.signal,()=>new Promise(()=>{}));c.abort();assert.deepEqual(await pending,{ok:false,reason:'aborted'});
});
test('task link requires explicit gate and valid unambiguous segment',()=>{
  const gates={project:true,note:true,task:true};
  assert.equal(stagingIndexDetailHref('task','t:1',gates),'/target-staging/tasks/t%3A1/preview');
  assert.equal(stagingIndexDetailHref('task','t:1',{...gates,task:false}),null);
  for(const id of ['..','a/b','a\\b',' x','\ud800']){assert.equal(stagingIndexDetailHref('task',id,gates),null);assert.equal(validTaskPreviewId(id),false);}
  const page=readFileSync('app/target-staging/tasks/[taskId]/preview/page.tsx','utf8');
  assert.match(page,/HTTP_TEMPORAL_ENABLED/); assert.match(page,/TASK_CLIENT_PREVIEW_ENABLED/); assert.match(page,/notFound/);
});
