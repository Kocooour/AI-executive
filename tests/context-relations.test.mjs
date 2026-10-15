import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "albert-relations-"));
process.env.AI_EXECUTIVE_DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const claims = await import("../lib/context-claims.ts");
const subjects = await import("../lib/context-subjects.ts");
const relations = await import("../lib/context-relations.ts");
const history = await import("../lib/context-history.ts");
const store = await import("../lib/server-store.ts");

const db = () => store.getDatabase();
const ws = "personal";
const now = Date.now();
for (const entity of [
  { id: "project:rel", type: "project", title: "Relations project" },
  { id: "task:rel", type: "task", title: "Relations task" },
  { id: "area:rel", type: "area", title: "Relations area" },
  { id: "note:rel", type: "note", title: "Relations note" },
]) db().prepare("INSERT INTO entities (id, payload, updated_at) VALUES (?, ?, ?)")
  .run(entity.id, JSON.stringify({ ...entity, status: "active", workspaceId: ws, properties: {}, createdAt: now, updatedAt: now }), now);

const person = (title) => subjects.createStandaloneSubject({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, type: "person", title: `${title} ${randomUUID()}` }).subject;
const organization = (title) => subjects.createStandaloneSubject({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, type: "organization", title: `${title} ${randomUUID()}` }).subject;
const relate = (subject, predicate, target, overrides = {}) => claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0,
  subject: subject.startsWith?.("project:") || subject.startsWith?.("task:") || subject.startsWith?.("area:") || subject.startsWith?.("note:") || subject.startsWith?.("workspace:") ? { entityId: subject } : { subjectId: subject },
  predicate, target: target.startsWith("project:") || target.startsWith("task:") || target.startsWith("area:") || target.startsWith("note:") ? { entityId: target } : { subjectId: target },
  freshness: "current", sensitivity: "normal", ...overrides }).claim;

test("the registry is static, versioned and complete, with labels in both languages", () => {
  assert.equal(relations.RELATION_REGISTRY_VERSION, 1);
  assert.deepEqual(relations.relationRegistry.map((entry) => entry.predicate).sort(), [
    "arose_from", "assigned_to", "blocked_by", "participates_in", "related_to", "responsible_for", "supersedes", "uses", "waiting_for", "works_for"]);
  for (const entry of relations.relationRegistry) {
    for (const text of [entry.labels.cs, entry.labels.en, entry.inverse.cs, entry.inverse.en]) assert.ok(text.trim(), entry.predicate);
    assert.ok(entry.subjectTypes.length && entry.targetTypes.length, entry.predicate);
  }
  assert.equal(relations.getRelationDefinition("related_to").symmetric, true);
  assert.equal(relations.getRelationDefinition("works_for").labels.cs, "pracuje pro");
  assert.equal(relations.getRelationDefinition("works_for").inverse.cs, "zaměstnává");
  assert.equal(relations.getRelationDefinition("belongs_to_project"), null, "canonical relations are a different mechanism");
});

test("endpoint types decide which relations are allowed", () => {
  const ok = (predicate, subject, target) => relations.checkRelation(predicate, subject, target).ok;
  assert.equal(ok("works_for", "person", "organization"), true);
  assert.equal(ok("works_for", "organization", "person"), false);
  assert.equal(ok("works_for", "person", "project"), false);
  assert.equal(ok("assigned_to", "task", "person"), true);
  assert.equal(ok("assigned_to", "person", "task"), false);
  assert.equal(ok("responsible_for", "organization", "project"), true);
  assert.equal(ok("responsible_for", "project", "person"), false);
  assert.equal(ok("blocked_by", "task", "project"), true);
  assert.equal(ok("blocked_by", "person", "task"), false);
  assert.equal(ok("supersedes", "note", "note"), true);
  assert.equal(ok("supersedes", "note", "task"), false);
  assert.equal(ok("related_to", "workspace", "person"), true);
  assert.equal(ok("waiting_for", "task", "person"), true);
  assert.equal(ok("waiting_for", "person", "task"), false);
  assert.equal(relations.relationsBetween("person", "organization").some((entry) => entry.predicate === "works_for"), true);
  assert.equal(relations.relationsBetween("organization", "person").some((entry) => entry.predicate === "works_for"), false);
});

test("a relationship claim must be a registered relation between allowed types (400 invalid_relation)", () => {
  const jana = person("Jana");
  const acme = organization("Acme");
  const created = relate(jana.id, "works_for", acme.id);
  assert.equal(created.relationStatus, "registered");
  assert.equal(created.freshness, "current");
  const invalid = (action) => assert.throws(action, (error) => error.status === 400 && error.code === "invalid_relation" && error.message.length > 20);
  invalid(() => relate(acme.id, "works_for", jana.id));
  invalid(() => relate(jana.id, "owns", acme.id));
  invalid(() => relate(jana.id, "works_for", "project:rel"));
  invalid(() => relate("task:rel", "responsible_for", jana.id));
  const before = Number(db().prepare("SELECT COUNT(*) AS count FROM context_change_events").get().count);
  invalid(() => relate("project:rel", "supersedes", "note:rel"));
  assert.equal(Number(db().prepare("SELECT COUNT(*) AS count FROM context_change_events").get().count), before, "a refused relation writes nothing");

  // The same rule on update: the endpoints are the claim's subject and the new target.
  assert.throws(() => claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: created.revision, predicate: "works_for",
    target: { entityId: "project:rel" }, freshness: "current", sensitivity: "normal" }), (error) => error.code === "invalid_relation");
  assert.throws(() => claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: created.revision, predicate: "owns",
    target: { subjectId: acme.id }, freshness: "current", sensitivity: "normal" }), (error) => error.code === "invalid_relation");
  const moved = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: created.revision, predicate: "participates_in",
    target: { entityId: "project:rel" }, freshness: "current", sensitivity: "normal" }).claim;
  assert.equal(moved.predicate, "participates_in");
});

test("related_to is symmetric and valid between any two endpoints; supersedes needs the same type", () => {
  const jana = person("Jana");
  const acme = organization("Acme");
  assert.equal(relate(jana.id, "related_to", acme.id).relationStatus, "registered");
  assert.equal(relate(acme.id, "related_to", "project:rel").relationStatus, "registered");
  assert.equal(relate("task:rel", "related_to", "note:rel").relationStatus, "registered");
  assert.equal(relations.getRelationDefinition("related_to").inverse.cs, relations.getRelationDefinition("related_to").labels.cs);
  assert.throws(() => relate(jana.id, "supersedes", acme.id), (error) => error.code === "invalid_relation");
  assert.equal(relate(jana.id, "waiting_for", acme.id).relationStatus, "registered", "waiting_for keeps existing data valid");
  // supersedes is for work items and notes, never for people or organizations.
  assert.equal(relations.checkRelation("supersedes", "person", "person").ok, false);
  assert.equal(relations.checkRelation("supersedes", "organization", "organization").ok, false);
  assert.equal(relations.checkRelation("supersedes", "area", "area").ok, true);
});

test("a literal claim keeps a free-text predicate", () => {
  const free = claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, subject: { entityId: "workspace:personal" },
    predicate: "favourite.colour", literal: { type: "string", value: "green" }, freshness: "current", sensitivity: "normal" }).claim;
  assert.equal(free.relationStatus, null);
  assert.equal(free.freshness, "current");
});

test("an existing relationship claim with an unregistered predicate is not rewritten, reads as needing review and is never eligible", () => {
  const jana = person("Jana");
  const acme = organization("Acme");
  const created = relate(jana.id, "works_for", acme.id);
  const confirmed = claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: created.revision, decision: "confirmed" }).claim;
  // Written by an older release, which accepted any predicate.
  db().prepare("UPDATE context_claims SET predicate = 'owns' WHERE id = ?").run(created.id);
  const read = claims.listOwnerClaims(ws).find((claim) => claim.id === created.id);
  assert.equal(read.relationStatus, "unregistered");
  assert.equal(read.freshness, "needs_review");
  assert.equal(read.predicate, "owns");
  assert.equal(claims.isEligibleClaim(read), false);
  assert.equal(claims.listEligibleClaims(ws).some((claim) => claim.id === created.id), false);
  const stored = db().prepare("SELECT predicate, freshness, revision FROM context_claims WHERE id = ?").get(created.id);
  assert.deepEqual({ ...stored }, { predicate: "owns", freshness: "current", revision: confirmed.revision }, "reading rewrote nothing");

  // Saving it unchanged is refused; the owner edits it to a registered predicate.
  assert.throws(() => claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: read.revision, predicate: "owns",
    target: { subjectId: acme.id }, freshness: "current", sensitivity: "normal" }), (error) => error.code === "invalid_relation");
  const fixed = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: read.revision, predicate: "works_for",
    target: { subjectId: acme.id }, freshness: "current", sensitivity: "normal" }).claim;
  assert.equal(fixed.relationStatus, "registered");
  assert.equal(fixed.freshness, "current");
  // It can be reviewed and archived while unregistered, and Undo restores what was there without validating it.
  db().prepare("UPDATE context_claims SET predicate = 'owns' WHERE id = ?").run(created.id);
  const legacy = claims.listOwnerClaims(ws).find((claim) => claim.id === created.id);
  assert.equal(claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: legacy.revision, decision: "rejected" }).claim.reviewStatus, "rejected");
});

test("a relation whose endpoint types do not fit reads as invalid_endpoints and needing review", () => {
  const jana = person("Jana");
  const acme = organization("Acme");
  const created = relate(jana.id, "works_for", acme.id);
  db().prepare("UPDATE context_claims SET subject_id = ?, target_subject_id = ? WHERE id = ?").run(acme.id, jana.id, created.id);
  const read = claims.listOwnerClaims(ws).find((claim) => claim.id === created.id);
  assert.equal(read.relationStatus, "invalid_endpoints");
  assert.equal(read.freshness, "needs_review");
});

test("confirming one claim never confirms the claims or relations of the same person", () => {
  const jana = person("Jana");
  const acme = organization("Acme");
  const relation = relate(jana.id, "works_for", acme.id);
  const other = claims.createOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: randomUUID(), expectedRevision: 0, subject: { subjectId: jana.id },
    predicate: "preference", literal: { type: "string", value: "Mornings" }, freshness: "current", sensitivity: "normal" }).claim;
  claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: other.id, expectedRevision: other.revision, decision: "confirmed" });
  const read = (id) => claims.listOwnerClaims(ws).find((claim) => claim.id === id);
  assert.equal(read(relation.id).reviewStatus, "proposed");
  assert.equal(claims.isEligibleClaim(read(relation.id)), false);
  // Creating, renaming or archiving the person or organization creates no claim and confirms nothing.
  subjects.renameStandaloneSubject({ commandId: randomUUID(), workspaceId: ws, id: acme.id, expectedRevision: acme.revision, title: `${acme.title} Ltd` });
  assert.equal(read(relation.id).reviewStatus, "proposed");
});

test("an Undo of a relationship step does not validate the relation it brings back", () => {
  const jana = person("Jana");
  const acme = organization("Acme");
  const created = relate(jana.id, "works_for", acme.id);
  const moved = claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: created.revision, predicate: "related_to",
    target: { subjectId: acme.id }, freshness: "current", sensitivity: "normal" }).claim;
  assert.equal(moved.predicate, "related_to");
  const state = history.getContextHistory(ws).undo;
  const undone = history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: state.eventId });
  assert.equal(undone.object.predicate, "works_for");
});

test("an active relationship is unique per subject, predicate and target; related_to also in reverse (409 duplicate_relation)", () => {
  const jana = person("Jana");
  const acme = organization("Acme");
  const first = relate(jana.id, "works_for", acme.id);
  assert.throws(() => relate(jana.id, "works_for", acme.id), (error) => error.status === 409 && error.code === "duplicate_relation");
  const related = relate(jana.id, "related_to", acme.id);
  assert.throws(() => relate(acme.id, "related_to", jana.id), (error) => error.code === "duplicate_relation");
  assert.throws(() => relate(jana.id, "related_to", acme.id), (error) => error.code === "duplicate_relation");
  // Another predicate is another relationship, and an archived claim frees the slot.
  assert.equal(relate(jana.id, "waiting_for", acme.id).relationStatus, "registered");
  const other = relate(jana.id, "participates_in", "project:rel");
  assert.throws(() => claims.updateOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: other.id, expectedRevision: other.revision, predicate: "works_for",
    target: { subjectId: acme.id }, freshness: "current", sensitivity: "normal" }), (error) => error.code === "duplicate_relation");
  const archived = claims.archiveOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: related.id, expectedRevision: related.revision }).claim;
  const again = relate(acme.id, "related_to", jana.id);
  assert.equal(again.relationStatus, "registered");
  const archiveEvent = db().prepare("SELECT id FROM context_change_events WHERE workspace_id = ? AND object_id = ? AND operation = 'archive'").get(ws, related.id);
  // Undoing the archive would bring a second active related_to between the two back: refused, nothing written.
  const undoArchive = () => history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: archiveEvent.id });
  // Make the archive the top step: undo what came after it (creating `again` is one step; the claim of `again`).
  history.runHistoryCommand({ action: "undo", commandId: randomUUID(), workspaceId: ws, expectedEventId: history.getContextHistory(ws).undo.eventId });
  assert.equal(history.getContextHistory(ws).undo.eventId, archiveEvent.id);
  db().prepare("UPDATE context_claims SET archived_at = NULL WHERE id = ?").run(again.id);
  assert.throws(() => undoArchive(), (error) => error.code === "undo_conflict");
  assert.equal(archived.archivedAt !== null, true);
  assert.ok(first);
});

test("an unregistered relationship cannot be confirmed, but can be rejected and returned to review", () => {
  const jana = person("Jana");
  const acme = organization("Acme");
  const created = relate(jana.id, "works_for", acme.id);
  db().prepare("UPDATE context_claims SET predicate = 'owns' WHERE id = ?").run(created.id);
  let current = claims.listOwnerClaims(ws).find((claim) => claim.id === created.id);
  const review = (decision) => claims.reviewOwnerClaim({ commandId: randomUUID(), workspaceId: ws, id: created.id, expectedRevision: current.revision, decision }).claim;
  assert.throws(() => review("confirmed"), (error) => error.status === 409 && error.code === "relation_needs_fix");
  current = review("rejected");
  current = review("proposed");
  assert.equal(current.reviewStatus, "proposed");
});
