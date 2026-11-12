import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

const names = ['NODE_ENV','AI_EXECUTIVE_DATA_DIR','AI_EXECUTIVE_SECURITY_ALERT_FILE',
  'AI_EXECUTIVE_AUTH_ENABLED','AI_EXECUTIVE_PASSWORD_HASH','AI_EXECUTIVE_SESSION_SECRET',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED','AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED','AI_EXECUTIVE_TARGET_STAGING_DIRECTORY',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED','AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED',
  'AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION','AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID'];
const old = Object.fromEntries(names.map(k => [k, process.env[k]]));
const root = mkdtempSync(path.join(os.tmpdir(), 'lumi-note-sync-http-'));
const legacy=path.join(root,'production-sentinel'); mkdirSync(legacy);
writeFileSync(path.join(legacy,'keep'),'untouched');
process.env.NODE_ENV='production';
process.env.AI_EXECUTIVE_DATA_DIR=legacy;
process.env.AI_EXECUTIVE_SECURITY_ALERT_FILE=path.join(root,'security-alerts.log');
process.env.AI_EXECUTIVE_AUTH_ENABLED='true';
process.env.AI_EXECUTIVE_PASSWORD_HASH='scrypt:' + Buffer.alloc(16,1).toString('base64url') + ':' + Buffer.alloc(64,2).toString('base64url');
process.env.AI_EXECUTIVE_SESSION_SECRET='note-sync-http-secret-long-enough-for-aead';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED='true';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED='true';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED='true';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED='true';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED='true';
const { bootstrapIsolatedTargetStore } = await import('../lib/target-store-bootstrap.ts');
const durable = await import('../lib/target-staging-durable-session.ts');
const { createSessionToken, sessionCookieName } = await import('./support/owner-session-test-cookie.mjs');
const { GET } = await import('../app/api/target-staging/note-sync/route.ts');
const { GET: NOTE_SESSION } = await import('../app/api/target-staging/note-sync-session/route.ts');
const { GET: PREVIEW, PATCH: EDIT } = await import('../app/api/target-staging/notes/[noteId]/edit/route.ts');
const { DELETE: DELETE_NOTE } = await import('../app/api/target-staging/notes/[noteId]/route.ts');
const { readStagingNoteSyncInChild, parseStagingNoteSyncResult } = await import('../lib/target-staging-read-process.ts');
const { verifyStagingReadBeforeRelease } = await import('../lib/target-staging-http-identity.ts');
const { NOTE_SYNC_CURSOR_LENGTH } = await import('../lib/target-note-sync-cursor.ts');
after(() => { for (const [k,v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k]=v;
  assert.equal(readFileSync(path.join(legacy,'keep'),'utf8'),'untouched');
  rmSync(root,{recursive:true,force:true}); });
function fixture() {
  const stage=bootstrapIsolatedTargetStore({stagingDirectory:path.join(root,randomUUID()),ownerUserId:'alice'});
  const db=new DatabaseSync(stage.databasePath);
  db.exec('PRAGMA foreign_keys=ON');
  for (const id of ['bob','carol','dave']) {
    db.prepare('INSERT INTO identities(id) VALUES (?)').run(id);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)")
      .run('personal-'+id,id);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,'Unassigned','private',?,?,'unassigned')")
      .run('private-'+id,'personal-'+id,id);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for (const [id,role] of [['alice','admin'],['bob','editor'],['carol','viewer']])
    db.prepare('INSERT INTO area_members(area_id,user_id,role) VALUES (\'team-area\',?,?)').run(id,role);
  db.prepare("INSERT INTO projects(id,area_id,title) VALUES ('parent','team-area','Parent')").run();
  for (const id of ['one','two','three']) db.prepare('INSERT INTO notes(id,area_id,title,body) VALUES (?,\'team-area\',?,\'Body\')').run(id,id);
  db.prepare("INSERT INTO notes(id,project_id,title,body) VALUES ('child','parent','Child','Body')").run();
  db.close();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY=stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION=stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID='alice';
  return {stage,store:{stagingDirectory:stage.directory,expectedRestoreGeneration:stage.restoreGeneration}};
}
function login(fx,id) { const x=durable.issueDurableTargetStagingSession(fx.store,id,900); assert.equal(x.ok,true); return durable.TARGET_STAGING_SESSION_COOKIE+'='+x.sessionToken; }
const owner=()=>sessionCookieName+'='+createSessionToken();
function req(cookie, area='team-area', limit=100, cursor) {
  const url=new URL('http://localhost:3001/api/target-staging/note-sync');
  url.searchParams.set('areaId',area); url.searchParams.set('limit',String(limit));
  if (cursor !== undefined) url.searchParams.set('cursor',cursor);
  return new Request(url,{headers:{cookie,'x-forwarded-for':'10.22.33.44'}});
}
async function page(cookie,area='team-area',limit=100,cursor) {
  const r=await GET(req(cookie,area,limit,cursor)); const body=await r.json();
  assert.equal(r.headers.get('cache-control'),'no-store'); return {status:r.status,body};
}
async function writeNote(cookie,method,command) {
  const url='http://localhost:3001/api/target-staging/notes/one'+(method==='PATCH'?'/edit':'');
  const request=new Request(url,{method,headers:{cookie,origin:'http://localhost:3001',
    'content-type':'application/json','x-lumi-target-protocol':'1','x-forwarded-for':'10.22.33.44'},
    body:JSON.stringify(command)});
  return (method==='PATCH'?EDIT:DELETE_NOTE)(request,{params:Promise.resolve({noteId:'one'})});
}
async function preview(cookie) {
  const request=new Request('http://localhost:3001/api/target-staging/notes/one/edit',{
    headers:{cookie,'x-forwarded-for':'10.22.33.44'}});
  const response=await PREVIEW(request,{params:Promise.resolve({noteId:'one'})});
  assert.equal(response.status,200); return response.json();
}
test('default-off gate and authenticated 3-actor multi-page bootstrap, edits and deletes',async()=>{
  const fx=fixture(); const bob=login(fx,'bob'), carol=login(fx,'carol'), dave=login(fx,'dave');
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED='false';
  assert.equal((await page(bob)).status,404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED='true';
  const ids=[]; let cursor; for(let i=0;i<4;i++) { const x=await page(bob,'team-area',1,cursor);
    assert.equal(x.status,200,JSON.stringify(x.body)); ids.push(...x.body.entries.map(y=>y.id));
    assert.deepEqual(x.body.changes,[]); cursor=x.body.cursor; }
  assert.deepEqual(ids,['child','one','three','two']);
  assert.equal((await page(bob,'team-area',1,cursor)).body.changes.length,0);
  assert.equal((await page(dave)).status,404);
  assert.equal((await page(owner())).status,200);
  const edited=await writeNote(bob,'PATCH',{...await preview(bob),commandId:randomUUID(),title:'one',body:'Changed'});
  assert.equal(edited.status,200,JSON.stringify(await edited.json()));
  const deleted=await writeNote(bob,'DELETE',{...await preview(bob),commandId:randomUUID()});
  assert.equal(deleted.status,200,JSON.stringify(await deleted.json()));
  const first=await page(bob,'team-area',1,cursor); assert.equal(first.status,200,JSON.stringify(first.body));
  assert.deepEqual(first.body.changes,[{kind:'edit',noteId:'one',projectId:null,revision:1}]);
  assert.equal(first.body.more,true);
  const second=await page(bob,'team-area',1,first.body.cursor);
  assert.deepEqual(second.body.changes,[{kind:'delete',noteId:'one',projectId:null,revision:2}]);
  assert.equal(second.body.more,false);
  assert.deepEqual(Object.keys(second.body).sort(),['changes','cursor','entries','more','phase']);
  assert.deepEqual(Object.keys(second.body.changes[0]).sort(),
    ['kind','noteId','projectId','revision']);
  const db=new DatabaseSync(fx.stage.databasePath);
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','dave','viewer')").run(); db.close();
  const newcomer=await page(dave); assert.equal(newcomer.status,200);
  assert.equal((await page(dave,'team-area',100,newcomer.body.cursor)).body.changes.length,0);
});
test('uniform cursor denial, inaccessible Area, and live witness/epoch guards',async()=>{
  const fx=fixture(), bob=login(fx,'bob');
  const boot=await page(bob); assert.equal(boot.status,200);
  assert.deepEqual(await page(bob,'team-area',100,'bad'),{status:409,body:{code:'resync_required'}});
  assert.deepEqual(await page(bob,'missing',100,'bad'),{status:404,body:{error:'Not found'}});
  const hash=durable.hashTargetStagingSessionToken(bob.split('=')[1]);
  const child=await readStagingNoteSyncInChild({...fx.store,ownerUserId:'alice',sessionTokenHash:hash,
    noteSyncSecret:process.env.AI_EXECUTIVE_SESSION_SECRET},'team-area',100);
  assert.equal(child?.ok,true,JSON.stringify(child));
  const release=()=>verifyStagingReadBeforeRelease(req(bob),{kind:'session',tokenHash:hash},fx.store,'alice',
    child.page.linearization,undefined,undefined,undefined,{...child.stamp,epoch:child.epoch});
  assert.equal(release(),'ok');
  const db=new DatabaseSync(fx.stage.databasePath); db.exec('PRAGMA foreign_keys=ON');
  db.prepare("UPDATE projects SET title='changed' WHERE id='parent'").run(); assert.equal(release(),'stale');
  db.close();
  const dead=durable.verifyDurableTargetStagingSessionLive(fx.store,hash);
  const preRevoke=await readStagingNoteSyncInChild({...fx.store,ownerUserId:'alice',sessionTokenHash:hash,
    noteSyncSecret:process.env.AI_EXECUTIVE_SESSION_SECRET},'team-area',100);
  assert.equal(preRevoke?.ok,true);
  durable.revokeDurableTargetStagingSession(fx.store,dead.sessionId);
  assert.equal(verifyStagingReadBeforeRelease(req(bob),{kind:'session',tokenHash:hash},fx.store,'alice',
    preRevoke.page.linearization,undefined,undefined,undefined,
    {...preRevoke.stamp,epoch:preRevoke.epoch}),'session_revoked');
  assert.equal((await page(bob)).body.code,'session_revoked');
});
test('strict child DTO rejects extra keys and repeated sequences',()=>{
  const fake={ok:true,epoch:0,stamp:{areaId:'team-area',contentRevision:2,head:2},
    page:{phase:'changes',entries:[],changes:[{seq:1,kind:'edit',noteId:'one',projectId:null,revision:1},
      {seq:2,kind:'delete',noteId:'one',projectId:null,revision:2}],more:false,
      cursor:'a'.repeat(NOTE_SYNC_CURSOR_LENGTH),linearization:{actorUserId:'bob',areas:[{areaId:'team-area',areaKind:'shared',access:'editor',policyRevision:0}]}}};
  assert.equal(parseStagingNoteSyncResult(fake,'team-area',100)?.ok,true);
  assert.equal(parseStagingNoteSyncResult({...fake,page:{...fake.page,changes:[fake.page.changes[0],
    {...fake.page.changes[1],seq:1}]}},'team-area',100),null);
  assert.equal(parseStagingNoteSyncResult({...fake,unexpected:'secret'},'team-area',100),null);
});

test('release denies note, membership, parent move and restore changes after child snapshot',async()=>{
  const fx=fixture(), bob=login(fx,'bob');
  const tokenHash=durable.hashTargetStagingSessionToken(bob.split('=')[1]);
  const identity={kind:'session',tokenHash};
  const config={...fx.store,ownerUserId:'alice',sessionTokenHash:tokenHash,
    noteSyncSecret:process.env.AI_EXECUTIVE_SESSION_SECRET};
  const snapshot=async()=>{
    const result=await readStagingNoteSyncInChild(config,'team-area',100);
    assert.equal(result?.ok,true,JSON.stringify(result)); return result;
  };
  const release=result=>verifyStagingReadBeforeRelease(req(bob),identity,fx.store,'alice',
    result.page.linearization,undefined,undefined,undefined,{...result.stamp,epoch:result.epoch});
  let result=await snapshot(); assert.equal(release(result),'ok');
  const db=new DatabaseSync(fx.stage.databasePath); db.exec('PRAGMA foreign_keys=ON');
  db.prepare("UPDATE notes SET body='Changed' WHERE id='one'").run();
  assert.equal(release(result),'stale');
  result=await snapshot();
  db.prepare("UPDATE projects SET title='Changed' WHERE id='parent'").run();
  assert.equal(release(result),'stale');
  result=await snapshot();
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal(release(result),'stale');
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  result=await snapshot();
  db.prepare("UPDATE area_members SET role='viewer' WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal(release(result),'stale');
  db.prepare("UPDATE area_members SET role='editor' WHERE area_id='team-area' AND user_id='bob'").run();
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('other-space','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('other','Other','shared','other-space','alice')").run();
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('other','alice','admin')").run();
  result=await snapshot();
  db.prepare("UPDATE notes SET project_id=NULL,area_id='other' WHERE id='child'").run();
  assert.equal(release(result),'stale');
  result=await snapshot();
  db.prepare("UPDATE metadata SET value=? WHERE key='restore_generation'").run(randomUUID());
  assert.equal(release(result),'unavailable');
  db.close();
});

test('raw create and remove/readd require bootstrap; owner epoch changes before release',async()=>{
  const fx=fixture(), bob=login(fx,'bob');
  const first=await page(bob); assert.equal(first.status,200);
  const db=new DatabaseSync(fx.stage.databasePath); db.exec('PRAGMA foreign_keys=ON');
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('new','team-area','New','Body')").run();
  assert.deepEqual(await page(bob,'team-area',100,first.body.cursor),
    {status:409,body:{code:'resync_required'}});
  const fresh=await page(bob); assert.equal(fresh.status,200);
  db.prepare("DELETE FROM area_members WHERE area_id='team-area' AND user_id='bob'").run();
  assert.equal((await page(bob,'team-area',100,fresh.body.cursor)).status,404);
  db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area','bob','editor')").run();
  assert.deepEqual(await page(bob,'team-area',100,fresh.body.cursor),
    {status:409,body:{code:'resync_required'}});
  const ownerCookie=owner();
  const ownerChild=await readStagingNoteSyncInChild({...fx.store,ownerUserId:'alice',
    noteSyncSecret:process.env.AI_EXECUTIVE_SESSION_SECRET},'team-area',100);
  assert.equal(ownerChild?.ok,true);
  const oldEpoch=ownerChild.epoch;
  db.prepare('UPDATE identities SET revocation_epoch=revocation_epoch+1 WHERE id=\'alice\'').run();
  assert.equal(verifyStagingReadBeforeRelease(req(ownerCookie),{kind:'owner'},fx.store,'alice',
    ownerChild.page.linearization,undefined,undefined,undefined,
    {...ownerChild.stamp,epoch:oldEpoch}),'stale');
  db.close();
});

test('three default-off gates, authentication and strict query bounds',async()=>{
  const fx=fixture(), bob=login(fx,'bob');
  for (const gate of ['AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED',
    'AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED',
    'AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED']) {
    process.env[gate]='false'; assert.equal((await page(bob)).status,404); process.env[gate]='true';
  }
  const bare=await GET(new Request('http://localhost:3001/api/target-staging/note-sync?areaId=team-area'));
  assert.equal(bare.status,401);
  const invalid=['?areaId=team-area&areaId=team-area','?areaId=team-area&unknown=x',
    '?areaId=team-area&limit=0','?areaId=team-area&limit=101','?limit=1'];
  for (const query of invalid) {
    const response=await GET(new Request('http://localhost:3001/api/target-staging/note-sync'+query,
      {headers:{cookie:bob,'x-forwarded-for':'10.22.33.44'}}));
    assert.equal(response.status,400,query);
  }
  assert.equal((await page(bob,'team-area',100,'bad')).status,409);
});


test('note session scope is derived from live authorized actor/Area/generation, never query identity', async () => {
  const fx = fixture();
  const bob = login(fx, 'bob'), carol = login(fx, 'carol'), dave = login(fx, 'dave');
  const check = async (cookie, area = 'team-area', extra = '') => {
    const response = await NOTE_SESSION(new Request('http://localhost:3001/api/target-staging/note-sync-session?areaId=' +
      encodeURIComponent(area) + extra, {
      headers: { cookie, 'x-forwarded-for': '10.22.33.44' },
    }));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  };
  const allowedBob = await check(bob);
  assert.deepEqual(allowedBob, { status: 200, body: { version: 1, scope: {
    userId: 'bob', areaId: 'team-area', restoreGeneration: fx.stage.restoreGeneration,
  } } });
  assert.deepEqual((await check(carol)).body.scope.userId, 'carol');
  assert.deepEqual((await check(owner())).body.scope.userId, 'alice');
  assert.deepEqual(await check(dave), { status: 404, body: { error: 'Not found' } });
  assert.equal((await check(bob, 'private-alice')).status, 404);
  for (const extra of ['&userId=alice', '&areaId=team-area', '&restoreGeneration=foo',
    '&cursor=abc', '&limit=100']) {
    assert.equal((await check(bob, 'team-area', extra)).status, 400, extra);
  }
  assert.equal((await NOTE_SESSION(new Request('http://localhost:3001/api/target-staging/note-sync-session?areaId=team-area'))).status, 401);

  const hash = durable.hashTargetStagingSessionToken(bob.split('=')[1]);
  const live = durable.verifyDurableTargetStagingSessionLive(fx.store, hash);
  assert.equal(live.ok, true);
  assert.equal(durable.revokeDurableTargetStagingSession(fx.store, live.sessionId).ok, true);
  assert.equal((await check(bob)).body.code, 'session_revoked');
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED = 'false';
  assert.equal((await check(carol)).status, 404);
  process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED = 'true';
});
