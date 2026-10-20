import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "lumi-context-search-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
delete process.env.AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES;
after(() => {
  delete process.env.AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES;
  rmSync(dataDir, { recursive: true, force: true });
});

const store = await import("../lib/server-store.ts");
const claims = await import("../lib/context-claims.ts");
const subjects = await import("../lib/context-subjects.ts");
const sources = await import("../lib/context-sources.ts");
const evidence = await import("../lib/context-evidence.ts");
const retrieval = await import("../lib/context-search.ts");
const tools = await import("../lib/pact-tools.ts");

const workspace = "personal";
const other = "team:search";
const db = store.getDatabase();
const now = Date.now();
const addEntity = (entity) => db.prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)").run(entity.id, JSON.stringify(entity), entity.updatedAt);
addEntity({ id: "workspace:team:search", type: "workspace", title: "Other", status: "active", workspaceId: other,
  properties: { role: "owner" }, createdAt: now, updatedAt: now });
addEntity({ id: "project:search", type: "project", title: "Říční osobní projekt", status: "active", workspaceId: workspace,
  properties: {}, createdAt: now, updatedAt: now });

function create(workspaceId, value, overrides = {}) {
  return claims.createOwnerClaim({
    commandId: randomUUID(), workspaceId, id: randomUUID(), expectedRevision: 0,
    subject: { entityId: workspaceId === workspace ? "workspace:personal" : "workspace:team:search" },
    predicate: "preference", literal: { type: "string", value }, freshness: "current",
    sensitivity: "normal", ...overrides,
  }).claim;
}
function approve(claim) {
  return claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: claim.workspaceId, id: claim.id,
    expectedRevision: claim.revision, decision: "confirmed" }).claim;
}
function search(query, overrides = {}) {
  return retrieval.searchContext({ actor: "owner", workspaceId: workspace, query, ...overrides });
}

const ownerPending = create(workspace, "Secret-PENDING-981");
const ownerConfidential = approve(create(workspace, "Secret-CONFIDENTIAL-892", { sensitivity: "sensitive" }));
const ownerNormal = approve(create(workspace, "Visible-approved-416"));
const teamNormal = approve(create(other, "Secret-OTHER-WORKSPACE-427"));

test("owner sees workspace-local entities and unreviewed protected claims, with normalized Czech search", () => {
  const people = subjects.createStandaloneSubject({ commandId: randomUUID(), workspaceId: workspace,
    id: randomUUID(), expectedRevision: 0, type: "person", title: "Žofie Růžičková" }).subject;
  const found = search("zofie");
  assert.equal(found.schemaVersion, 1);
  assert.equal(found.mode, "lexical");
  assert.equal(found.results.some((hit) => hit.kind === "person" && hit.id === people.id), true);
  assert.equal(search("ricni").results.some((hit) => hit.kind === "project" && hit.id === "project:search"), true);
  assert.equal(search("Secret-PENDING-981").results.some((hit) => hit.id === ownerPending.id), true);
  assert.equal(search("Secret-CONFIDENTIAL-892").results.some((hit) => hit.id === ownerConfidential.id), true);
  assert.equal(search("Secret-OTHER-WORKSPACE-427").results.length, 0);
  assert.throws(() => search("all", { workspaceId: "all" }), (error) => error.status === 400);
});

test("explicit workspace boundary for search, explain, and related claims", () => {
  assert.equal(retrieval.searchContext({ actor: "owner", workspaceId: other, query: "Visible-approved" }).results.length, 0);
  assert.equal(retrieval.searchContext({ actor: "owner", workspaceId: other, query: "Secret-OTHER-WORKSPACE" }).results[0].id, teamNormal.id);
  assert.throws(() => retrieval.explainOwnerClaim(other, ownerNormal.id), (error) => error.status === 404);
  assert.throws(() => retrieval.explainOwnerClaim(workspace, teamNormal.id), (error) => error.status === 404);
  const explanation = retrieval.explainOwnerClaim(workspace, ownerNormal.id);
  assert.equal(explanation.claim.id, ownerNormal.id);
  assert.equal(explanation.why.eligibleForAI, true);
  assert.equal(JSON.stringify(explanation).includes("Secret-OTHER-WORKSPACE-427"), false);
});

test("external context.search fails closed unless workspace is explicitly granted", () => {
  assert.throws(() => retrieval.searchContext({ actor: "integration", workspaceId: workspace, query: "Visible-approved" }),
    (error) => error.status === 403);
  process.env.AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES = "all,*," + other;
  assert.throws(() => retrieval.searchContext({ actor: "integration", workspaceId: workspace, query: "Visible-approved" }),
    (error) => error.status === 403);
  process.env.AI_EXECUTIVE_CONTEXT_SEARCH_WORKSPACES = workspace;
  assert.throws(() => retrieval.searchContext({ actor: "integration", workspaceId: other, query: "Secret-OTHER-WORKSPACE" }),
    (error) => error.status === 403);
  const results = tools.executePACTReadTool("context.search", workspace, { query: "Visible-approved" });
  assert.deepEqual(results.results.map((hit) => hit.id), [ownerNormal.id]);
  assert.equal(results.results[0].sensitivity, undefined);
});

test("external tool excludes pending, confidential, stale, expired and archived facts without even exposing counts", () => {
  const stale = approve(create(workspace, "Secret-STALE-329", { freshness: "stale" }));
  const expired = approve(create(workspace, "Secret-EXPIRED-768", { validTo: "2020-01-01" }));
  const archived0 = approve(create(workspace, "Secret-ARCHIVED-887"));
  claims.archiveOwnerClaim({ commandId: randomUUID(), workspaceId: workspace, id: archived0.id,
    expectedRevision: archived0.revision });
  const result = retrieval.searchContext({ actor: "integration", workspaceId: workspace, query: "Secret-" });
  assert.deepEqual(result.results, []);
  assert.equal(JSON.stringify(result).includes(ownerPending.literal.value), false);
  assert.equal(JSON.stringify(result).includes(ownerConfidential.literal.value), false);
  assert.equal(JSON.stringify(result).includes(stale.literal.value), false);
  assert.equal(JSON.stringify(result).includes(expired.literal.value), false);
  assert.equal(JSON.stringify(result).includes(archived0.literal.value), false);
  assert.equal(JSON.stringify(result).includes(teamNormal.literal.value), false);
  assert.equal("total" in result, false);
});

test("a protected evidence source blocks an otherwise approved claim from the external search", () => {
  const secret = "SOURCE-SUPER-SECRET-886";
  const base = create(workspace, "Basis-of-private-source-992");
  const source = sources.createContextSource({ commandId: randomUUID(), workspaceId: workspace,
    id: randomUUID(), expectedRevision: 0, provider: "sensitive-mail", externalId: secret,
    locator: "https://private.test/" + secret, coverage: "body", sensitivity: "restricted" }).source;
  const withEvidence = evidence.addClaimEvidence({ commandId: randomUUID(), workspaceId: workspace, id: randomUUID(),
    expectedRevision: 0, claimId: base.id, expectedClaimRevision: base.revision, sourceId: source.id,
    excerpt: secret, stance: "supports" }).claim;
  const confirmed = approve(withEvidence);
  const explanation = retrieval.explainOwnerClaim(workspace, confirmed.id);
  assert.equal(explanation.why.eligibleForAI, false);
  assert.equal(explanation.why.blockers.includes("protected_source"), true);
  assert.equal(explanation.evidence[0].source.externalId, secret);
  assert.equal(explanation.reviewEvents.some((event) => event.decision === "confirmed"), true);
  assert.equal(explanation.history.length >= 2, true);
  const outside = tools.executePACTReadTool("context.search", workspace, { query: "Basis-of-private" });
  assert.deepEqual(outside.results, []);
  assert.equal(JSON.stringify(outside).includes(secret), false);
  assert.equal(JSON.stringify(outside).includes(source.id), false);
  assert.equal(JSON.stringify(outside).includes(confirmed.id), false);
});

test("registered relationships are searchable and explain links with bounded histories", () => {
  const person = subjects.createStandaloneSubject({ commandId: randomUUID(), workspaceId: workspace,
    id: randomUUID(), expectedRevision: 0, type: "person", title: "Petr Tester" }).subject;
  const relation = approve(create(workspace, "unused", {
    subject: { subjectId: person.id }, predicate: "responsible_for", literal: undefined,
    target: { entityId: "project:search" },
  }));
  const result = search("odpovida", { kinds: ["relation"] });
  assert.equal(result.results.length, 0, "registered predicates use canonical names, not fabricated localized search");
  const found = search("responsible_for", { kinds: ["relation"] });
  assert.equal(found.results.some((hit) => hit.id === relation.id), true);
  const explanation = retrieval.explainOwnerClaim(workspace, relation.id);
  assert.equal(explanation.claim.relationStatus, "registered");
  assert.equal(explanation.claim.target.canonicalEntityId, "project:search");
  assert.equal(explanation.history.length <= 20, true);
  assert.equal(explanation.reviewEvents.length <= 20, true);
  assert.equal(explanation.relations.length <= 15, true);
});

test("page bounds and typed filters apply after authorization and ranking", () => {
  approve(create(workspace, "Visible-second-428"));
  const first = search("Visible", { kinds: ["claim"], limit: 1 });
  assert.equal(first.results.length, 1);
  assert.equal(first.nextCursor, "1");
  const second = search("Visible", { kinds: ["claim"], limit: 1, cursor: first.nextCursor });
  assert.equal(second.results.length, 1);
  assert.notEqual(second.results[0].id, first.results[0].id);
  assert.equal(search("Visible", { kinds: ["person"] }).results.length, 0);
  for (const input of [
    { query: "a" }, { query: "something", cursor: "-1" },
    { query: "something", limit: 31 }, { query: "something", kinds: ["source"] },
  ]) {
    assert.throws(() => search(input.query, input), (error) => error.status === 400);
  }
});
