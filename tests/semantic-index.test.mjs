import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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

test("a restore marker rebuilds all workspaces and a lost derived file is recoverable", () => {
  canonical.prepare("INSERT INTO metadata(key, value) VALUES ('restoreGeneration', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  canonical.prepare("UPDATE metadata SET value = '2' WHERE key = 'restoreGeneration'").run();
  assert.ok(canonical.prepare("SELECT 1 FROM semantic_index_outbox WHERE operation = 'restore'").get());
  semantic.reconcileSemanticManifest();
  assert.equal(queued(), 0);
  rmSync(manifestPath);
  semantic.reconcileSemanticManifest();
  assert.ok(existsSync(manifestPath));
  assert.equal(manifest("SELECT COUNT(*) AS n FROM semantic_entries")[0].n > 0, true);
});
