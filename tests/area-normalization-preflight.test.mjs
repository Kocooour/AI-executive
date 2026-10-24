import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
const { createAreaPreflight, verifyAreaPreflight, areaSnapshotSha256 } = await import("../lib/area-normalization-preflight.ts");
const { AreaNormalizationBlocked, planAreaNormalization } = await import("../lib/area-normalization.ts");
const e = (id, type, properties = {}) => ({ id, type, workspaceId:"personal", title:id,
  status:type==="task"?"open":"active", properties, createdAt:1, updatedAt:2 });
const before = () => ({ entities:[e("workspace:personal","workspace",{kind:"personal", role:"owner", members:[]}),
  e("project","project"), e("task","task",{notes:"SECRET-CONTENT"})],
  relations:[{id:"r1", sourceEntityId:"task", targetEntityId:"project",
    relationType:"belongs_to_project",workspaceId:"personal",createdAt:1}] });
const meta = () => ({ revision:7, restoreGeneration:3, tombstones:[] });
const blocked = (fn, reason) => assert.throws(fn, x => x instanceof AreaNormalizationBlocked && x.issues.includes(reason));

test("manifest is content-free; 2a preserves all original records", () => {
  const source=before(), saved=structuredClone(source);
  const p=createAreaPreflight(source,meta(),20);
  assert.equal(p.addedAreas,1); assert.equal(p.inheritedTasks,1); assert.equal(p.addedRelations,1);
  assert.notEqual(p.sourceSha256,p.targetSha256);
  assert.deepEqual(verifyAreaPreflight(source,meta(),p),p);
  assert.deepEqual(source,saved);
  assert.ok(!JSON.stringify(p).includes("SECRET-CONTENT"));
});
test("stale entity text, relation, revision and restore generation fail closed", () => {
  const p=createAreaPreflight(before(),meta(),20);
  const changed=before(); changed.entities[2].properties.notes="changed";
  blocked(()=>verifyAreaPreflight(changed,meta(),p),"preflight-source-drift");
  const moved=before(); moved.relations[0].targetEntityId="missing";
  blocked(()=>verifyAreaPreflight(moved,meta(),p),"preflight-source-drift");
  blocked(()=>verifyAreaPreflight(before(),{...meta(),revision:8},p),"preflight-source-drift");
  blocked(()=>verifyAreaPreflight(before(),{...meta(),restoreGeneration:4},p),"preflight-source-drift");
});
test("hash stable under field and row permutations; tombstone collision blocks", () => {
  const s=before(), swap={entities:[...s.entities].reverse().map(x=>({updatedAt:x.updatedAt,...x})),relations:s.relations};
  assert.equal(areaSnapshotSha256(s, []),areaSnapshotSha256(swap, []));
  const id=planAreaNormalization(s,20).report.createdAreaIds[0];
  blocked(()=>createAreaPreflight(s,{...meta(),tombstones:[{id,deletedAt:19}]},20),"tombstoned-generated-area-id:"+id);
});
test("any tombstone addition, removal or deletedAt change invalidates an approved manifest", () => {
  const identity={...meta(),tombstones:[{id:"deleted-task",deletedAt:7},{id:"deleted-note",deletedAt:12}]};
  const manifest=createAreaPreflight(before(),identity,20);
  const permuted={...identity,tombstones:[...identity.tombstones].reverse()};
  assert.deepEqual(verifyAreaPreflight(before(),permuted,manifest),manifest);
  const changed={...identity,tombstones:[{id:"deleted-task",deletedAt:8},identity.tombstones[1]]};
  blocked(()=>verifyAreaPreflight(before(),changed,manifest),"preflight-source-drift");
  const removed={...identity,tombstones:identity.tombstones.slice(0,1)};
  blocked(()=>verifyAreaPreflight(before(),removed,manifest),"preflight-source-drift");
  const added={...identity,tombstones:[...identity.tombstones,{id:"another",deletedAt:13}]};
  blocked(()=>verifyAreaPreflight(before(),added,manifest),"preflight-source-drift");
  blocked(()=>createAreaPreflight(before(),{...meta(),tombstones:[{id:"x",deletedAt:-1}]},20),"invalid-source-identity");
});
test("already normalized snapshot is a no-op", () => {
  const after=planAreaNormalization(before(),20);
  const p=createAreaPreflight(after,meta(),21);
  assert.equal(p.noChanges,true); assert.equal(p.addedAreas,0);
});
// Synthetic SQLite fixtures model the real server schema and save semantics.
function withOfflineStore(runChecks) {
  const dir=mkdtempSync(path.join(tmpdir(),"lumi-2a-"));
  const file=path.join(dir,"copy.sqlite");
  const run=()=>spawnSync(process.execPath,["--experimental-loader","./tests/ts-loader.mjs",
    "scripts/preflight-area-normalization.mjs","--offline-copy",file],{encoding:"utf8",timeout:15000});
  const change=(statement,...args)=>{
    const db=new DatabaseSync(file);
    try { db.prepare(statement).run(...args); } finally { db.close(); }
  };
  try {
    const db=new DatabaseSync(file);
    db.exec("CREATE TABLE entities(id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE relations(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE tombstones(id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    const insertE=db.prepare("INSERT INTO entities VALUES (?,?,?)");
    for(const x of before().entities)insertE.run(x.id,JSON.stringify(x),x.updatedAt);
    const insertR=db.prepare("INSERT INTO relations VALUES (?,?,?)");
    for(const x of before().relations)insertR.run(x.id,JSON.stringify(x),x.createdAt);
    db.prepare("INSERT INTO metadata VALUES ('revision','7')").run();
    db.prepare("INSERT INTO tombstones VALUES ('deleted-note', 12)").run();
    // Do not insert restoreGeneration: a fresh real server legitimately has no such row.
    db.close();
    runChecks({run,change});
  } finally {rmSync(dir,{recursive:true,force:true});}
}
function successful(run) {
  const result=run();
  assert.equal(result.status,0,result.stderr);
  assert.ok(!result.stdout.includes("SECRET-CONTENT")&&!result.stderr.includes("SECRET-CONTENT"));
  return JSON.parse(result.stdout);
}
function rejected(run,issue) {
  const result=run();
  assert.equal(result.status,1,result.stdout);
  assert.match(result.stderr,new RegExp(issue));
  assert.ok(!result.stderr.includes("SECRET-CONTENT"));
}

test("CLI accepts absent restoreGeneration as zero, stored zero and post-restore positive integer", () => {
  withOfflineStore(({run,change})=>{
    const fresh=successful(run);
    assert.equal(fresh.restoreGeneration,0);
    change("INSERT INTO metadata VALUES ('restoreGeneration','0')");
    assert.equal(successful(run).restoreGeneration,0);
    change("UPDATE metadata SET value='3' WHERE key='restoreGeneration'");
    assert.equal(successful(run).restoreGeneration,3);
    change("DELETE FROM metadata WHERE key='revision'");
    rejected(run,"missing-store-revision");
  });
});
test("CLI rejects any present malformed restoreGeneration or revision", () => {
  withOfflineStore(({run,change})=>{
    for(const malformed of ["", "-1", "3.5", "NaN", "9007199254740992"]) {
      change("INSERT INTO metadata(key,value) VALUES('restoreGeneration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",malformed);
      rejected(run,"invalid-store-restore-generation");
    }
    change("UPDATE metadata SET value='5' WHERE key='restoreGeneration'");
    change("UPDATE metadata SET value='not-a-revision' WHERE key='revision'");
    rejected(run,"invalid-store-revision");
  });
});
test("CLI refuses tampered payload IDs and SQL mirror timestamps", () => {
  withOfflineStore(({run,change})=>{
    assert.equal(successful(run).status,"offline-preflight-only");
    change("UPDATE relations SET payload=? WHERE id='r1'",JSON.stringify({...before().relations[0],id:"forged"}));
    rejected(run,"relation-id-disagrees");
    change("UPDATE relations SET payload=? WHERE id='r1'",JSON.stringify(before().relations[0]));
    change("UPDATE entities SET payload=? WHERE id='task'",JSON.stringify({...before().entities[2],id:"forged"}));
    rejected(run,"entity-id-disagrees");
    change("UPDATE entities SET payload=? WHERE id='task'",JSON.stringify(before().entities[2]));
    change("UPDATE entities SET updated_at=999 WHERE id='task'");
    rejected(run,"entity-timestamp-disagrees");
    change("UPDATE entities SET updated_at=2 WHERE id='task'");
    change("UPDATE relations SET created_at=999 WHERE id='r1'");
    rejected(run,"relation-timestamp-disagrees");
    change("UPDATE relations SET created_at=1 WHERE id='r1'");
    assert.equal(successful(run).status,"offline-preflight-only");
  });
});
test("CLI fingerprint covers exact tombstone timestamps and removals without revision changes", () => {
  withOfflineStore(({run,change})=>{
    const beforeHash=successful(run).sourceSha256;
    change("UPDATE tombstones SET deleted_at=13 WHERE id='deleted-note'");
    const afterUpdate=successful(run).sourceSha256;
    assert.notEqual(afterUpdate,beforeHash);
    change("DELETE FROM tombstones WHERE id='deleted-note'");
    const afterRemove=successful(run).sourceSha256;
    assert.notEqual(afterRemove,afterUpdate);
  });
});

test("preflight explicitly reports legacy Area kind backfill as an activation blocker", () => {
  const source = before();
  source.entities.push(e("old-area", "area", {}));
  source.relations.push({ id:"area-link",sourceEntityId:"project",targetEntityId:"old-area",
    relationType:"belongs_to_area",workspaceId:"personal",createdAt:1 });
  const p = createAreaPreflight(source, meta(), 20);
  assert.equal(p.pendingAreaKindBackfills, 1);
  assert.equal(p.areaKindBackfillRequired, true);
  assert.equal(p.noChanges, false);
});

test("offline preflight blocks generated links whose IDs are tombstoned", () => {
  const hash = (...parts) => "relation:2a:" +
    createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  const area = e("area-a", "area", { kind: "private" });
  const project = e("project", "project", { areaId: area.id });
  const task = e("task", "task", { projectId: project.id });
  const baseEntities = [before().entities[0], area, project, task];
  const areaLinkId = hash(project.id, area.id);
  blocked(() => createAreaPreflight(
    { entities: baseEntities, relations: [] },
    { ...meta(), tombstones: [{ id: areaLinkId, deletedAt: 10 }] }, 20,
  ), "tombstoned-generated-area-relation-id:" + areaLinkId);

  const projectLinkId = hash("project", task.id, project.id);
  blocked(() => createAreaPreflight(
    { entities: baseEntities, relations: [] },
    { ...meta(), tombstones: [{ id: projectLinkId, deletedAt: 10 }] }, 20,
  ), "tombstoned-generated-project-relation-id:" + projectLinkId);
});

test("preflight accepts audited duplicate project memberships from current 2a planner", () => {
  const source = before();
  source.relations.push({ ...source.relations[0], id: "r2", createdAt: 2 });
  const report = createAreaPreflight(source, meta(), 20);
  assert.equal(report.removedRelations, 1);
  assert.equal(report.after.relations, report.before.relations - 1 + report.addedRelations);
  assert.deepEqual(verifyAreaPreflight(source, meta(), report), report);
});
