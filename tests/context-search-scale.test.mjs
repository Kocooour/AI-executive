import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-context-search-scale-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES = "personal";
after(() => { delete process.env.AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES; rmSync(dataDir, { recursive: true, force: true }); });

const store = await import("../lib/server-store.ts");
const retrieval = await import("../lib/context-search.ts");
const database = store.getDatabase();
const now = Date.now();
const projectCount = 2600;
const personCount = 2600;
const claimCount = 5000;

database.exec("BEGIN IMMEDIATE");
try {
  const insertEntity = database.prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)");
  for (let i = 0; i < projectCount; i += 1) {
    const id = "scale-project-" + i;
    insertEntity.run(id, JSON.stringify({
      id, type: "project", title: "BulkTarget project " + i,
      workspaceId: "personal", status: "active", content: "", properties: {},
      createdAt: now, updatedAt: now + i,
    }), now + i);
  }
  // Inflate the snapshot so repeated parsing is expensive, without increasing the result count.
  for (let i = 0; i < 2400; i += 1) {
    const id = "scale-task-" + i;
    insertEntity.run(id, JSON.stringify({
      id, type: "task", title: "Unrelated task " + i,
      workspaceId: "personal", status: "open", properties: {}, createdAt: now, updatedAt: now,
    }), now);
  }
  const insertSubject = database.prepare("INSERT INTO context_subjects (id, workspace_id, subject_type, canonical_entity_id, display_title, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)");
  insertSubject.run("canonical:workspace:personal", "personal", "workspace", "workspace:personal", "Personal", now, now);
  for (let i = 0; i < personCount; i += 1) {
    insertSubject.run("scale-person-" + i, "personal", "person", null, "BulkTarget person " + i, now, now + i);
  }
  const insertClaim = database.prepare("INSERT INTO context_claims (id, workspace_id, subject_id, predicate, literal_type, literal_value, target_subject_id, review_status, freshness, sensitivity, provenance, valid_from, valid_to, revision, recorded_at, updated_at) VALUES (?, 'personal', 'canonical:workspace:personal', 'preference', 'string', ?, NULL, 'confirmed', 'current', 'normal', 'owner', NULL, NULL, 1, ?, ?)");
  for (let i = 0; i < claimCount; i += 1) {
    insertClaim.run("scale-claim-" + i, JSON.stringify("BulkTarget claim " + i), now, now + i);
  }
  // Every claim has real, active evidence. Without a claim_id-leading index the external
  // NOT EXISTS correlates 5000 times with a full scan of this table.
  const insertSource = database.prepare("INSERT INTO context_sources (id, workspace_id, revision, provider, coverage, sensitivity, created_at, updated_at) VALUES (?, 'personal', 1, ?, 'body', ?, ?, ?)");
  insertSource.run("scale-source-normal", "scale-test", "normal", now, now);
  insertSource.run("scale-source-protected", "scale-private", "confidential", now, now);
  const insertEvidence = database.prepare("INSERT INTO context_evidence (id, workspace_id, revision, claim_id, source_id, created_at, updated_at, archived_at) VALUES (?, ?, 1, ?, ?, ?, ?, NULL)");
  for (let i = 0; i < claimCount; i += 1) {
    insertEvidence.run("scale-evidence-" + i, "personal", "scale-claim-" + i, "scale-source-normal", now, now);
  }
  // All of these must exclude the whole claim from EXTERNAL search, even if an active
  // normal citation also exists. Cross-workspace evidence must not be silently ignored.
  insertEvidence.run("scale-sensitive-evidence", "personal", "scale-claim-4999", "scale-source-protected", now, now);
  insertEvidence.run("scale-foreign-evidence", "different-workspace", "scale-claim-4998", "scale-source-normal", now, now);
  insertEvidence.run("scale-orphan-evidence", "personal", "scale-claim-4997", "missing-source", now, now);
  database.exec("COMMIT");
} catch (error) { database.exec("ROLLBACK"); throw error; }

test("lexical search reads 5000 claims and a large snapshot without repeated full-store parsing", () => {
  const before = performance.now();
  const owner = retrieval.searchContext({ actor: "owner", workspaceId: "personal", query: "BulkTarget",
    kinds: ["person", "project", "claim"], limit: 30 });
  const elapsed = performance.now() - before;
  assert.equal(owner.results.length, 30);
  assert.equal(owner.nextCursor, "30");
  assert.equal(owner.partial, false);
  assert.ok(elapsed < 12_000, "owner search took " + elapsed.toFixed(0) + "ms for 5000 claims + 5000 entities");
  const beforeExternal = performance.now();
  const external = retrieval.searchContext({ actor: "integration", workspaceId: "personal", query: "BulkTarget",
    kinds: ["claim"], limit: 30 });
  const externalElapsed = performance.now() - beforeExternal;
  assert.equal(external.results.length, 30);
  assert.equal(external.results.every((hit) => hit.kind === "claim"), true);
  assert.equal("partial" in external, false);
  assert.ok(externalElapsed < 12_000, "external search took " + externalElapsed.toFixed(0) + "ms");
});

test("EXPLAIN confirms the real external guard uses the claim-leading evidence index", () => {
  const migration = database.prepare("SELECT id FROM schema_migrations WHERE id = ?")
    .get("2026-10-context-search-evidence-guard-index");
  assert.ok(migration, "new additive migration is registered and applied");
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM context_evidence WHERE archived_at IS NULL")
    .get().count), claimCount + 3);
  const plan = database.prepare("EXPLAIN QUERY PLAN " + retrieval.contextSearchClaimSql("integration"))
    .all("personal", claimCount + 1).map((row) => String(row.detail));
  assert.ok(plan.some((detail) => /SEARCH e USING (?:COVERING )?INDEX context_evidence_claim_guard_idx/.test(detail)),
    "correlated evidence predicate must use index: " + JSON.stringify(plan));
  assert.equal(plan.some((detail) => /SCAN e(?:\\b|$)/.test(detail)), false,
    "evidence table must not be fully scanned for each claim: " + JSON.stringify(plan));
});

test("real active evidence blocks protected, cross-workspace, and orphaned sources without changing owner results", () => {
  const owner = retrieval.searchContext({ actor: "owner", workspaceId: "personal", query: "BulkTarget claim 4999", kinds: ["claim"] });
  assert.equal(owner.results.some((hit) => hit.id === "scale-claim-4999"), true);
  const external = retrieval.searchContext({ actor: "integration", workspaceId: "personal", query: "BulkTarget claim",
    kinds: ["claim"], limit: 30 });
  for (const id of ["scale-claim-4999", "scale-claim-4998", "scale-claim-4997"]) {
    assert.equal(external.results.some((hit) => hit.id === id), false, id + " has forbidden evidence");
  }
  assert.equal(external.results[0].id, "scale-claim-4996");
  assert.equal("partial" in external, false);
});

test("cursor over 5000 crosses mixed type categories and never becomes invalid", () => {
  const atBoundary = retrieval.searchContext({ actor: "owner", workspaceId: "personal",
    query: "BulkTarget", limit: 30, cursor: "4995" });
  assert.equal(atBoundary.results.length, 30);
  assert.equal(atBoundary.nextCursor, "5025");
  const afterBoundary = retrieval.searchContext({ actor: "owner", workspaceId: "personal",
    query: "BulkTarget", limit: 30, cursor: atBoundary.nextCursor });
  assert.equal(afterBoundary.results.length, 30);
  assert.equal(afterBoundary.nextCursor, "5055");
  assert.notDeepEqual(atBoundary.results.map((row) => row.id), afterBoundary.results.map((row) => row.id));
  assert.throws(() => retrieval.searchContext({ actor: "owner", workspaceId: "personal",
    query: "BulkTarget", cursor: "15001" }), (error) => error.status === 400);
});
