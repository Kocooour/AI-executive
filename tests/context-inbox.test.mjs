import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-context-inbox-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
process.env.AI_EXECUTIVE_AUTH_ENABLED = "false";
after(() => rmSync(dataDir, { recursive: true, force: true }));

const inbox = await import("../lib/context-inbox.ts");
const claims = await import("../lib/context-claims.ts");
const store = await import("../lib/server-store.ts");

function addEntity(entity) {
  store.getDatabase().prepare("INSERT INTO entities (id,payload,updated_at) VALUES (?,?,?)")
    .run(entity.id, JSON.stringify(entity), entity.updatedAt);
}

const now = Date.now();
addEntity({ id: "project:apollo", type: "project", title: "Apollo", status: "active", workspaceId: "personal", properties: {}, createdAt: now, updatedAt: now });

test("preview is deterministic in meaning, matches only live entities and stores no pasted text", () => {
  const beforeClaims = Number(store.getDatabase().prepare("SELECT COUNT(*) count FROM context_claims").get().count);
  const text = "Apollo – priorita: vysoká\nApollo – na výsledek čeká Jana\nApollo – termín: 2026-10-10\nNeznámý projekt – preference: ráno";
  const preview = inbox.previewContextInbox("personal", text);
  assert.deepEqual(preview.proposals.map((item) => item.predicate), ["importance", "waiting_for", "target_date", "preference"]);
  assert.deepEqual(preview.proposals.slice(0, 3).map((item) => item.subject.entityId), ["project:apollo", "project:apollo", "project:apollo"]);
  assert.equal(preview.proposals[3].subject.entityId, "workspace:personal");
  assert.equal(preview.proposals.every((item) => item.sensitivity === "sensitive"), true);
  assert.equal(Number(store.getDatabase().prepare("SELECT COUNT(*) count FROM context_claims").get().count), beforeClaims);
  const serializedRows = JSON.stringify(store.getDatabase().prepare("SELECT * FROM context_claims").all());
  assert.equal(serializedRows.includes(text), false);
});

test("an approved item is created as proposed and remains editable/rejectable through claim workflow", () => {
  const proposal = inbox.previewContextInbox("personal", "Apollo – priorita: vysoká").proposals[0];
  const result = inbox.approveContextInboxClaim({ commandId: randomUUID(), workspaceId: "personal", id: proposal.id,
    subjectId: proposal.subject.entityId, predicate: proposal.predicate,
    literal: { ...proposal.literal, value: "critical" }, freshness: "needs_review",
    validTo: "2026-12-31", evidenceExcerpt: proposal.evidenceExcerpt });
  assert.equal(result.claim.reviewStatus, "proposed");
  assert.equal(result.claim.literal.value, "critical");
  assert.equal(result.claim.sensitivity, "sensitive");
  assert.equal(result.claim.source.provider, "manual-context-inbox");
  const rejected = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: "personal", id: result.claim.id,
    expectedRevision: result.claim.revision, decision: "rejected" }).claim;
  assert.equal(rejected.reviewStatus, "rejected");
});

test("action-like bullets become editable drafts with scheduling hints but are never persisted as tasks", () => {
  const before = store.readSnapshot().entities.length;
  const result = inbox.previewContextInbox("personal", "- Apollo: připravit podklady pro Janu, priorita: vysoká, termín: 2026-10-10");
  assert.equal(result.taskDrafts.length, 1);
  assert.equal(result.taskDrafts[0].subject.entityId, "project:apollo");
  assert.equal(result.taskDrafts[0].suggestedDate, "2026-10-10");
  assert.equal(result.taskDrafts[0].suggestedPriority, "high");
  assert.equal(result.taskDrafts[0].title, "Apollo: připravit podklady pro Janu");
  assert.equal(store.readSnapshot().entities.length, before);
});
