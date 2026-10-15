import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-leaks-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../lib/server-store.ts");
const claims = await import("../lib/context-claims.ts");
const sources = await import("../lib/context-sources.ts");
const evidence = await import("../lib/context-evidence.ts");
const pact = await import("../lib/pact.ts");
const pactTools = await import("../lib/pact-tools.ts");
const aiActions = await import("../lib/ai-provider-context.ts");
const plan = await import("../lib/day-plan.ts");
const attention = await import("../lib/attention-service.ts");

const ws = "personal";
const db = () => store.getDatabase();
const now = Date.now();
const add = (entity) => db().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)").run(entity.id, JSON.stringify(entity), entity.updatedAt);
const today = plan.currentDayPlanDate(now);
add({ id: "project:leak", type: "project", title: "Leak project", status: "active", workspaceId: ws, properties: {}, createdAt: now, updatedAt: now });
add({ id: "task:leak", type: "task", title: "Leak task", status: "open", workspaceId: ws, properties: { projectId: "project:leak", when: today, estimatedMinutes: 25 }, createdAt: now, updatedAt: now });

// Distinct strings, so a leak anywhere in a serialised bundle is found by a plain search.
const secrets = {
  confidential: ["CONF-EXCERPT-7731", "CONF-LOCATOR-7731", "conf-author-7731", "CONF-EXTERNAL-7731", "conf-account-7731@example.test", "https://conf.example.test/7731"],
  restricted: ["RESTR-EXCERPT-4417", "RESTR-LOCATOR-4417", "restr-author-4417", "RESTR-EXTERNAL-4417", "restr-account-4417@example.test", "https://restr.example.test/4417"],
};
const visible = "VISIBLE-EXCERPT-1001";

function source(level, [, , author, externalId, account, locator]) {
  return sources.createContextSource({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, provider: `${level}-provider`, author, externalId,
    account, locator, coverage: "body", sensitivity: level, sourceAt: "2026-05-01" }).source;
}

function eligibleClaimWithEvidence() {
  let claim = claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, subject: { entityId: "project:leak" },
    predicate: "importance", literal: { type: "string", value: "high" }, freshness: "current", sensitivity: "normal" }).claim;
  const cite = (src, excerpt, locator) => {
    claim = evidence.addClaimEvidence({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, claimId: claim.id, expectedClaimRevision: claim.revision,
      sourceId: src.id, excerpt, locator, stance: "supports" }).claim;
  };
  cite(sources.createContextSource({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, provider: "normal-provider", coverage: "body", sensitivity: "normal" }).source, visible, null);
  cite(source("confidential", secrets.confidential), secrets.confidential[0], secrets.confidential[1]);
  cite(source("restricted", secrets.restricted), secrets.restricted[0], secrets.restricted[1]);
  return claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: claim.id, expectedRevision: claim.revision, decision: "confirmed" }).claim;
}
const claim = eligibleClaimWithEvidence();
const allSecrets = [...secrets.confidential, ...secrets.restricted];
const leaks = (text) => allSecrets.filter((secret) => text.includes(secret));

test("the owner sees all evidence, but only a normal source's evidence is eligible to be shared", () => {
  assert.equal(claim.evidenceCount, 3);
  assert.equal(JSON.stringify(claim).includes(secrets.confidential[0]), true);
  assert.equal(claims.isEligibleClaim(claim), true, "the claim itself stays eligible");
});

test("agent claims keep only normal evidence and drop every owner-only field", () => {
  const agent = claims.toAgentClaim(claim);
  assert.equal(agent.evidence.length, 1);
  assert.equal(agent.evidence[0].excerpt, visible);
  assert.deepEqual(Object.keys(agent.evidence[0].source).sort(), ["coverage", "provider", "sourceAt"]);
  assert.equal("source" in agent, false);
  assert.equal("evidenceItems" in agent, false);
  assert.deepEqual(leaks(JSON.stringify(agent)), []);
  assert.equal(JSON.stringify(agent).includes("normal-provider"), true);
});

test("the resolver bundle for agents carries no confidential or restricted evidence or source data", () => {
  for (const agentId of ["aifred", "project-manager", "meeting-prep"]) {
    const bundle = pact.resolvePACTContext({ agent: pact.getPACTAgent(agentId), workspaceId: ws, includeSensitive: false });
    assert.equal(bundle.claims.some((item) => item.id === claim.id), true, agentId);
    assert.deepEqual(leaks(JSON.stringify(bundle)), [], agentId);
  }
  const forProject = pact.resolvePACTContext({ workspaceId: ws, projectId: "project:leak", includeSensitive: true });
  assert.deepEqual(leaks(JSON.stringify(forProject)), []);
});

test("a claim whose only evidence is confidential reads as having no source for an agent", () => {
  let only = claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, subject: { entityId: "project:leak" },
    predicate: "preference", literal: { type: "string", value: "only hidden" }, freshness: "current", sensitivity: "normal" }).claim;
  only = evidence.addClaimEvidence({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, claimId: only.id, expectedClaimRevision: only.revision,
    sourceId: source("confidential", ["x", "y", "other-author", "OTHER-EXTERNAL", "other@example.test", "https://other.example.test"]).id, excerpt: "hidden", stance: "supports" }).claim;
  only = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: only.id, expectedRevision: only.revision, decision: "confirmed" }).claim;
  const agent = claims.toAgentClaim(only);
  assert.deepEqual([agent.evidence.length, agent.sourceCoverage], [0, "missing"]);
});

test("the AI provider prompt and the agent read tools carry none of it", () => {
  const prompt = aiActions.providerContext(ws, []);
  assert.equal(prompt.includes("Confirmed current context claims"), true);
  assert.equal(prompt.includes("importance"), true);
  assert.deepEqual(leaks(prompt), []);
  for (const tool of ["task.read", "project.read", "note.read", "context.read"]) {
    assert.deepEqual(leaks(JSON.stringify(pactTools.executePACTReadTool(tool, ws, {}))), [], tool);
  }
});

test("the day plan and attention never serialise evidence", () => {
  assert.deepEqual(leaks(JSON.stringify(plan.buildDayPlan(ws, today, now))), []);
  assert.deepEqual(leaks(JSON.stringify(attention.evaluateWorkspace(store.readSnapshot(), ws, "Europe/Prague", now))), []);
});

test("the integration routes and agent code never read sources or evidence", () => {
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? files(file) : [file];
  });
  const sensitive = /context-sources|context-evidence|evidence_metadata|source_metadata|context_sources|context_evidence/;
  for (const file of [...files("app/api/integrations"), "lib/pact.ts", "lib/pact-tools.ts", "lib/pact-agent-runs.ts", "lib/day-plan.ts", "lib/attention-service.ts", "lib/ai-actions.ts"]) {
    assert.equal(sensitive.test(readFileSync(file, "utf8")), false, file);
  }
  // The owner-only routes check the owner session and take no bearer token.
  for (const route of ["sources", "evidence", "relations"]) {
    const text = readFileSync(`app/api/context/${route}/route.ts`, "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.match(text, /isAuthenticated\(request\)/);
    assert.doesNotMatch(text, /bearer|authorization/i);
  }
});

test("a source made stricter after the fact is hidden from agents at the next read", () => {
  const visibleSource = sources.listContextSources(ws).find((item) => item.provider === "normal-provider");
  assert.equal(claims.toAgentClaim(claims.listOwnerClaims(ws).find((item) => item.id === claim.id)).evidence.length, 1);
  sources.updateContextSource({ commandId: randomUUID(), workspaceId: ws, id: visibleSource.id, expectedRevision: visibleSource.revision, provider: visibleSource.provider,
    coverage: visibleSource.coverage, sensitivity: "confidential" });
  const agent = claims.toAgentClaim(claims.listOwnerClaims(ws).find((item) => item.id === claim.id));
  assert.equal(agent.evidence.length, 0);
  assert.equal(JSON.stringify(agent).includes(visible), false);
  assert.equal(JSON.stringify(pact.resolvePACTContext({ workspaceId: ws })).includes(visible), false);
});
