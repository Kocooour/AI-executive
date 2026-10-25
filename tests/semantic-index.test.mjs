import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-semantic-stage1-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const semantic = await import("../lib/semantic-index.ts");
const canonical = store.getDatabase();
const manifestPath = path.join(dataDir, "semantic-index-v1.sqlite");
const queued = () => Number(canonical.prepare("SELECT COUNT(*) AS n FROM semantic_index_outbox").get().n);
const manifest = (sql, ...params) => {
  const derived = new DatabaseSync(manifestPath, { readOnly: true });
  try { return derived.prepare(sql).all(...params); } finally { derived.close(); }
};
const entity = (id, workspaceId, content, sensitivity = "normal") => ({
  id, workspaceId, type: "note", title: content, status: "active", properties: { sensitivity }, updatedAt: Date.now(),
});

test("migration queues a rebuild and the metadata manifest is separate and content-free", () => {
  assert.ok(queued() > 0);
  const result = semantic.reconcileSemanticManifest();
  assert.ok(result.processedEvents > 0);
  assert.equal(queued(), 0);
  assert.ok(existsSync(manifestPath));
  const columns = manifest("PRAGMA table_info(semantic_entries)").map((row) => row.name);
  for (const forbidden of ["content", "title", "excerpt", "vector", "embedding", "payload"]) {
    assert.equal(columns.includes(forbidden), false);
  }
  assert.equal(semantic.reconcileSemanticManifest().processedEvents, 0);
});

test("outbox rolls back with canonical writes; worker replays idempotently", () => {
  const before = queued();
  canonical.exec("BEGIN IMMEDIATE");
  canonical.prepare("INSERT INTO entities(id, payload, updated_at) VALUES (?, ?, ?)")
    .run("rollback-note", JSON.stringify(entity("rollback-note", "personal", "Secret cannot persist")), Date.now());
  assert.equal(queued(), before + 1);
  canonical.exec("ROLLBACK");
  assert.equal(queued(), before);

  canonical.prepare("INSERT INTO entities(id, payload, updated_at) VALUES (?, ?, ?)")
    .run("one-note", JSON.stringify(entity("one-note", "personal", "Schůzka s týmem")), Date.now());
  assert.equal(queued(), before + 1);
  assert.equal(semantic.reconcileSemanticManifest().processedEvents, 1);
  assert.equal(semantic.reconcileSemanticManifest().processedEvents, 0);
  const rows = manifest("SELECT * FROM semantic_entries WHERE object_id = 'one-note'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sensitivity, "normal");
  assert.equal(JSON.stringify(rows).includes("Schůzka"), false);
});

test("workspace, sensitivity, revision and deletion invalidate the derived manifest", () => {
  const current = canonical.prepare("SELECT payload FROM entities WHERE id = 'one-note'").get();
  const moved = { ...JSON.parse(current.payload), workspaceId: "team", updatedAt: Date.now() + 1,
    properties: { sensitivity: "restricted" } };
  canonical.prepare("UPDATE entities SET payload = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(moved), moved.updatedAt, moved.id);
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT * FROM semantic_entries WHERE object_id = 'one-note' AND workspace_id = 'personal'").length, 0);
  const rows = manifest("SELECT * FROM semantic_entries WHERE object_id = 'one-note'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, "team");
  assert.equal(rows[0].sensitivity, "restricted");
  assert.equal(rows[0].canonical_revision, moved.updatedAt);
  canonical.prepare("DELETE FROM entities WHERE id = 'one-note'").run();
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT * FROM semantic_entries WHERE object_id = 'one-note'").length, 0);
});

test("a protected source forces a claim's derived sensitivity to the strictest level", () => {
  const now = Date.now();
  canonical.prepare(`INSERT INTO context_claims(id, workspace_id, subject_id, predicate, review_status, freshness,
    sensitivity, provenance, revision, recorded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("claim-stage1", "personal", "canonical:workspace:personal", "about", "confirmed", "current", "normal", "owner", 1, now, now);
  canonical.prepare(`INSERT INTO context_sources(id, workspace_id, revision, sensitivity, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("source-stage1", "personal", 1, "confidential", now, now);
  canonical.prepare(`INSERT INTO context_evidence(id, workspace_id, revision, claim_id, source_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("evidence-stage1", "personal", 1, "claim-stage1", "source-stage1", now, now);
  semantic.reconcileSemanticManifest();
  const row = manifest("SELECT sensitivity, policy_fingerprint FROM semantic_entries WHERE object_id = 'claim-stage1'")[0];
  assert.equal(row.sensitivity, "confidential");
  canonical.prepare("UPDATE context_sources SET sensitivity = 'restricted', revision = 2 WHERE id = 'source-stage1'").run();
  semantic.reconcileSemanticManifest();
  const next = manifest("SELECT sensitivity, policy_fingerprint FROM semantic_entries WHERE object_id = 'claim-stage1'")[0];
  assert.equal(next.sensitivity, "restricted");
  assert.notEqual(next.policy_fingerprint, row.policy_fingerprint);
});

test("claim policy fingerprint tracks source linkage even when sensitivity does not change", () => {
  const now = Date.now();
  canonical.prepare(`INSERT INTO context_claims(id, workspace_id, subject_id, predicate, review_status, freshness,
    sensitivity, provenance, revision, recorded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("claim-lineage", "personal", "canonical:workspace:personal", "about",
      "confirmed", "current", "normal", "owner", 1, now, now);
  const insertSource = canonical.prepare(`INSERT INTO context_sources
    (id, workspace_id, revision, sensitivity, provider, account, created_at, updated_at)
    VALUES (?, 'personal', 1, 'normal', ?, ?, ?, ?)`);
  insertSource.run("lineage-source-a", "provider-one", "account-one", now, now);
  insertSource.run("lineage-source-b", "provider-two", "account-two", now, now);
  canonical.prepare(`INSERT INTO context_evidence(id, workspace_id, revision, claim_id, source_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("lineage-evidence", "personal", 1, "claim-lineage", "lineage-source-a", now, now);
  semantic.reconcileSemanticManifest();
  const read = () => manifest(
    "SELECT sensitivity, policy_fingerprint FROM semantic_entries WHERE object_id = 'claim-lineage'")[0];
  const initial = read();
  assert.equal(initial.sensitivity, "normal");

  canonical.prepare("UPDATE context_evidence SET source_id = ?, revision = 2 WHERE id = ?")
    .run("lineage-source-b", "lineage-evidence");
  semantic.reconcileSemanticManifest();
  const changedSource = read();
  assert.equal(changedSource.sensitivity, "normal");
  assert.notEqual(changedSource.policy_fingerprint, initial.policy_fingerprint,
    "replacing a source with the same sensitivity must change provenance policy");

  canonical.prepare("UPDATE context_sources SET provider = ?, revision = 2 WHERE id = ?")
    .run("provider-updated", "lineage-source-b");
  semantic.reconcileSemanticManifest();
  const changedPolicy = read();
  assert.equal(changedPolicy.sensitivity, "normal");
  assert.notEqual(changedPolicy.policy_fingerprint, changedSource.policy_fingerprint,
    "source policy/revision changes must alter the fingerprint");

  canonical.prepare("DELETE FROM context_evidence WHERE id = 'lineage-evidence'").run();
  semantic.reconcileSemanticManifest();
  const unlinked = read();
  assert.equal(unlinked.sensitivity, "normal");
  assert.notEqual(unlinked.policy_fingerprint, changedPolicy.policy_fingerprint,
    "removing a source link must invalidate the fingerprint");
});

test("ordinary full-snapshot save queues only changed entities, not a global rebuild", () => {
  semantic.reconcileSemanticManifest();
  const initial = store.readSnapshot();
  const bulk = Array.from({ length: 550 }, (_, index) => ({
    id: `snapshot-unchanged-${index}`, workspaceId: "personal", type: "task",
    title: `Bulk item ${index}`, status: "open", properties: { sensitivity: "normal" },
    createdAt: Date.now(), updatedAt: Date.now(),
  }));
  const created = store.replaceSnapshot(initial.revision,
    [...initial.entities, ...bulk], initial.relations, [], [], initial.restoreGeneration);
  assert.equal(created.conflict, false);
  // 550 tasks plus the fallback Area the server created for them (2a part 4), each exactly once.
  assert.equal(queued(), 551, "initial creation queues each new entity exactly once");
  assert.equal(created.snapshot.relations.filter((link) => link.relationType === "belongs_to_area" && link.sourceEntityId.startsWith("snapshot-unchanged-")).length, 550);
  semantic.reconcileSemanticManifest();
  assert.equal(queued(), 0);

  const previous = store.readSnapshot();
  const changed = previous.entities.map((record) =>
    record.id === "snapshot-unchanged-0"
      ? { ...record, title: "One changed record", updatedAt: record.updatedAt + 1000 }
      : record);
  const updated = store.replaceSnapshot(previous.revision,
    changed, previous.relations, [], [], previous.restoreGeneration);
  assert.equal(updated.conflict, false);
  assert.deepEqual(canonical.prepare(
    "SELECT object_type, object_id, workspace_id, operation FROM semantic_index_outbox ORDER BY id"
  ).all().map((row) => ({ ...row })), [
    { object_type: "entity", object_id: "snapshot-unchanged-0", workspace_id: "personal", operation: "update" },
  ]);
  assert.equal(canonical.prepare("SELECT COUNT(*) AS n FROM semantic_index_outbox WHERE workspace_id = '*'").get().n, 0,
    "one edit among 550 entries must not compact into a global rebuild");
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT COUNT(*) AS n FROM semantic_entries WHERE object_id LIKE 'snapshot-unchanged-%'")[0].n,
    550);
  assert.equal(manifest("SELECT canonical_revision FROM semantic_entries WHERE object_id = 'snapshot-unchanged-0'")[0]
    .canonical_revision, changed.find((record) => record.id === "snapshot-unchanged-0").updatedAt);
  assert.equal(queued(), 0);
});

test("missing entity sensitivity fails closed until a canonical policy is explicitly assigned", () => {
  const record = entity("without-policy", "personal", "No policy");
  delete record.properties.sensitivity;
  canonical.prepare("INSERT INTO entities(id, payload, updated_at) VALUES (?, ?, ?)")
    .run(record.id, JSON.stringify(record), record.updatedAt);
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT sensitivity FROM semantic_entries WHERE object_id = 'without-policy'")[0].sensitivity,
    "restricted");
  record.properties.sensitivity = "normal";
  record.updatedAt += 1;
  canonical.prepare("UPDATE entities SET payload = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(record), record.updatedAt, record.id);
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT sensitivity FROM semantic_entries WHERE object_id = 'without-policy'")[0].sensitivity,
    "normal");
});

test("cross-workspace evidence and foreign source changes invalidate the claim workspace", () => {
  const now = Date.now();
  canonical.prepare(`INSERT INTO context_claims(id, workspace_id, subject_id, predicate, review_status, freshness,
    sensitivity, provenance, revision, recorded_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("claim-cross", "personal", "canonical:workspace:personal", "about", "confirmed", "current",
      "normal", "owner", 1, now, now);
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT sensitivity FROM semantic_entries WHERE object_id = 'claim-cross'")[0].sensitivity,
    "normal");

  canonical.prepare(`INSERT INTO context_sources(id, workspace_id, revision, sensitivity, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("source-cross", "team", 1, "normal", now, now);
  canonical.prepare(`INSERT INTO context_evidence(id, workspace_id, revision, claim_id, source_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run("evidence-cross", "team", 1, "claim-cross", "source-cross", now, now);
  assert.ok(canonical.prepare("SELECT 1 FROM semantic_index_outbox WHERE workspace_id = 'personal'").get(),
    "foreign evidence must invalidate canonical claim workspace");
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT sensitivity FROM semantic_entries WHERE object_id = 'claim-cross'")[0].sensitivity,
    "restricted");

  canonical.prepare("UPDATE context_sources SET sensitivity = 'confidential', revision = 2 WHERE id = 'source-cross'").run();
  assert.ok(canonical.prepare("SELECT 1 FROM semantic_index_outbox WHERE workspace_id = 'personal'").get(),
    "foreign source changes must invalidate the canonical claim workspace");
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT sensitivity FROM semantic_entries WHERE object_id = 'claim-cross'")[0].sensitivity,
    "restricted");

  canonical.prepare("DELETE FROM context_evidence WHERE id = 'evidence-cross'").run();
  assert.ok(canonical.prepare("SELECT 1 FROM semantic_index_outbox WHERE workspace_id = 'personal'").get(),
    "deleting foreign evidence must also invalidate the original claim workspace");
  semantic.reconcileSemanticManifest();
  assert.equal(manifest("SELECT sensitivity FROM semantic_entries WHERE object_id = 'claim-cross'")[0].sensitivity,
    "normal");
});

test("unconsumed outbox is capped without losing the global rebuild requirement", () => {
  const insert = canonical.prepare("INSERT INTO entities(id, payload, updated_at) VALUES (?, ?, ?)");
  canonical.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < 1050; index++) {
      const record = entity(`overflow-note-${index}`, "personal", "Synthetic content");
      insert.run(record.id, JSON.stringify(record), record.updatedAt);
    }
    canonical.exec("COMMIT");
  } catch (error) { canonical.exec("ROLLBACK"); throw error; }
  assert.ok(queued() <= 1000, "bounded outbox cannot grow indefinitely while worker is disabled");
  assert.ok(canonical.prepare("SELECT 1 FROM semantic_index_outbox WHERE object_type = 'rebuild' AND workspace_id = '*' AND operation = 'queue_compacted'").get(),
    "compaction must preserve a full rebuild marker, not silently drop invalidation");
  semantic.reconcileSemanticManifest();
  assert.equal(queued(), 0);
  assert.equal(manifest("SELECT COUNT(*) AS n FROM semantic_entries WHERE object_id LIKE 'overflow-note-%'")[0].n, 1050,
    "global rebuild reconstructs all canonical records");
});

test("a restore marker rebuilds all workspaces and a lost derived file is recoverable", () => {
  assert.equal(canonical.prepare("SELECT 1 FROM metadata WHERE key = 'restoreGeneration'").get(), undefined);
  canonical.prepare("INSERT INTO metadata(key, value) VALUES ('restoreGeneration', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  assert.ok(canonical.prepare("SELECT 1 FROM semantic_index_outbox WHERE operation = 'restore'").get(),
    "the first restore must enqueue even though metadata had no row yet");
  canonical.prepare("UPDATE metadata SET value = '2' WHERE key = 'restoreGeneration'").run();
  assert.ok(canonical.prepare("SELECT 1 FROM semantic_index_outbox WHERE operation = 'restore'").get());
  semantic.reconcileSemanticManifest();
  assert.equal(queued(), 0);
  rmSync(manifestPath);
  semantic.reconcileSemanticManifest();
  assert.ok(existsSync(manifestPath));
  assert.equal(manifest("SELECT COUNT(*) AS n FROM semantic_entries")[0].n > 0, true);
});

test("acknowledgement removes only captured IDs; concurrent new workspace events survive", () => {
  const old = entity("before-reconcile", "personal", "Old source");
  canonical.prepare("INSERT INTO entities(id, payload, updated_at) VALUES (?, ?, ?)")
    .run(old.id, JSON.stringify(old), old.updatedAt);
  const capturedIds = canonical.prepare("SELECT id FROM semantic_index_outbox").all().map((row) => row.id);
  let newId;
  semantic.setSemanticBeforeAcknowledgeForTests(() => {
    const fresh = entity("during-reconcile", "later-workspace", "Fresh source");
    canonical.prepare("INSERT INTO entities(id, payload, updated_at) VALUES (?, ?, ?)")
      .run(fresh.id, JSON.stringify(fresh), fresh.updatedAt);
    newId = canonical.prepare("SELECT MAX(id) AS id FROM semantic_index_outbox").get().id;
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${manifestPath}${suffix}`;
      if (existsSync(file)) assert.equal(statSync(file).mode & 0o777, 0o600, `${suffix || "database"} permissions`);
    }
  });
  try { assert.equal(semantic.reconcileSemanticManifest().processedEvents, capturedIds.length); }
  finally { semantic.setSemanticBeforeAcknowledgeForTests(null); }
  assert.ok(newId > Math.max(...capturedIds));
  assert.deepEqual(canonical.prepare("SELECT id FROM semantic_index_outbox").all().map((row) => row.id), [newId]);
  assert.equal(manifest("SELECT * FROM semantic_entries WHERE object_id = 'during-reconcile'").length, 0);
  assert.equal(semantic.reconcileSemanticManifest().processedEvents, 1);
  assert.equal(manifest("SELECT * FROM semantic_entries WHERE object_id = 'during-reconcile'").length, 1);
});

test("upgrading a database with outbox-v1 already applied installs the first-restore trigger", async () => {
  // Recreate the exact pre-fix shape: v1 is marked applied, but the INSERT trigger is absent.
  canonical.exec("DROP TRIGGER semantic_outbox_first_restore_generation");
  canonical.prepare("DELETE FROM schema_migrations WHERE id = ?")
    .run("2026-10-semantic-memory-first-restore-trigger");
  assert.ok(canonical.prepare("SELECT 1 FROM schema_migrations WHERE id = ?")
    .get("2026-10-semantic-memory-outbox-v1"));
  assert.equal(canonical.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get("semantic_outbox_first_restore_generation"), undefined);

  const migrations = await import("../lib/schema-migrations.ts");
  const applied = migrations.runSchemaMigrations(canonical);
  assert.deepEqual(applied, ["2026-10-semantic-memory-first-restore-trigger"]);
  canonical.prepare("DELETE FROM metadata WHERE key = 'restoreGeneration'").run();
  canonical.prepare("DELETE FROM semantic_index_outbox").run();
  canonical.prepare("INSERT INTO metadata(key, value) VALUES ('restoreGeneration', '1')").run();
  assert.deepEqual(canonical.prepare("SELECT object_type, operation FROM semantic_index_outbox").all()
    .map((row) => ({ ...row })), [{ object_type: "rebuild", operation: "restore" }]);
  assert.deepEqual(migrations.runSchemaMigrations(canonical), []);
});
