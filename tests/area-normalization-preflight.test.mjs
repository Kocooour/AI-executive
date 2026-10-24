import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
const { createAreaPreflight, verifyAreaPreflight, areaSnapshotSha256 } = await import("../lib/area-normalization-preflight.ts");
const { AreaNormalizationBlocked, planAreaNormalization } = await import("../lib/area-normalization.ts");
const e = (id, type, properties = {}) => ({ id, type, workspaceId:"personal", title:id,
  status:type==="task"?"open":"active", properties, createdAt:1, updatedAt:2 });
const before = () => ({ entities:[e("workspace:personal","workspace",{kind:"personal", role:"owner"}),
  e("project","project"), e("task","task",{notes:"SECRET-CONTENT"})],
  relations:[{id:"r1", sourceEntityId:"task", targetEntityId:"project",
    relationType:"belongs_to_project",workspaceId:"personal",createdAt:1}] });
const meta = () => ({ revision:7, restoreGeneration:3, tombstoneIds:[] });
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
  assert.equal(areaSnapshotSha256(s),areaSnapshotSha256(swap));
  const id=planAreaNormalization(s,20).report.createdAreaIds[0];
  blocked(()=>createAreaPreflight(s,{...meta(),tombstoneIds:[id]},20),"area-id-reused");
});
test("already normalized snapshot is a no-op", () => {
  const after=planAreaNormalization(before(),20);
  const p=createAreaPreflight(after,meta(),21);
  assert.equal(p.noChanges,true); assert.equal(p.addedAreas,0);
});
test("CLI opens a synthetic SQLite copy read-only; refuses tampered row IDs", () => {
  const dir=mkdtempSync(path.join(tmpdir(),"lumi-2a-"));
  const file=path.join(dir,"copy.sqlite");
  const run=()=>spawnSync(process.execPath,["--experimental-loader","./tests/ts-loader.mjs",
    "scripts/preflight-area-normalization.mjs","--offline-copy",file],{encoding:"utf8",timeout:15000});
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
    db.prepare("INSERT INTO metadata VALUES ('restoreGeneration','3')").run();
    db.close();
    const good=run();
    assert.equal(good.status,0,good.stderr);
    assert.equal(JSON.parse(good.stdout).status,"offline-preflight-only");
    assert.ok(!good.stdout.includes("SECRET-CONTENT")&&!good.stderr.includes("SECRET-CONTENT"));
    const edit=new DatabaseSync(file);
    edit.prepare("UPDATE relations SET payload=? WHERE id='r1'").run(JSON.stringify({...before().relations[0],id:"forged"}));
    edit.close();
    const bad=run();
    assert.equal(bad.status,1);assert.match(bad.stderr,/relation-id-disagrees/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
