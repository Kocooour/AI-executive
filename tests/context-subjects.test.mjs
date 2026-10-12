import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-people-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const subjects = await import("../lib/context-subjects.ts");
const claims = await import("../lib/context-claims.ts");
const inbox = await import("../lib/context-inbox.ts");
const store = await import("../lib/server-store.ts");

function create(title = "Jana", type = "person", overrides = {}) {
  return subjects.createStandaloneSubject({ commandId: randomUUID(), id: randomUUID(), workspaceId: "personal",
    expectedRevision: 0, type, title, ...overrides }).subject;
}

function relation(targetId, overrides = {}) {
  return claims.createOwnerClaim({ commandId: randomUUID(), id: randomUUID(), workspaceId: "personal", expectedRevision: 0,
    subject: { entityId: "workspace:personal" }, predicate: "waiting_for", target: { subjectId: targetId },
    freshness: "current", sensitivity: "normal", ...overrides }).claim;
}

test("standalone migration is additive and create retry has one event", () => {
  const columns = store.getDatabase().prepare("PRAGMA table_info(context_subjects)").all().map((row) => row.name);
  assert.ok(columns.includes("archived_at"));
  const input = { commandId: randomUUID(), id: randomUUID(), workspaceId: "personal", expectedRevision: 0, type: "person", title: "Jana Nováková" };
  const first = subjects.createStandaloneSubject(input);
  const replay = subjects.createStandaloneSubject(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.subject, first.subject);
  assert.equal(subjects.listStandaloneSubjectHistory("personal", input.id).length, 1);
  assert.equal(store.readSnapshot().entities.some((entity) => entity.id === input.id), false);
  assert.throws(() => create("Reserved", "person", { id: "canonical:project:reserved" }),
    (error) => error.code === "reserved_subject_id");
});

test("canonical claims refuse a conflicting stored subject identity", () => {
  const now = Date.now();
  const project = { id: "project:identity-check", type: "project", title: "Identity check", workspaceId: "personal",
    status: "active", properties: {}, createdAt: now, updatedAt: now };
  store.getDatabase().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)")
    .run(project.id, JSON.stringify(project), now);
  store.getDatabase().prepare(`INSERT INTO context_subjects
    (id, workspace_id, subject_type, canonical_entity_id, display_title, revision, created_at, updated_at, archived_at)
    VALUES (?, 'personal', 'person', NULL, 'Conflicting person', 1, ?, ?, NULL)`)
    .run(`canonical:${project.id}`, now, now);
  assert.throws(() => claims.createOwnerClaim({ commandId: randomUUID(), id: randomUUID(), workspaceId: "personal",
    expectedRevision: 0, subject: { entityId: project.id }, predicate: "importance",
    literal: { type: "string", value: "high" }, freshness: "current", sensitivity: "normal" }),
    (error) => error.code === "subject_identity_conflict");
});

test("duplicate names, stale revisions, archive and cross-workspace references are guarded", () => {
  const jana = create("Jana Kocot");
  assert.throws(() => create("jana  kocot"), (error) => error.code === "duplicate_subject");
  const renamed = subjects.renameStandaloneSubject({ commandId: randomUUID(), id: jana.id, workspaceId: "personal",
    expectedRevision: jana.revision, title: "Jana K." }).subject;
  assert.equal(renamed.revision, jana.revision + 1);
  const renameHistory = subjects.listStandaloneSubjectHistory("personal", jana.id)[0];
  assert.equal(renameHistory.beforeTitle, "Jana Kocot");
  assert.equal(renameHistory.afterTitle, "Jana K.");
  assert.throws(() => subjects.renameStandaloneSubject({ commandId: randomUUID(), id: jana.id, workspaceId: "personal",
    expectedRevision: jana.revision, title: "Other" }), (error) => error.code === "revision_conflict");
  const otherWorkspace = { id: "workspace:team", type: "workspace", title: "Team", workspaceId: "team",
    status: "active", properties: {}, createdAt: Date.now(), updatedAt: Date.now() };
  store.getDatabase().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)")
    .run(otherWorkspace.id, JSON.stringify(otherWorkspace), otherWorkspace.updatedAt);
  assert.throws(() => subjects.getStandaloneSubject("team", jana.id), (error) => error.code === "not_found");
  assert.throws(() => claims.createOwnerClaim({ commandId: randomUUID(), id: randomUUID(), workspaceId: "team", expectedRevision: 0,
    subject: { entityId: "workspace:team" }, predicate: "waiting_for", target: { subjectId: jana.id },
    freshness: "current", sensitivity: "normal" }), (error) => error.code === "invalid_subject");
  const archived = subjects.archiveStandaloneSubject({ commandId: randomUUID(), id: jana.id, workspaceId: "personal",
    expectedRevision: renamed.revision }).subject;
  assert.ok(archived.archivedAt);
  assert.throws(() => relation(jana.id), (error) => error.code === "archived_subject");
});

test("relationship claims stay separate from person confirmation and honor AI eligibility", () => {
  const person = create("Petr");
  const proposal = relation(person.id);
  assert.equal(proposal.target.title, "Petr");
  assert.equal(proposal.target.canonicalEntityId, null);
  assert.equal(claims.isEligibleClaim(proposal), false);
  const reviewed = claims.reviewOwnerClaim({ commandId: randomUUID(), id: proposal.id, workspaceId: "personal",
    expectedRevision: proposal.revision, decision: "confirmed" }).claim;
  assert.equal(claims.isEligibleClaim(reviewed), true);
  const sensitive = relation(person.id, { sensitivity: "sensitive" });
  const sensitiveReviewed = claims.reviewOwnerClaim({ commandId: randomUUID(), id: sensitive.id, workspaceId: "personal",
    expectedRevision: sensitive.revision, decision: "confirmed" }).claim;
  assert.equal(claims.isEligibleClaim(sensitiveReviewed), false);
  const stale = relation(person.id, { freshness: "stale" });
  const staleReviewed = claims.reviewOwnerClaim({ commandId: randomUUID(), id: stale.id, workspaceId: "personal",
    expectedRevision: stale.revision, decision: "confirmed" }).claim;
  assert.equal(claims.isEligibleClaim(staleReviewed), false);
  subjects.archiveStandaloneSubject({ commandId: randomUUID(), id: person.id, workspaceId: "personal",
    expectedRevision: person.revision });
  assert.equal(claims.isEligibleClaim(reviewed), false);
  assert.equal(claims.listOwnerClaims("personal").some((claim) => claim.id === reviewed.id), true);
});

test("project filters include relationships where the project is the target", () => {
  const now = Date.now();
  const project = { id: "project:target-filter", type: "project", title: "Target project", workspaceId: "personal",
    status: "active", properties: {}, createdAt: now, updatedAt: now };
  store.getDatabase().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)")
    .run(project.id, JSON.stringify(project), now);
  const person = create("Target Owner");
  const relationship = claims.createOwnerClaim({ commandId: randomUUID(), id: randomUUID(), workspaceId: "personal",
    expectedRevision: 0, subject: { subjectId: person.id }, predicate: "responsible_for",
    target: { entityId: project.id }, freshness: "current", sensitivity: "normal" }).claim;
  assert.equal(claims.listOwnerClaims("personal", { projectId: project.id }).some((claim) => claim.id === relationship.id), true);
});

test("Context Inbox suggests a person without persisting preview and requires separate relationship approval", () => {
  const now = Date.now();
  const project = { id: "project:apollo", type: "project", title: "Apollo", workspaceId: "personal", status: "active", properties: {}, createdAt: now, updatedAt: now };
  store.getDatabase().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)").run(project.id, JSON.stringify(project), now);
  const existing = create("Jana");
  const before = Number(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM context_claims").get().count);
  const proposal = inbox.previewContextInbox("personal", "Apollo – na výsledek čeká Jana").proposals[0];
  assert.equal(proposal.suggestedTarget.title, "Jana");
  assert.equal(proposal.suggestedTarget.matches[0].id, existing.id);
  assert.equal(Number(store.getDatabase().prepare("SELECT COUNT(*) AS count FROM context_claims").get().count), before);
  const saved = inbox.approveContextInboxClaim({ commandId: randomUUID(), workspaceId: "personal", id: proposal.id,
    subjectId: proposal.subject.entityId, predicate: proposal.predicate, targetSubjectId: existing.id,
    freshness: "needs_review", evidenceExcerpt: proposal.evidenceExcerpt }).claim;
  assert.equal(saved.target.id, existing.id);
  assert.equal(saved.reviewStatus, "proposed");
  assert.equal(saved.sensitivity, "confidential");
  assert.equal(claims.isEligibleClaim(saved), false);
  const ambiguous = inbox.previewContextInbox("personal", "Apollo – na výsledek čeká Jana a Petr").proposals[0];
  assert.equal(ambiguous.suggestedTarget, undefined);
  assert.equal(ambiguous.literal.type, "string");
  assert.equal(inbox.previewContextInbox("personal", "Apollo – na výsledek čeká Jana, Petr").proposals[0].suggestedTarget, undefined);
  const english = inbox.previewContextInbox("personal", "Jana is waiting for Apollo result").proposals[0];
  assert.equal(english.subject.entityId, "project:apollo");
  assert.equal(english.suggestedTarget.title, "Jana");
});
