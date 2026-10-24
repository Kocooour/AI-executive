import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-area-apply-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const { mergeSnapshots } = await import("../lib/server-sync.ts");
const { AreaNormalizationBlocked } = await import("../lib/area-normalization.ts");
const { createAreaPreflight, areaSnapshotSha256 } = await import("../lib/area-normalization-preflight.ts");
const { readAreaNormalizationSource } = await import("../lib/area-normalization-source.ts");
const apply = await import("../lib/area-normalization-apply.ts");
const scope = await import("../lib/backup-scope.ts");

const backupsDir = path.join(dataDir, "backups");
const migrationBackups = () => existsSync(backupsDir)
  ? readdirSync(backupsDir).filter(f => f.endsWith("-before-area-normalization.sqlite")) : [];
const ent = (id, type, workspaceId, properties = {}, title = "SECRET " + id) => ({
  id, type, title, workspaceId, properties, status: type === "task" ? "open" : "active", createdAt: 10, updatedAt: 100,
});
const workspace = (id, kind) => ent("workspace:" + id, "workspace", id, { kind, role: "owner", members: [{ id: "owner", role: "owner" }] }, id);
const rel = (id, s, t, type, workspaceId = "personal") =>
  ({ id, sourceEntityId: s, targetEntityId: t, relationType: type, workspaceId, createdAt: 50 });

// Legacy data: personal + shared workspace, redundant task-level links, a label, Areas without kind.
const legacy = () => ({
  entities: [
    workspace("personal", "personal"), workspace("team", "shared"),
    ent("area:old", "area", "personal"), ent("area:team", "area", "team"),
    ent("p1", "project", "personal"),                       // no Area at all
    ent("p2", "project", "personal"), ent("t2", "task", "personal", { projectId: "p2" }),
    ent("t3", "task", "personal"),                          // standalone, no Area
    ent("t4", "task", "personal", { area: "Domov" }),       // legacy free-text label
    ent("sp", "project", "team"), ent("st", "task", "team", { projectId: "sp" }),
  ],
  relations: [
    rel("r:p2-area", "p2", "area:old", "belongs_to_area"), rel("r:t2-proj", "t2", "p2", "belongs_to_project"),
    rel("r:t2-area", "t2", "area:old", "belongs_to_area"),  // redundant: equals the project's Area
    rel("r:sp-area", "sp", "area:team", "belongs_to_area", "team"), rel("r:st-proj", "st", "sp", "belongs_to_project", "team"),
    rel("r:st-area", "st", "area:team", "belongs_to_area", "team"),
  ],
});
// Reset the live store to exactly this snapshot (revision moves on, restoreGeneration is kept).
function seed({ entities, relations }, tombstones = []) {
  const database = store.getDatabase();
  const current = store.readSnapshot();
  database.exec("BEGIN IMMEDIATE");
  store.writeSnapshotRows(database, { revision: current.revision + 1, restoreGeneration: current.restoreGeneration, entities, relations, tombstones, updatedAt: 1 });
  database.exec("COMMIT");
}
const read = () => readAreaNormalizationSource(store.getDatabase());
const sha = () => { const { source, identity } = read(); return areaSnapshotSha256(source, identity.tombstones); };
const preflight = () => { const { source, identity, at } = read(); return createAreaPreflight(source, identity, at); };
const state = () => ({ sha: sha(), snapshot: store.readSnapshot() });
const blocked = (fn, reason) => assert.throws(fn, x => x instanceof AreaNormalizationBlocked && x.issues.includes(reason));
const NOW = () => Date.now() + 1000;

test("happy path: personal + shared workspace, kind backfill, tombstoned redundant links, backup, idempotent", () => {
  // Seed through the real client write path first.
  const base = legacy();
  const current = store.readSnapshot();
  const saved = store.replaceSnapshot(current.revision, base.entities, base.relations, [], [], current.restoreGeneration);
  assert.equal(saved.conflict, false);
  const before = store.readSnapshot();
  const manifest = preflight();
  assert.equal(manifest.noChanges, false);
  assert.equal(manifest.pendingAreaKindBackfills, 2);
  const now = NOW();
  const result = apply.applyAreaNormalization(manifest, { now });
  assert.equal(result.status, "applied");
  assert.equal(result.revisionBefore, before.revision);
  assert.equal(result.revisionAfter, before.revision + 1);
  assert.equal(result.restoreGeneration, before.restoreGeneration);
  assert.equal(result.sourceSha256, manifest.sourceSha256);
  assert.equal(result.appliedAt, now);
  assert.equal(result.counts.tombstonedRelations, 2);
  assert.equal(result.counts.kindBackfills, 2);
  assert.equal(result.counts.inheritedTasks, 2);
  assert.ok(result.counts.createdAreas >= 2);

  const after = store.readSnapshot();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.restoreGeneration, before.restoreGeneration);
  assert.equal(sha(), result.resultSha256);
  // Removed redundant links are absent AND tombstoned (old clients cannot resurrect them).
  for (const id of ["r:t2-area", "r:st-area"]) {
    assert.ok(!after.relations.some(r => r.id === id), id);
    assert.deepEqual(after.tombstones.find(t => t.id === id), { id, deletedAt: now });
  }
  for (const t of before.tombstones) assert.ok(after.tombstones.some(x => x.id === t.id && x.deletedAt === t.deletedAt));
  // Kind backfilled correctly, only kind and updatedAt changed on those Areas.
  const byId = new Map(after.entities.map(e => [e.id, e]));
  assert.equal(byId.get("area:old").properties.kind, "private");
  assert.equal(byId.get("area:team").properties.kind, "shared");
  for (const id of ["area:old", "area:team"]) {
    const old = before.entities.find(e => e.id === id);
    assert.deepEqual({ ...byId.get(id), properties: old.properties, updatedAt: old.updatedAt }, old);
    assert.ok(byId.get(id).updatedAt > old.updatedAt);
  }
  // Every old ID and workspace survives; untouched entities are byte-identical.
  for (const old of before.entities) {
    assert.equal(byId.get(old.id)?.workspaceId, old.workspaceId);
    if (old.type !== "area") assert.deepEqual(byId.get(old.id), old);
  }
  const areas = after.entities.filter(e => e.type === "area");
  assert.ok(areas.some(a => a.workspaceId === "personal" && a.title === "Nezařazeno" && a.properties.kind === "private"));
  assert.ok(areas.some(a => a.workspaceId === "personal" && a.title === "Domov"));
  for (const id of ["p1", "p2", "sp", "t3", "t4"])
    assert.equal(after.relations.filter(r => r.sourceEntityId === id && r.relationType === "belongs_to_area").length, 1, id);
  for (const id of ["t2", "st"])
    assert.equal(after.relations.filter(r => r.sourceEntityId === id && r.relationType === "belongs_to_area").length, 0, id);
  // Backup with the label exists and matches its sidecar and the manifest.
  const [name, ...others] = migrationBackups();
  assert.equal(others.length, 0);
  assert.equal(name, result.backup.name);
  const meta = JSON.parse(readFileSync(path.join(backupsDir, name.replace(/\.sqlite$/, ".meta.json")), "utf8"));
  assert.deepEqual({ sha256: meta.sha256, bytes: meta.bytes }, { sha256: result.backup.sha256, bytes: result.backup.bytes });
  // Idempotence; a second apply is a no-op without another backup.
  assert.equal(preflight().noChanges, true);
  assert.deepEqual(apply.applyAreaNormalization(preflight(), { now: NOW() }), { status: "noop" });
  assert.equal(migrationBackups().length, 1);
  assert.equal(store.readSnapshot().revision, after.revision);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

test("drift after the preflight blocks with no backup and no write", () => {
  seed(legacy());
  const manifest = preflight();
  const edited = legacy(); edited.entities[6] = { ...edited.entities[6], title: "edited", updatedAt: 101 };
  seed(edited);
  const frozen = state(), backups = migrationBackups().length;
  blocked(() => apply.applyAreaNormalization(manifest, { now: NOW() }), "preflight-source-drift");
  assert.deepEqual(state(), frozen);
  assert.equal(migrationBackups().length, backups);
});

test("drift between the backup and BEGIN IMMEDIATE blocks and leaves the store unchanged", () => {
  seed(legacy());
  const manifest = preflight();
  let injected;
  apply.areaNormalizationFaultsForTests({ afterBackup: () => {
    const cur = store.readSnapshot();
    const entities = cur.entities.map(e => e.id === "t3" ? { ...e, title: "changed meanwhile", updatedAt: 200 } : e);
    assert.equal(store.replaceSnapshot(cur.revision, entities, cur.relations, [], [], cur.restoreGeneration).conflict, false);
    injected = state();
  } });
  try { blocked(() => apply.applyAreaNormalization(manifest, { now: NOW() }), "preflight-source-drift"); }
  finally { apply.areaNormalizationFaultsForTests(null); }
  assert.deepEqual(state(), injected);
  assert.equal(preflight().noChanges, false);
});

test("a blocked plan or invalid timestamp writes nothing and creates no backup", () => {
  // Ambiguous Area: no honest manifest exists, and a forged one cannot pass verification.
  seed(legacy());
  const valid = preflight();
  const ambiguous = legacy();
  ambiguous.entities.push(ent("area:b", "area", "personal", { kind: "private" }));
  ambiguous.relations.push(rel("r:t3-a", "t3", "area:old", "belongs_to_area"), rel("r:t3-b", "t3", "area:b", "belongs_to_area"));
  seed(ambiguous);
  assert.throws(() => preflight(), x => x instanceof AreaNormalizationBlocked && x.issues.some(i => i.startsWith("ambiguous-area")));
  const { identity } = read();
  const forged = { ...valid, sourceSha256: sha(), revision: identity.revision, restoreGeneration: identity.restoreGeneration };
  const frozen = state(), backups = migrationBackups().length;
  assert.throws(() => apply.applyAreaNormalization(forged, { now: NOW() }), x => x instanceof AreaNormalizationBlocked);
  // A timestamp older than the newest record is refused before the backup.
  seed(legacy());
  const manifest = preflight();
  const second = state();
  for (const now of [1, 100.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
    blocked(() => apply.applyAreaNormalization(manifest, { now }), "invalid-apply-timestamp");
  assert.deepEqual(state(), second);
  assert.equal(migrationBackups().length, backups);
  assert.notEqual(frozen.sha, second.sha);
});

test("noChanges is a no-op: no backup, no write", () => {
  seed(legacy());
  apply.applyAreaNormalization(preflight(), { now: NOW() });
  const manifest = preflight(), frozen = state(), backups = migrationBackups().length;
  assert.equal(manifest.noChanges, true);
  assert.deepEqual(apply.applyAreaNormalization(manifest, { now: NOW() }), { status: "noop" });
  assert.deepEqual(state(), frozen);
  assert.equal(migrationBackups().length, backups);
});

test("a fault after the rows are written rolls everything back", () => {
  seed(legacy());
  const manifest = preflight(), frozen = state();
  apply.areaNormalizationFaultsForTests({ afterWrite: () => { throw new Error("fault after write"); } });
  try { assert.throws(() => apply.applyAreaNormalization(manifest, { now: NOW() }), /fault after write/); }
  finally { apply.areaNormalizationFaultsForTests(null); }
  assert.deepEqual(state(), frozen);
  assert.equal(store.getDatabase().isTransaction, false);
  // The store is usable and the same manifest still applies.
  assert.equal(apply.applyAreaNormalization(manifest, { now: NOW() }).status, "applied");
});

// An old client: a pre-normalization local copy (and, when it has one, a sync base).
function oldClient(withBase) {
  seed(legacy());
  const pre = store.readSnapshot();
  const device = { entities: structuredClone(pre.entities), relations: structuredClone(pre.relations), restoreGeneration: pre.restoreGeneration };
  const base = withBase ? { entities: structuredClone(pre.entities), relations: structuredClone(pre.relations) } : null;
  const result = apply.applyAreaNormalization(preflight(), { now: NOW() });
  return { device, base, result };
}
function sync(device, base) {
  const server = store.readSnapshot();
  const merged = mergeSnapshots(server, device.entities, device.relations, base);
  return store.replaceSnapshot(server.revision, merged.entities, merged.relations, [], [], device.restoreGeneration);
}
for (const withBase of [true, false]) {
  test(`old client ${withBase ? "with" : "without"} a sync base cannot undo the normalization`, () => {
    const { device, base } = oldClient(withBase);
    const saved = sync(device, base);
    assert.equal(saved.conflict, false);
    const now = store.readSnapshot();
    assert.equal(preflight().noChanges, true);
    for (const id of ["r:t2-area", "r:st-area"]) assert.ok(!now.relations.some(r => r.id === id), id);
    assert.equal(now.entities.find(e => e.id === "area:old").properties.kind, "private");
    assert.equal(now.entities.find(e => e.id === "area:team").properties.kind, "shared");
  });
  test(`old client ${withBase ? "with" : "without"} a base keeps an unrelated offline edit`, () => {
    const { device, base } = oldClient(withBase);
    device.entities = device.entities.map(e => e.id === "t3" ? { ...e, title: "edited offline", updatedAt: Date.now() + 5000 } : e);
    assert.equal(sync(device, base).conflict, false);
    const now = store.readSnapshot();
    assert.equal(now.entities.find(e => e.id === "t3").title, "edited offline");
    assert.equal(preflight().noChanges, true);
    assert.ok(!now.relations.some(r => r.id === "r:t2-area"));
  });
}

test("rollback returns to the source; restoreGeneration moves on; link tombstones do not linger", () => {
  seed(legacy());
  const before = state();
  const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
  const rolled = apply.rollbackAreaNormalization(applied);
  assert.equal(rolled.status, "rolled-back");
  assert.equal(rolled.rolledBackSha256, applied.sourceSha256);
  assert.equal(rolled.restoreGeneration, applied.restoreGeneration + 1);
  const now = store.readSnapshot();
  assert.deepEqual([...now.entities].sort((a, b) => a.id < b.id ? -1 : 1).filter(e => before.snapshot.entities.some(o => o.id === e.id)),
    [...before.snapshot.entities].sort((a, b) => a.id < b.id ? -1 : 1));
  assert.ok(now.relations.some(r => r.id === "r:t2-area"));
  assert.ok(!now.tombstones.some(t => t.id === "r:t2-area" || t.id === "r:st-area"));
  assert.equal(now.entities.length, before.snapshot.entities.length);
  // A device still on the old restoreGeneration is refused and must adopt the restored copy.
  const stale = store.replaceSnapshot(now.revision, now.entities, now.relations, [], [], applied.restoreGeneration);
  assert.equal(stale.conflict, true);
  assert.equal(stale.restored, true);
  // Fail-closed: the Areas created by the applied migration are tombstoned now, so the planner refuses to
  // recreate their IDs. Normalizing again needs a deliberate decision, never a silent re-run.
  assert.throws(() => preflight(), x => x instanceof AreaNormalizationBlocked
    && x.issues.some(i => i.startsWith("tombstoned-generated-area-id")));
});

test("rollback is refused after any later write and when the backup was altered", () => {
  seed(legacy());
  const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
  const cur = store.readSnapshot();
  const entities = cur.entities.map(e => e.id === "t3" ? { ...e, title: "later", updatedAt: Date.now() + 9000 } : e);
  assert.equal(store.replaceSnapshot(cur.revision, entities, cur.relations, [], [], cur.restoreGeneration).conflict, false);
  const later = state();
  blocked(() => apply.rollbackAreaNormalization(applied), "post-migration-changes");
  assert.deepEqual(state(), later);

  seed(legacy());
  const second = apply.applyAreaNormalization(preflight(), { now: NOW() });
  const frozen = state();
  appendFileSync(path.join(backupsDir, second.backup.name), "x");
  blocked(() => apply.rollbackAreaNormalization(second), "backup-mismatch");
  assert.deepEqual(state(), frozen);
  // A forged manifest cannot point at another file.
  blocked(() => apply.rollbackAreaNormalization({ ...second, backup: { ...second.backup, name: "../../store.sqlite" } }), "backup-mismatch");
});

test("manifest parsers accept the preflight wrapper and refuse unknown or missing fields", () => {
  seed(legacy());
  const manifest = preflight();
  assert.deepEqual(apply.parseAreaPreflightManifest({ status: "offline-preflight-only", ...manifest }), manifest);
  assert.deepEqual(apply.parseAreaPreflightManifest(manifest), manifest);
  blocked(() => apply.parseAreaPreflightManifest({ ...manifest, extra: 1 }), "bad-preflight-manifest");
  blocked(() => apply.parseAreaPreflightManifest({ ...manifest, status: "other" }), "bad-preflight-manifest");
  const { at: _at, ...missing } = manifest;
  blocked(() => apply.parseAreaPreflightManifest(missing), "bad-preflight-manifest");
  blocked(() => apply.parseAreaPreflightManifest({ ...manifest, sourceSha256: "zz" }), "bad-preflight-manifest");
  blocked(() => apply.parseAppliedManifest({ status: "applied" }), "bad-applied-manifest");
});

// ---- CLI -------------------------------------------------------------------------------------------------------
const script = path.resolve("scripts/apply-area-normalization.mjs");
const cli = (args, env = {}) => spawnSync(process.execPath, ["--experimental-loader", "./tests/ts-loader.mjs", script, ...args],
  { encoding: "utf8", timeout: 60000, env: { ...process.env, NODE_NO_WARNINGS: "1", AI_EXECUTIVE_DATA_DIR: dataDir, ...env } });
const tmpJson = value => { const f = path.join(dataDir, "m-" + Math.random().toString(36).slice(2) + ".json"); writeFileSync(f, JSON.stringify(value)); return f; };

test("CLI refuses a wrong --confirm with exit 2 before the database is opened", () => {
  seed(legacy());
  const manifest = preflight(), frozen = state(), backups = migrationBackups().length;
  const wrong = cli(["--manifest", tmpJson({ status: "offline-preflight-only", ...manifest }), "--confirm", "0".repeat(64)]);
  assert.equal(wrong.status, 2);
  assert.deepEqual(state(), frozen);
  assert.equal(migrationBackups().length, backups);
  // An unused data directory stays unused: nothing opened (or created) the store there.
  const fresh = path.join(os.tmpdir(), "lumi-area-apply-unused-" + process.pid);
  const result = cli(["--manifest", tmpJson(manifest), "--confirm", manifest.sourceSha256], { AI_EXECUTIVE_DATA_DIR: fresh });
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stderr), { status: "blocked", reasons: ["missing-store"] });
  assert.equal(existsSync(fresh), false);
  // The data-directory hint appears only when it is the reason.
  assert.ok(!cli(["--manifest", "x"]).stderr.includes("AI_EXECUTIVE_DATA_DIR"));
  assert.ok(cli(["--manifest", tmpJson(manifest), "--confirm", manifest.sourceSha256], { AI_EXECUTIVE_DATA_DIR: "relative/dir" }).stderr.includes("absolute"));
  assert.equal(cli(["--manifest", tmpJson(manifest), "--confirm", manifest.sourceSha256], { AI_EXECUTIVE_DATA_DIR: "relative/dir" }).status, 2);
  assert.equal(cli(["--manifest", tmpJson(manifest)]).status, 2);
});

test("CLI blocked output carries codes only", () => {
  seed(legacy());
  const manifest = preflight();
  seed({ ...legacy(), entities: legacy().entities.map(e => e.id === "t3" ? { ...e, title: "SECRET-DRIFT-TITLE", updatedAt: 101 } : e) });
  const result = cli(["--manifest", tmpJson(manifest), "--confirm", manifest.sourceSha256]);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr), { status: "blocked", reasons: ["preflight-source-drift"] });
  assert.equal(result.stdout, "");
  assert.ok(!/SECRET|area:|dataDir|lumi-area/.test(result.stderr + result.stdout));
  const bad = cli(["--manifest", tmpJson({ nonsense: true }), "--confirm", manifest.sourceSha256]);
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stderr), { status: "blocked", reasons: ["bad-preflight-manifest"] });
  assert.equal(cli(["--manifest", path.join(dataDir, "missing.json"), "--confirm", manifest.sourceSha256]).status, 1);
});

test("CLI applies, prints only the result manifest, and rolls back with --rollback", () => {
  seed(legacy());
  const manifest = preflight();
  const run = cli(["--manifest", tmpJson({ status: "offline-preflight-only", ...manifest }), "--confirm", manifest.sourceSha256]);
  assert.equal(run.status, 0, run.stderr);
  const applied = JSON.parse(run.stdout);
  assert.equal(applied.status, "applied");
  assert.equal(applied.sourceSha256, manifest.sourceSha256);
  assert.ok(!run.stdout.includes("SECRET"));
  assert.equal(sha(), applied.resultSha256);
  assert.equal(cli(["--rollback", tmpJson(applied), "--confirm", manifest.sourceSha256]).status, 2);
  const back = cli(["--rollback", tmpJson(applied), "--confirm", applied.resultSha256]);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(JSON.parse(back.stdout).rolledBackSha256, manifest.sourceSha256);
  // Refused once more: the store is no longer the applied result.
  const again = cli(["--rollback", tmpJson(applied), "--confirm", applied.resultSha256]);
  assert.equal(again.status, 1);
  assert.deepEqual(JSON.parse(again.stderr), { status: "blocked", reasons: ["post-migration-changes"] });
});

// ---- review fixes -----------------------------------------------------------------------------------------------
// The client's load migration (lib/db.ts migratePropertyRelations): any truthy properties.areaId/projectId whose relation
// is missing would be turned into a relation. After normalization there must be none left to recreate a removed link.
const clientWouldRecreate = ({ entities, relations }) => entities.filter(e => ["areaId", "projectId"].some(key => {
  const target = e.properties[key], type = key === "areaId" ? "belongs_to_area" : "belongs_to_project";
  return typeof target === "string" && target && !relations.some(r => r.sourceEntityId === e.id && r.relationType === type && r.targetEntityId === target);
}));
const inherited = () => ({
  entities: [workspace("personal", "personal"), ent("area:a", "area", "personal", { kind: "private" }),
    ent("pj", "project", "personal"), ent("tk", "task", "personal", { projectId: "pj", areaId: "area:a", note: "keep" })],
  relations: [rel("r:pj-area", "pj", "area:a", "belongs_to_area"), rel("r:tk-proj", "tk", "pj", "belongs_to_project"),
    rel("r:tk-area", "tk", "area:a", "belongs_to_area")],
});

test("inherited project tasks lose properties.areaId too, so the client migration cannot recreate the link", () => {
  seed(inherited());
  const manifest = preflight();
  assert.equal(manifest.pendingAreaIdCleanups, 1);
  const before = store.readSnapshot().entities.find(e => e.id === "tk");
  const applied = apply.applyAreaNormalization(manifest, { now: NOW() });
  assert.equal(applied.counts.areaIdCleanups, 1);
  const after = store.readSnapshot();
  const task = after.entities.find(e => e.id === "tk");
  assert.deepEqual(task.properties, { projectId: "pj", note: "keep" });
  assert.ok(task.updatedAt > before.updatedAt);
  assert.deepEqual({ ...task, properties: before.properties, updatedAt: before.updatedAt }, before);
  assert.ok(!after.relations.some(r => r.id === "r:tk-area"));
  assert.deepEqual(clientWouldRecreate(after), []);
  assert.equal(preflight().noChanges, true);
});

test("a store whose relation is gone but whose areaId property remains is not noChanges and gets cleaned", () => {
  const data = inherited();
  data.relations = data.relations.filter(r => r.id !== "r:tk-area");
  seed(data);
  const manifest = preflight();
  assert.equal(manifest.noChanges, false);
  assert.equal(manifest.pendingAreaIdCleanups, 1);
  assert.equal(apply.applyAreaNormalization(manifest, { now: NOW() }).counts.areaIdCleanups, 1);
  assert.equal(store.readSnapshot().entities.find(e => e.id === "tk").properties.areaId, undefined);
  assert.equal(preflight().noChanges, true);
});

test("rollback re-checks the state inside the restore transaction: a competing write is refused, nothing restored", () => {
  seed(legacy());
  const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
  let injected;
  apply.areaNormalizationFaultsForTests({ beforeRestore: () => {
    const cur = store.readSnapshot();
    const entities = cur.entities.map(e => e.id === "t3" ? { ...e, title: "raced", updatedAt: Date.now() + 9000 } : e);
    assert.equal(store.replaceSnapshot(cur.revision, entities, cur.relations, [], [], cur.restoreGeneration).conflict, false);
    injected = state();
  } });
  try { blocked(() => apply.rollbackAreaNormalization(applied), "post-migration-changes"); }
  finally { apply.areaNormalizationFaultsForTests(null); }
  assert.deepEqual(state(), injected);
  assert.equal(store.readSnapshot().restoreGeneration, applied.restoreGeneration);
});

test("a failing post-verification rolls the restore back and leaves the applied state intact", () => {
  seed(legacy());
  const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
  const frozen = state();
  blocked(() => apply.rollbackAreaNormalization({ ...applied, sourceSha256: "0".repeat(64) }), "rollback-verification-failed");
  assert.deepEqual(state(), frozen);
  assert.equal(store.getDatabase().isTransaction, false);
  assert.equal(apply.rollbackAreaNormalization(applied).status, "rolled-back");
});

test("restore hooks run inside the transaction; throwing rolls back; default behaviour is unchanged", () => {
  seed(legacy());
  store.createBackup("manual");
  const name = store.listBackups().find(b => b.label === "manual").name;
  const frozen = state();
  for (const hooks of [{ verifyBefore: () => { throw new Error("no"); } }, { verifyAfter: () => { throw new Error("no"); } }])
    assert.throws(() => store.restoreBackup(name, hooks), /no/);
  assert.deepEqual(state(), frozen);
  let seen = 0;
  store.restoreBackup(name, { verifyBefore: db => { assert.equal(db.isTransaction, true); seen++; }, verifyAfter: db => { assert.equal(db.isTransaction, true); seen++; } });
  assert.equal(seen, 2);
  assert.equal(store.readSnapshot().restoreGeneration, frozen.snapshot.restoreGeneration + 1);
});

test("rollback is refused after a later write to another restorable table, and that row survives", () => {
  seed(legacy());
  const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
  assert.match(applied.otherTablesSha256, /^[0-9a-f]{64}$/);
  store.getDatabase().prepare(`INSERT INTO attention_states (workspace_id, attention_key, subject_id, rule_id, state, source_fingerprint, snooze_until, changed_at)
    VALUES ('personal', 'k', 's', 'r', 'dismissed', 'f', NULL, 1)`).run();
  const frozen = state();
  blocked(() => apply.rollbackAreaNormalization(applied), "post-migration-changes");
  assert.deepEqual(state(), frozen);
  assert.equal(store.getDatabase().prepare("SELECT COUNT(*) AS n FROM attention_states WHERE attention_key = 'k'").get().n, 1);
  store.getDatabase().prepare("DELETE FROM attention_states WHERE attention_key = 'k'").run();
  assert.equal(apply.rollbackAreaNormalization(applied).status, "rolled-back");
});

test("KNOWN GAP (documents current behaviour): a legacy device without a base can strip an Area's kind", () => {
  seed(legacy());
  const pre = store.readSnapshot();
  const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
  // The device's local Area copy is newer than the apply time, so it wins the base-less merge (lib/server-sync.ts).
  const device = pre.entities.map(e => e.id === "area:old" ? { ...e, updatedAt: applied.appliedAt + 10000 } : e);
  const server = store.readSnapshot();
  const merged = mergeSnapshots(server, device, pre.relations, null);
  assert.equal(merged.entities.find(e => e.id === "area:old").properties.kind, undefined);
  assert.equal(store.replaceSnapshot(server.revision, merged.entities, merged.relations, [], [], pre.restoreGeneration).conflict, false);
  // Fail-closed: the preflight shows the pending backfill again, so Area authorization stays inactive.
  const again = preflight();
  assert.equal(again.noChanges, false);
  assert.equal(again.pendingAreaKindBackfills, 1);
});

// ---- owner review: backup must equal the live other tables; no store mutation before verification ----------------
const quoteName = name => `"${name}"`;
const attentionRow = key => store.getDatabase().prepare(`INSERT INTO attention_states (workspace_id, attention_key, subject_id, rule_id, state, source_fingerprint, snooze_until, changed_at)
  VALUES ('personal', ?, 's', 'r', 'dismissed', 'f', NULL, 1)`).run(key);

test("a change to another restorable table between backup and BEGIN blocks the apply and writes nothing", () => {
  seed(legacy());
  const manifest = preflight();
  let injected;
  apply.areaNormalizationFaultsForTests({ afterBackup: () => { attentionRow("raced"); injected = state(); } });
  try { blocked(() => apply.applyAreaNormalization(manifest, { now: NOW() }), "other-tables-drift"); }
  finally { apply.areaNormalizationFaultsForTests(null); }
  assert.deepEqual(state(), injected);
  assert.equal(store.getDatabase().isTransaction, false);
  assert.equal(preflight().noChanges, false);
  store.getDatabase().prepare("DELETE FROM attention_states WHERE attention_key = 'raced'").run();
});

test("backup and live fingerprints agree with rows (incl. blobs and NULLs) in several restorable tables", () => {
  const database = store.getDatabase();
  const overrides = { work_sessions: { state: "completed", running_since: null }, work_session_intervals: { ended_at: 5 },
    mail_sync_accounts: { retention_days: 30, history_backlog_pending: 0 }, mail_sync_messages: { needs_reconcile: 0 } };
  const touched = [];
  for (const table of scope.replacedTables) {
    if (table === "mail_sync_messages") continue;   // rows this old would be swept by retention (see the retention-pending test)
    if (database.prepare(`SELECT 1 FROM ${quoteName(table)} LIMIT 1`).get()) continue;   // leave tables that already hold rows
    const columns = database.prepare(`PRAGMA table_info(${quoteName(table)})`).all();
    const values = columns.map((c, i) => {
      if (overrides[table]?.[c.name] !== undefined) return overrides[table][c.name];
      const type = String(c.type).toUpperCase();
      if (!c.notnull && !c.pk && i % 2) return null;
      if (type.includes("INT")) return 300 + i;
      if (type.includes("BLOB")) return Buffer.from([0, 1, 255, i]);
      return `x-${table}-${c.name}`;
    });
    try {
      database.prepare(`INSERT INTO ${quoteName(table)} (${columns.map(c => quoteName(c.name)).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...values);
      touched.push(table);
    } catch { /* a table with extra constraints stays empty */ }
  }
  assert.ok(touched.length >= 5, "several tables were seeded: " + touched.join());
  try {
    seed(legacy());
    const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
    assert.equal(applied.otherTablesSha256, apply.fingerprintOtherTables(store.getDatabase()));
    const copy = new DatabaseSync(path.join(backupsDir, applied.backup.name), { readOnly: true });
    try { assert.equal(apply.fingerprintOtherTables(copy), applied.otherTablesSha256); } finally { copy.close(); }
    assert.equal(apply.rollbackAreaNormalization(applied).status, "rolled-back");
  } finally {
    for (const table of touched) database.exec(`DELETE FROM ${quoteName(table)}`);
  }
});

// A second data directory holding a copy of the live store, used by fresh CLI processes (getDatabase() was never
// initialised there), so any write caused by merely opening the store is visible.
function storeCopy({ mail = true, mutate } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lumi-area-apply-copy-"));
  store.getDatabase().exec(`VACUUM INTO '${path.join(dir, "store.sqlite")}'`);
  if (existsSync(backupsDir)) cpSync(backupsDir, path.join(dir, "backups"), { recursive: true });
  const copy = new DatabaseSync(path.join(dir, "store.sqlite"));
  try {
    copy.exec("PRAGMA journal_mode=WAL");   // like the live store
    if (mail) {
      copy.prepare(`INSERT INTO mail_sync_accounts (account_id, workspace_id, consent_id, retention_days, created_at, updated_at) VALUES ('acc','personal','c',7,1,1)`).run();
      // Expired (received long ago): the start-up retention sweep would delete it.
      copy.prepare(`INSERT INTO mail_sync_messages (account_id, workspace_id, message_id, thread_id, subject, sender, received_at, unread, in_inbox, in_sent)
        VALUES ('acc','personal','m1','t','s','f',1,0,1,0)`).run();
    }
    mutate?.(copy);
  } finally { copy.close(); }
  const fileSha = () => createHash("sha256").update(readFileSync(path.join(dir, "store.sqlite"))).digest("hex");
  const query = sql => { const c = new DatabaseSync(path.join(dir, "store.sqlite"), { readOnly: true }); try { return c.prepare(sql).get(); } finally { c.close(); } };
  const mailRows = () => query("SELECT COUNT(*) AS n FROM mail_sync_messages").n;
  // A read-only open of a WAL store may create EMPTY -wal/-shm sidecars; nothing else may appear or change.
  const files = () => {
    for (const f of readdirSync(dir).filter(f => f.endsWith("-wal"))) assert.equal(statSync(path.join(dir, f)).size, 0, f);   // the -shm index is transient by nature
    return readdirSync(dir).filter(f => !/-(wal|shm)$/.test(f)).sort().join() + "|" +
    (existsSync(path.join(dir, "backups")) ? readdirSync(path.join(dir, "backups")).sort().join() : "");
  };
  return { dir, fileSha, mailRows, query, files, run: (args) => cli(args, { AI_EXECUTIVE_DATA_DIR: dir }) };
}

test("a drifted manifest never opens the store for writing: start-up retention does not run, no backup", () => {
  seed(legacy());
  const manifest = preflight();
  seed({ ...legacy(), entities: legacy().entities.map(e => e.id === "t3" ? { ...e, title: "drifted", updatedAt: 101 } : e) });
  const copy = storeCopy();
  try {
    const bytes = copy.fileSha(), files = copy.files();
    const result = copy.run(["--manifest", tmpJson(manifest), "--confirm", manifest.sourceSha256]);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stderr), { status: "blocked", reasons: ["preflight-source-drift"] });
    assert.equal(copy.mailRows(), 1);
    assert.equal(copy.fileSha(), bytes);
    assert.equal(copy.files(), files);
  } finally { rmSync(copy.dir, { recursive: true, force: true }); }
});

test("control: merely opening the store in a fresh process does run the retention sweep", () => {
  const copy = storeCopy();
  try {
    const opened = spawnSync(process.execPath, ["--experimental-loader", "./tests/ts-loader.mjs", "--input-type=module", "-e",
      "const m = await import('./lib/server-store.ts'); m.getDatabase();"],
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1", AI_EXECUTIVE_DATA_DIR: copy.dir } });
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(copy.mailRows(), 0);
  } finally { rmSync(copy.dir, { recursive: true, force: true }); }
});

test("a refused rollback never opens the store for writing either", () => {
  seed(legacy());
  const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
  const cur = store.readSnapshot();
  assert.equal(store.replaceSnapshot(cur.revision, cur.entities.map(e => e.id === "t3" ? { ...e, title: "later", updatedAt: Date.now() + 9000 } : e),
    cur.relations, [], [], cur.restoreGeneration).conflict, false);
  const copy = storeCopy();
  try {
    const bytes = copy.fileSha(), files = copy.files();
    const result = copy.run(["--rollback", tmpJson(applied), "--confirm", applied.resultSha256]);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stderr), { status: "blocked", reasons: ["post-migration-changes"] });
    assert.equal(copy.mailRows(), 1);
    assert.equal(copy.fileSha(), bytes);
    assert.equal(copy.files(), files);
  } finally { rmSync(copy.dir, { recursive: true, force: true }); }
});

const lastMigration = async () => (await import("../lib/schema-migrations.ts")).schemaMigrations.at(-1).id;

test("pending schema migrations are refused before the store is opened (apply and rollback)", async () => {
  seed(legacy());
  const manifest = preflight();
  const pending = await lastMigration();
  const copy = storeCopy({ mail: false, mutate: c => c.prepare("DELETE FROM schema_migrations WHERE id = ?").run(pending) });
  try {
    const bytes = copy.fileSha(), files = copy.files();
    const result = copy.run(["--manifest", tmpJson(manifest), "--confirm", manifest.sourceSha256]);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stderr), { status: "blocked", reasons: ["pending-schema-migrations"] });
    assert.equal(copy.fileSha(), bytes);
    assert.equal(copy.files(), files);
    assert.equal(copy.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '" + pending + "'").n, 0);
    const applied = apply.applyAreaNormalization(manifest, { now: NOW() });
    const back = storeCopy({ mail: false, mutate: c => c.prepare("DELETE FROM schema_migrations WHERE id = ?").run(pending) });
    try {
      const refused = back.run(["--rollback", tmpJson(applied), "--confirm", applied.resultSha256]);
      assert.deepEqual(JSON.parse(refused.stderr), { status: "blocked", reasons: ["pending-schema-migrations"] });
      assert.equal(back.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = '" + pending + "'").n, 0);
    } finally { rmSync(back.dir, { recursive: true, force: true }); }
  } finally { rmSync(copy.dir, { recursive: true, force: true }); }
});

test("a missing default workspace is refused before the store is opened", () => {
  seed(legacy());
  const manifest = preflight();
  const copy = storeCopy({ mail: false, mutate: c => c.exec("DELETE FROM entities WHERE id = 'workspace:personal'") });
  try {
    const bytes = copy.fileSha();
    const result = copy.run(["--manifest", tmpJson(manifest), "--confirm", manifest.sourceSha256]);
    assert.deepEqual(JSON.parse(result.stderr), { status: "blocked", reasons: ["missing-default-workspace"] });
    assert.equal(copy.fileSha(), bytes);
  } finally { rmSync(copy.dir, { recursive: true, force: true }); }
});

test("fingerprints tell NULL from Infinity: a change between backup and BEGIN is other-tables-drift", () => {
  seed(legacy());
  attentionRow("nullrow");
  const manifest = preflight();
  apply.areaNormalizationFaultsForTests({ afterBackup: () => {
    store.getDatabase().prepare("UPDATE attention_states SET snooze_until = 1e999 WHERE attention_key = 'nullrow'").run();
  } });
  try { blocked(() => apply.applyAreaNormalization(manifest, { now: NOW() }), "other-tables-drift"); }
  finally { apply.areaNormalizationFaultsForTests(null); }
  store.getDatabase().prepare("DELETE FROM attention_states WHERE attention_key = 'nullrow'").run();
});

test("fingerprints tell BLOB from TEXT", () => {
  const database = store.getDatabase();
  const hex = "6162";
  const put = value => { database.exec("DELETE FROM attention_states"); database.prepare(`INSERT INTO attention_states (workspace_id, attention_key, subject_id, rule_id, state, source_fingerprint, snooze_until, changed_at)
    VALUES ('personal', 'k', 's', 'r', 'dismissed', ?, NULL, 1)`).run(value); return apply.fingerprintOtherTables(database); };
  try { assert.notEqual(put("blob:" + hex), put(Buffer.from(hex, "hex"))); }
  finally { database.exec("DELETE FROM attention_states"); }
});

test("integers beyond 2^53 in a restorable table apply and roll back and round-trip", () => {
  const database = store.getDatabase();
  const big = 9223372036854775807n;
  database.prepare(`INSERT INTO attention_states (workspace_id, attention_key, subject_id, rule_id, state, source_fingerprint, snooze_until, changed_at)
    VALUES ('personal', 'big', 's', 'r', 'dismissed', 'f', NULL, ?)`).run(big);
  const value = () => { const q = database.prepare("SELECT changed_at FROM attention_states WHERE attention_key = 'big'"); q.setReadBigInts(true); return q.get().changed_at; };
  try {
    seed(legacy());
    const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
    assert.equal(value(), big);
    assert.equal(apply.rollbackAreaNormalization(applied).status, "rolled-back");
    assert.equal(value(), big);
  } finally { database.exec("DELETE FROM attention_states"); }
});

test("a rollback is refused with retention-pending, before the store is opened, while mail retention would delete rows", () => {
  const database = store.getDatabase();
  database.prepare(`INSERT INTO mail_sync_accounts (account_id, workspace_id, consent_id, retention_days, created_at, updated_at) VALUES ('racc','personal','c',7,1,1)`).run();
  database.prepare(`INSERT INTO mail_sync_messages (account_id, workspace_id, message_id, thread_id, subject, sender, received_at, unread, in_inbox, in_sent)
    VALUES ('racc','personal','m1','t','s','f',1,0,1,0)`).run();   // expired by the clock; no sweep ran in this process
  try {
    seed(legacy());
    const applied = apply.applyAreaNormalization(preflight(), { now: NOW() });
    const copy = storeCopy({ mail: false });
    try {
      const bytes = copy.fileSha(), files = copy.files();
      const result = copy.run(["--rollback", tmpJson(applied), "--confirm", applied.resultSha256]);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(JSON.parse(result.stderr), { status: "blocked", reasons: ["retention-pending"] });
      assert.equal(copy.mailRows(), 1);
      assert.equal(copy.fileSha(), bytes);
      assert.equal(copy.files(), files);
    } finally { rmSync(copy.dir, { recursive: true, force: true }); }
  } finally { database.exec("DELETE FROM mail_sync_messages; DELETE FROM mail_sync_accounts"); }
});

test("the retention probe counts exactly what the sweep deletes", async () => {
  const { countExpiredMailMetadata, pruneExpiredMailMetadata } = await import("../lib/mail-sync-retention.ts");
  const database = store.getDatabase();
  const message = (account, id, at) => database.prepare(`INSERT INTO mail_sync_messages (account_id, workspace_id, message_id, thread_id, subject, sender, received_at, unread, in_inbox, in_sent)
    VALUES (?,'personal',?,'t','s','f',?,0,1,0)`).run(account, id, at);
  database.prepare(`INSERT INTO mail_sync_accounts (account_id, workspace_id, consent_id, retention_days, created_at, updated_at) VALUES ('pacc','personal','c',7,1,1)`).run();
  const now = 10 * 86_400_000;
  message("pacc", "old", 1); message("pacc", "fresh", now - 1000); message("orphan", "o", now);
  try {
    assert.equal(countExpiredMailMetadata(database, now), 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM mail_sync_messages").get().n, 3);
    assert.equal(pruneExpiredMailMetadata(database, now), 2);
    assert.equal(countExpiredMailMetadata(database, now), 0);
  } finally { database.exec("DELETE FROM mail_sync_messages; DELETE FROM mail_sync_accounts"); }
});
