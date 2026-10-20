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
