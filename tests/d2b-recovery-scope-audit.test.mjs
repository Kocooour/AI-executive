import assert from "node:assert/strict";
import test from "node:test";
import { auditOfflineRecoveryScopes, RecoveryScopeGraphInvalid } from "../lib/d2b-recovery-scope-audit.ts";

const entity = (id, type, properties = {}, workspaceId = "personal", status = "active") => ({
  id, type, title: "PRIVATE-TITLE-" + id, status, workspaceId,
  properties, createdAt: 1, updatedAt: 1,
});
const edge = (id, sourceEntityId, targetEntityId, relationType, workspaceId = "personal") => ({
  id, sourceEntityId, targetEntityId, relationType, workspaceId, createdAt: 1,
});
const sample = () => ({
  revision: 10, restoreGeneration: 1,
  entities: [
    entity("secret-a", "area", { kind: "private" }),
    entity("secret-b", "area", { kind: "private" }),
    entity("secret-project", "project"),
    entity("secret-task", "task", {}, "personal", "open"),
    entity("secret-note", "note"),
    entity("secret-standalone", "task", {}, "personal", "open"),
  ],
  relations: [
    edge("project-area", "secret-project", "secret-a", "belongs_to_area"),
    edge("task-project", "secret-task", "secret-project", "belongs_to_project"),
    edge("note-project", "secret-note", "secret-project", "belongs_to_project"),
    edge("standalone-area", "secret-standalone", "secret-b", "belongs_to_area"),
  ],
});
const clone = value => structuredClone(value);
const inspect = (before, current = clone(before)) =>
  auditOfflineRecoveryScopes({
    before,
    current: { ...current, revision: 2, restoreGeneration: 2 },
  });

test("D2b/7: equal scopes give only private aggregate diagnostics, NEVER authority", () => {
  const before = sample();
  const old = JSON.stringify(before);
  const result = inspect(before);
  assert.deepEqual(result.summary, {
    recordsCompared: 6, sameScope: 6, movedArea: 0, movedWorkspace: 0,
    absentOnOneSide: 0, beforeCrossAreaRelations: 0, currentCrossAreaRelations: 0,
  });
  assert.equal(result.phase, "scope-graph-audit-only");
  assert.equal(result.completeness, "unverified");
  assert.equal(result.identity, "unverified");
  assert.equal(result.membership, "unverified");
  assert.equal(result.areaPermission, "unverified");
  assert.equal(result.consent, "not-requested");
  assert.equal(result.canApply, false);
  assert.equal(result.canReleaseHold, false);
  assert.equal(result.automaticReplayAllowed, false);
  assert.equal(Object.isFrozen(result.summary), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify(before), old);
  assert.doesNotMatch(JSON.stringify(result), /secret-|PRIVATE-TITLE-|project-area/);
});

test("D2b/7 detects server-only project Area move, including unchanged task and note inheritance", () => {
  const before = sample();
  const current = clone(before);
  current.relations.find(r => r.id === "project-area").targetEntityId = "secret-b";
  const result = inspect(before, current);
  assert.equal(result.summary.movedArea, 3, "project, task, note inherit changed Area");
  assert.equal(result.summary.sameScope, 3);
  assert.equal(result.canReleaseHold, false);
});

test("D2b/7 separates workspace move from Area move", () => {
  const before = sample();
  const current = clone(before);
  current.entities.push(entity("workspace:shared-one", "workspace", { kind: "shared" }, "shared-one"));
  current.entities.push(entity("shared-area", "area", { kind: "shared" }, "shared-one"));
  current.entities.find(e => e.id === "secret-standalone").workspaceId = "shared-one";
  current.relations = current.relations.filter(r => r.id !== "standalone-area");
  current.relations.push(edge("new-shared-area", "secret-standalone", "shared-area", "belongs_to_area", "shared-one"));
  const result = inspect(before, current);
  assert.equal(result.summary.movedWorkspace, 1);
  assert.equal(result.summary.absentOnOneSide, 1, "new Area is not presumed authorized");
  assert.equal(result.canApply, false);
});

test("D2b/7 marks missing records separately; absence is not consent to discard", () => {
  const before = sample();
  const current = clone(before);
  current.entities = current.entities.filter(e => e.id !== "secret-note");
  current.relations = current.relations.filter(r => r.id !== "note-project");
  const result = inspect(before, current);
  assert.equal(result.summary.absentOnOneSide, 1);
  assert.equal(result.summary.movedArea, 0);
  assert.equal(result.canReleaseHold, false);
});

test("D2b/7 counts unrelated cross-Area links without declaring the graph safe", () => {
  const before = sample();
  const current = clone(before);
  current.relations.push(edge("unsafe-link", "secret-task", "secret-standalone", "related"));
  const result = inspect(before, current);
  assert.equal(result.summary.beforeCrossAreaRelations, 0);
  assert.equal(result.summary.currentCrossAreaRelations, 1);
  assert.equal(result.canApply, false);
});

test("D2b/7 rejects ambiguous, dangling, duplicate and cross-workspace edges", () => {
  const before = sample();
  const wrong = clone(before);
  wrong.relations.push(edge("another-project-area", "secret-project", "secret-b", "belongs_to_area"));
  assert.throws(() => inspect(before, wrong), RecoveryScopeGraphInvalid);
  const dangling = clone(before);
  dangling.relations.find(r => r.id === "task-project").targetEntityId = "unknown";
  assert.throws(() => inspect(before, dangling), RecoveryScopeGraphInvalid);
  const duplicated = clone(before);
  duplicated.relations.push(edge("secret-task", "secret-task", "secret-project", "belongs_to_project"));
  assert.throws(() => inspect(before, duplicated), RecoveryScopeGraphInvalid);
  const foreign = clone(before);
  foreign.relations.find(r => r.id === "task-project").workspaceId = "shared";
  assert.throws(() => inspect(before, foreign), RecoveryScopeGraphInvalid);
});


test("D2b/7 rejects unscoped workspace relationship endpoints in BOTH graphs", () => {
  const before = sample();
  before.entities.push(entity("workspace:personal", "workspace", { kind: "personal" }));
  // Workspace entities exist for graph completeness but have no Area scope.
  // Do not silently discard a workspace->task relation as a zero-risk graph.
  const current = clone(before);
  current.relations.push(edge("unroutable-current", "workspace:personal", "secret-task", "related"));
  assert.throws(() => inspect(before, current), RecoveryScopeGraphInvalid);
  const reversed = clone(before);
  reversed.relations.push(edge("unroutable-before", "secret-task", "workspace:personal", "related"));
  assert.throws(() => inspect(reversed, before), RecoveryScopeGraphInvalid);

  const clean = inspect(before);
  assert.equal(clean.summary.currentCrossAreaRelations, 0);
  assert.equal(clean.canReleaseHold, false);
});

test("D2b/7 rejects same-ID task to note drift even when effective Area stays equal", () => {
  const before = sample();
  const current = clone(before);
  const replacement = current.entities.find(e => e.id === "secret-standalone");
  replacement.type = "note";
  replacement.status = "active";
  // Both standalone tasks and notes validly use the same direct Area link.
  assert.throws(() => inspect(before, current), RecoveryScopeGraphInvalid);
});

test("D2b/7 rejects same-ID project to task drift and cross-kind ID recycling", () => {
  const before = sample();
  const current = clone(before);
  const replacement = current.entities.find(e => e.id === "secret-project");
  replacement.type = "task";
  replacement.status = "open";
  current.entities = current.entities.filter(e => e.id !== "secret-task" && e.id !== "secret-note");
  current.relations = current.relations.filter(r => r.id !== "task-project" && r.id !== "note-project");
  // The former project now has a valid standalone task Area; children were
  // removed to avoid dangling edges. Type drift itself must still be rejected.
  assert.throws(() => inspect(before, current), RecoveryScopeGraphInvalid);

  const recycled = clone(before);
  recycled.entities = recycled.entities.filter(e => e.id !== "secret-standalone");
  recycled.relations = recycled.relations.filter(r => r.id !== "standalone-area");
  recycled.relations.push(edge("secret-standalone", "secret-project", "secret-task", "related"));
  // Previously an entity ID, now a relation ID in a self-consistent graph.
  assert.throws(() => inspect(before, recycled), RecoveryScopeGraphInvalid);
});

test("D2b/7 refuses project task/note direct Area overrides and mismatched legacy fields", () => {
  const before = sample();
  const extra = clone(before);
  extra.relations.push(edge("direct-task-area", "secret-task", "secret-a", "belongs_to_area"));
  assert.throws(() => inspect(before, extra), RecoveryScopeGraphInvalid);
  const legacy = clone(before);
  legacy.entities.find(e => e.id === "secret-note").properties.projectId = "different-project";
  assert.throws(() => inspect(before, legacy), RecoveryScopeGraphInvalid);
  const areaConflict = clone(before);
  areaConflict.entities.find(e => e.id === "secret-project").properties.areaId = "secret-b";
  assert.throws(() => inspect(before, areaConflict), RecoveryScopeGraphInvalid);
});

test("D2b/7 validates Area kind, inactive Area, missing workspace and malformed inputs", () => {
  const before = sample();
  const missingKind = clone(before);
  delete missingKind.entities.find(e => e.id === "secret-a").properties.kind;
  assert.throws(() => inspect(before, missingKind), RecoveryScopeGraphInvalid);
  const inactive = clone(before);
  inactive.entities.find(e => e.id === "secret-a").status = "archived";
  assert.throws(() => inspect(before, inactive), RecoveryScopeGraphInvalid);
  const noWorkspace = clone(before);
  noWorkspace.entities.find(e => e.id === "secret-task").workspaceId = "shared-unknown";
  assert.throws(() => inspect(before, noWorkspace), RecoveryScopeGraphInvalid);
  assert.throws(() => auditOfflineRecoveryScopes({ before, current: { ...before, restoreGeneration: 0 } }), RecoveryScopeGraphInvalid);
  assert.throws(() => auditOfflineRecoveryScopes({ before, current: { ...before, restoreGeneration: 2, revision: -1 } }), RecoveryScopeGraphInvalid);
  assert.throws(() => inspect(before, { ...before, relations: new Array(50_001) }), RecoveryScopeGraphInvalid);
});

test("D2b/7 accepts matching legacy Area/project IDs only as evidence, not permission", () => {
  const before = sample();
  before.entities.find(e => e.id === "secret-project").properties.areaId = "secret-a";
  before.entities.find(e => e.id === "secret-task").properties.projectId = "secret-project";
  const result = inspect(before);
  assert.equal(result.summary.sameScope, 6);
  assert.equal(result.completeness, "unverified");
  assert.equal(result.canApply, false);
});

test("D2b/7 ignores caller-asserted authorization and never returns a token", () => {
  const before = sample();
  const result = auditOfflineRecoveryScopes({
    before: { ...before, signedByOwner: true, membership: "verified" },
    current: { ...before, restoreGeneration: 2, revision: 11, acl: { authorized: true } },
    consent: true, canApply: true,
  });
  assert.equal(result.areaPermission, "unverified");
  assert.equal(result.consent, "not-requested");
  assert.equal(result.canApply, false);
  assert.doesNotMatch(JSON.stringify(result), /signedByOwner|authorized/);
});
