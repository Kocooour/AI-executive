import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

// R2d.2c.2g.2b.5: schema v24 note journal floors, guarded delete, operator-only compaction and the
// note sync behaviour behind the floor. Synthetic identities and temp stores only.
const names = ['NODE_ENV','AI_EXECUTIVE_DATA_DIR','AI_EXECUTIVE_SECURITY_ALERT_FILE',
  'AI_EXECUTIVE_AUTH_ENABLED','AI_EXECUTIVE_PASSWORD_HASH','AI_EXECUTIVE_SESSION_SECRET',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED','AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED','AI_EXECUTIVE_TARGET_STAGING_DIRECTORY',
  'AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED','AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED',
  'AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION','AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID'];
const old = Object.fromEntries(names.map(k => [k, process.env[k]]));
const root = mkdtempSync(path.join(os.tmpdir(), 'lumi-note-journal-retention-'));
const legacy = path.join(root, 'production-sentinel'); mkdirSync(legacy);
writeFileSync(path.join(legacy, 'keep'), 'untouched');
process.env.NODE_ENV = 'production';
process.env.AI_EXECUTIVE_DATA_DIR = legacy;
process.env.AI_EXECUTIVE_SECURITY_ALERT_FILE = path.join(root, 'security-alerts.log');
process.env.AI_EXECUTIVE_AUTH_ENABLED = 'true';
process.env.AI_EXECUTIVE_PASSWORD_HASH = 'scrypt:' + Buffer.alloc(16, 1).toString('base64url') + ':' + Buffer.alloc(64, 2).toString('base64url');
process.env.AI_EXECUTIVE_SESSION_SECRET = 'note-journal-retention-secret-long-enough';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_ENABLED = 'true';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_ENABLED = 'true';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTE_SYNC_ENABLED = 'true';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_WRITE_ENABLED = 'true';
process.env.AI_EXECUTIVE_TARGET_STAGING_HTTP_NOTES_WRITE_ENABLED = 'true';
const { bootstrapIsolatedTargetStore, TARGET_STORE_SCHEMA_VERSION } = await import('../lib/target-store-bootstrap.ts');
const { inspectIsolatedTargetStore } = await import('../lib/target-store-preflight.ts');
const durable = await import('../lib/target-staging-durable-session.ts');
const { GET } = await import('../app/api/target-staging/note-sync/route.ts');
const { GET: PREVIEW, PATCH: EDIT } = await import('../app/api/target-staging/notes/[noteId]/edit/route.ts');
const { compactTargetStagingNoteJournal } = await import('../lib/target-staging-note-journal-compaction.ts');
const REAL_NODE = process.execPath;
after(() => { for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v;
  assert.equal(readFileSync(path.join(legacy, 'keep'), 'utf8'), 'untouched');
  rmSync(root, { recursive: true, force: true }); });

const DAY = 86_400_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ipCounter = 0;
const ip = () => `10.31.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function fixture() {
  const stage = bootstrapIsolatedTargetStore({ stagingDirectory: path.join(root, randomUUID()), ownerUserId: 'alice' });
  const db = new DatabaseSync(stage.databasePath);
  db.exec('PRAGMA foreign_keys=ON');
  for (const id of ['bob', 'carol']) {
    db.prepare('INSERT INTO identities(id) VALUES (?)').run(id);
    db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES (?,'personal',?)").run('personal-' + id, id);
    db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id,system_key) VALUES (?,'Unassigned','private',?,?,'unassigned')")
      .run('private-' + id, 'personal-' + id, id);
  }
  db.prepare("INSERT INTO workspaces(id,kind,owner_user_id) VALUES ('team','shared','alice')").run();
  db.prepare("INSERT INTO areas(id,title,kind,workspace_id,owner_user_id) VALUES ('team-area','Team','shared','team','alice')").run();
  for (const [id, role] of [['alice', 'admin'], ['bob', 'editor'], ['carol', 'viewer']])
    db.prepare("INSERT INTO area_members(area_id,user_id,role) VALUES ('team-area',?,?)").run(id, role);
  for (const id of ['one', 'two']) db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES (?,'team-area',?,'Body')").run(id, id);
  db.prepare("INSERT INTO notes(id,area_id,title,body) VALUES ('mine','private-bob','mine','Body')").run();
  db.close();
  process.env.AI_EXECUTIVE_TARGET_STAGING_DIRECTORY = stage.directory;
  process.env.AI_EXECUTIVE_TARGET_STAGING_RESTORE_GENERATION = stage.restoreGeneration;
  process.env.AI_EXECUTIVE_TARGET_STAGING_OWNER_USER_ID = 'alice';
  return { stage, store: { stagingDirectory: stage.directory, expectedRestoreGeneration: stage.restoreGeneration } };
}
const open = fx => { const db = new DatabaseSync(fx.stage.databasePath); db.exec('PRAGMA foreign_keys=ON'); return db; };
const login = (fx, id) => { const x = durable.issueDurableTargetStagingSession(fx.store, id, 900);
  assert.equal(x.ok, true); return durable.TARGET_STAGING_SESSION_COOKIE + '=' + x.sessionToken; };
const preflight = fx => inspectIsolatedTargetStore({ stagingDirectory: fx.stage.directory,
  expectedRestoreGeneration: fx.stage.restoreGeneration, mode: 'r2-model' });
async function edit(cookie, noteId, body) {
  const url = `http://localhost:3001/api/target-staging/notes/${noteId}/edit`;
  const ctx = { params: Promise.resolve({ noteId }) };
  const headers = { cookie, 'x-forwarded-for': ip() };
  const preview = await PREVIEW(new Request(url, { headers }), ctx);
  assert.equal(preview.status, 200);
  const response = await EDIT(new Request(url, { method: 'PATCH', body: JSON.stringify({ ...await preview.json(),
    commandId: randomUUID(), title: noteId, body }),
  headers: { ...headers, origin: 'http://localhost:3001', 'content-type': 'application/json', 'x-lumi-target-protocol': '1' } }), ctx);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
}
function req(cookie, area, cursor) {
  const url = new URL('http://localhost:3001/api/target-staging/note-sync');
  url.searchParams.set('areaId', area); url.searchParams.set('limit', '100');
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);
  return new Request(url, { headers: { cookie, 'x-forwarded-for': ip() } });
}
async function page(cookie, area = 'team-area', cursor) {
  const r = await GET(req(cookie, area, cursor)); return { status: r.status, body: await r.json() };
}
const floors = db => Object.fromEntries(db.prepare('SELECT area_id,floor_seq,revision FROM note_journal_floors').all()
  .map(r => [r.area_id, [r.floor_seq, r.revision]]));
const seqs = (db, area) => db.prepare('SELECT seq FROM note_change_journal WHERE area_id=? ORDER BY seq').all(area).map(r => r.seq);

/** Team Area: 2 old edits then (after a gap) 2 recent edits; bob's private Area: 1 old edit. */
async function populate(fx) {
  const bob = login(fx, 'bob');
  await edit(bob, 'one', 'v1'); await edit(bob, 'two', 'v1'); await edit(bob, 'mine', 'v1');
  await sleep(40);
  const mid = Date.now();
  await sleep(40);
  await edit(bob, 'one', 'v2'); await edit(bob, 'two', 'v2');
  return { bob, mid, cutoffNow: mid + 7 * DAY };
}

test('schema v24: one floor per Area (also for later Areas), guarded delete, floor trigger rules', async () => {
  assert.equal(TARGET_STORE_SCHEMA_VERSION, 25);
  const fx = fixture();
  const db = open(fx);
  assert.deepEqual(floors(db), { 'area:unassigned:alice': [0, 0], 'private-bob': [0, 0], 'private-carol': [0, 0], 'team-area': [0, 0] });
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  await populate(fx);
  const update = (floor, revision, area = 'team-area') =>
    db.prepare('UPDATE note_journal_floors SET floor_seq=?,revision=? WHERE area_id=?').run(floor, revision, area);
  assert.deepEqual(seqs(db, 'team-area'), [1, 2, 3, 4]);
  // Floor 0: nothing may be deleted.
  assert.throws(() => db.exec("DELETE FROM note_change_journal WHERE area_id='team-area' AND seq=1"), /compacted at or below the floor/);
  assert.throws(() => update(5, 1), /may only increase up to the newest sequence/, 'never above MAX(seq)');
  assert.throws(() => update(2, 5), /may only increase/, 'revision must be +1');
  assert.throws(() => update(0, 1), /may only increase/, 'must strictly increase');
  assert.throws(() => db.exec("UPDATE note_journal_floors SET area_id='private-bob' WHERE area_id='team-area'"));
  update(2, 1);
  assert.throws(() => update(1, 2), /may only increase/, 'monotonic');
  assert.throws(() => update(2, 2), /may only increase/);
  // Only rows at or below the floor can go; direct SQL above it is rejected.
  assert.throws(() => db.exec("DELETE FROM note_change_journal WHERE area_id='team-area' AND seq=3"), /compacted at or below the floor/);
  assert.throws(() => db.exec("DELETE FROM note_change_journal WHERE area_id='team-area'"), /compacted at or below the floor/);
  assert.throws(() => db.exec("DELETE FROM note_change_journal WHERE area_id='private-bob' AND seq=1"), /compacted at or below the floor/,
    "another Area's floor does not apply");
  // Preflight flags the inconsistent state (rows <= floor still present), then deletes repair it.
  assert.ok(preflight(fx).issues.includes('note_sync_journal_invalid'));
  assert.equal(db.prepare("DELETE FROM note_change_journal WHERE area_id='team-area' AND seq<=2").run().changes, 2);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  assert.throws(() => db.exec("INSERT INTO note_change_journal(area_id,seq,kind,receipt_key,actor_user_id,note_id,policy_revision,revision,committed_at_ms)"
    + " VALUES ('team-area',2,'edit','forged','bob','one',0,1,1000)"), /must follow the floor/);
  // Floor rows cannot be deleted, replaced or created out of line.
  assert.throws(() => db.exec("DELETE FROM note_journal_floors WHERE area_id='team-area'"), /cannot be deleted/);
  assert.throws(() => db.exec("INSERT OR REPLACE INTO note_journal_floors(area_id,floor_seq,revision) VALUES ('team-area',0,0)"), /cannot be created or replaced/);
  assert.throws(() => db.exec("INSERT INTO note_journal_floors(area_id,floor_seq,revision) VALUES ('nope',0,0)"));
  assert.deepEqual(floors(db)['team-area'], [2, 1]);
  db.close();
});

test('compaction: per-Area floors from retention, independent Areas, seq never reused, capacity freed, HTTP cursors', async () => {
  const fx = fixture();
  const { bob, mid, cutoffNow } = await populate(fx);
  const carol = login(fx, 'carol');
  const db = open(fx);
  const before = db.prepare('SELECT COUNT(*) AS n FROM note_change_journal').get().n;
  assert.equal(before, 5);
  // A cursor taken at head 4 and one taken at head 2 are produced by replaying: bootstrap now.
  const boot = await page(bob); assert.equal(boot.status, 200);
  const bootCursor = boot.body.cursor; // afterSeq 4
  for (const days of [0, 6, -1, 1.5, NaN, 7.0001, 36_501]) {
    assert.deepEqual(compactTargetStagingNoteJournal(fx.store, { retentionDays: days, now: cutoffNow }),
      { ok: false, reason: 'invalid_request' }, String(days));
  }
  assert.deepEqual(compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now: 0 }), { ok: false, reason: 'invalid_request' });
  assert.deepEqual(floors(db)['team-area'], [0, 0]);

  // Nothing is old enough yet.
  assert.deepEqual(compactTargetStagingNoteJournal(fx.store, { retentionDays: 30, now: Date.now() }), { ok: true, areas: 0, deleted: 0 });
  const result = compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now: cutoffNow });
  // team-area: first recent row is seq 3 -> floor 2; private-bob has only an old row -> floor 1.
  assert.deepEqual(result, { ok: true, areas: 2, deleted: 3 });
  assert.deepEqual({ t: floors(db)['team-area'], b: floors(db)['private-bob'], c: floors(db)['private-carol'] },
    { t: [2, 1], b: [1, 1], c: [0, 0] });
  assert.deepEqual(seqs(db, 'team-area'), [3, 4]);
  assert.deepEqual(seqs(db, 'private-bob'), []);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  // Idempotent, and a later (younger) cutoff never lowers a floor.
  assert.deepEqual(compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now: cutoffNow }), { ok: true, areas: 0, deleted: 0 });
  assert.deepEqual(compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now: mid }), { ok: true, areas: 0, deleted: 0 });

  // HTTP: a cursor at head 4 (above the floor 2) is unaffected; the edit stream continues densely.
  assert.deepEqual((await page(bob, 'team-area', bootCursor)).body.changes, []);
  await edit(bob, 'one', 'v3');
  const above = await page(bob, 'team-area', bootCursor);
  assert.equal(above.status, 200);
  assert.deepEqual(above.body.changes, [{ kind: 'edit', noteId: 'one', projectId: null, revision: 3 }]);
  assert.deepEqual(seqs(db, 'team-area'), [3, 4, 5]);

  // Reader-level: a cursor behind the floor is refused (resync_required), with exactly-at-floor served.
  // Craft the cursors by sealing positions for the same scope as the route does.
  const { sealTargetNoteSyncCursor } = await import('../lib/target-note-sync-cursor.ts');
  const scope = await scopeOf(fx, 'bob', 'team-area');
  const at = afterSeq => sealTargetNoteSyncCursor(process.env.AI_EXECUTIVE_SESSION_SECRET, scope,
    { phase: 'changes', afterSeq, contentRevision: afterSeq + 2 });
  const behind = await page(bob, 'team-area', at(1));
  assert.deepEqual(behind, { status: 409, body: { code: 'resync_required' } });
  const exactlyAtFloor = await page(bob, 'team-area', at(2));
  assert.equal(exactlyAtFloor.status, 200, JSON.stringify(exactlyAtFloor.body));
  assert.deepEqual(exactlyAtFloor.body.changes.map(c => c.revision), [2, 2, 3]);
  // Fully compacted private Area: head stays 1, bootstrap starts at the head, the next edit is seq 2.
  const privateBoot = await page(bob, 'private-bob');
  assert.equal(privateBoot.status, 200);
  assert.deepEqual(privateBoot.body.entries.map(e => e.id), ['mine']);
  await edit(bob, 'mine', 'v2');
  assert.deepEqual(seqs(db, 'private-bob'), [2]);
  const next = await page(bob, 'private-bob', privateBoot.body.cursor);
  assert.deepEqual(next.body.changes, [{ kind: 'edit', noteId: 'mine', projectId: null, revision: 2 }]);
  assert.equal((await page(carol)).status, 200);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));

  // Full compaction: every row goes, capacity is freed, sequences continue after the floor.
  const full = compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now: Date.now() + 8 * DAY });
  assert.equal(full.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM note_change_journal').get().n, 0, 'capacity counts live rows only');
  assert.deepEqual(floors(db)['team-area'], [5, 2]);
  assert.deepEqual(floors(db)['private-bob'], [2, 2]);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  const staleAfterFull = await page(bob, 'team-area', bootCursor);
  assert.deepEqual(staleAfterFull, { status: 409, body: { code: 'resync_required' } });
  const fresh = await page(bob);
  assert.equal(fresh.status, 200);
  await edit(bob, 'two', 'v3');
  assert.deepEqual(seqs(db, 'team-area'), [6], 'a fully compacted Area never reuses a sequence');
  const tail = await page(bob, 'team-area', fresh.body.cursor);
  assert.equal(tail.status, 200, JSON.stringify(tail.body));
  assert.deepEqual(tail.body.changes, [{ kind: 'edit', noteId: 'two', projectId: null, revision: 3 }]);
  assert.equal(preflight(fx).ok, true, JSON.stringify(preflight(fx)));
  db.close();
});
async function scopeOf(fx, user, areaId) {
  const db = open(fx);
  try {
    const row = db.prepare('SELECT revocation_epoch AS e FROM identities WHERE id=?').get(user);
    const area = db.prepare('SELECT policy_revision AS p FROM areas WHERE id=?').get(areaId);
    return { actorUserId: user, sessionEpoch: row.e, restoreGeneration: fx.stage.restoreGeneration, areaId,
      policyRevision: area.p, access: 'editor' };
  } finally { db.close(); }
}

test('preflight detects tampered floors and journals', async () => {
  const fx = fixture();
  const { cutoffNow } = await populate(fx);
  assert.equal(compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now: cutoffNow }).ok, true);
  assert.equal(preflight(fx).ok, true);
  const tamper = sql => { const db = open(fx); try { db.exec(sql); } finally { db.close(); } };
  const flagged = () => { const r = preflight(fx); assert.equal(r.ok, false); return r.issues; };
  // Dropping a guard trigger is itself a schema change; the data checks also fail on their own.
  tamper('DROP TRIGGER note_journal_floors_update; UPDATE note_journal_floors SET floor_seq=1 WHERE area_id=\'team-area\'');
  assert.ok(flagged().includes('note_sync_journal_invalid'), 'floor lowered: audits no longer reconcile');
  const second = fixture();
  const populated = await populate(second);
  compactTargetStagingNoteJournal(second.store, { retentionDays: 7, now: populated.cutoffNow });
  const db = open(second);
  db.exec('UPDATE note_journal_floors SET floor_seq=3, revision=2 WHERE area_id=\'team-area\'');
  db.close();
  assert.ok(preflight(second).issues.includes('note_sync_journal_invalid'), 'floor above a live row');
  const third = fixture();
  await populate(third);
  const d3 = open(third);
  d3.exec('DROP TRIGGER note_change_journal_guarded_delete; DELETE FROM note_change_journal WHERE area_id=\'team-area\' AND seq=1');
  d3.close();
  assert.ok(preflight(third).issues.includes('note_sync_journal_invalid'), 'row deleted without a floor');
});

test('operator CLI: strict arguments, dry minimum, JSON result; hot journal and wrong generation refused', async () => {
  const fx = fixture();
  const { cutoffNow } = await populate(fx);
  const run = (...args) => {
    const r = spawnSync(REAL_NODE, ['--experimental-loader', './tests/ts-loader.mjs',
      'scripts/target-staging-compact-note-journal.mjs', ...args], { encoding: 'utf8' });
    return { status: r.status, body: JSON.parse(r.stdout) };
  };
  const common = ['--directory', fx.stage.directory, '--generation', fx.stage.restoreGeneration];
  assert.deepEqual(run(...common, '--retention-days', '3'), { status: 1, body: { ok: false, reason: 'invalid_request' } });
  assert.equal(run('--directory', 'relative', '--generation', fx.stage.restoreGeneration).status, 1);
  assert.equal(run(...common, '--bogus', '1').status, 1);
  assert.equal(run(...common, '--retention-days', '1e1').status, 1);
  // Everything was just written: the default 30 days compacts nothing.
  assert.deepEqual(run(...common), { status: 0, body: { ok: true, areas: 0, deleted: 0 } });
  const db = open(fx);
  assert.deepEqual(floors(db)['team-area'], [0, 0]);
  // An interrupted write / restore leaves a hot rollback journal: refused distinctly, nothing changed.
  writeFileSync(fx.stage.databasePath + '-journal', '');
  assert.deepEqual(compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now: cutoffNow }), { ok: false, reason: 'journal_present' });
  assert.deepEqual(floors(db)['team-area'], [0, 0]);
  rmSync(fx.stage.databasePath + '-journal');
  // The bounded retry never bypasses a mismatched restore generation.
  assert.deepEqual(compactTargetStagingNoteJournal({ ...fx.store, expectedRestoreGeneration: randomUUID() },
    { retentionDays: 7, now: cutoffNow }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(floors(db)['team-area'], [0, 0]);
  assert.equal(preflight(fx).ok, true);
  assert.equal(compactTargetStagingNoteJournal(fx.store, { retentionDays: 7, now: cutoffNow }).ok, true);
  db.close();
}, { timeout: 60_000 });
