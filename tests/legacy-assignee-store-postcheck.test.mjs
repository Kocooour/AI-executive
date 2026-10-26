import assert from "node:assert/strict";
import test from "node:test";
import {
  checkLegacyAssigneeStorePreservation,
  LegacyAssigneeStorePostcheckBlocked,
} from "../lib/legacy-assignee-store-postcheck.ts";

const workspace = (id, kind = "shared") => ({
  id: "workspace:" + id, type: "workspace", title: "PRIVATE-" + id,
  status: "active", workspaceId: id,
  properties: { kind, role: "owner", members: [{ id: "owner", role: "owner" }] },
  createdAt: 1, updatedAt: 2,
});
const entity = (id, type = "task", workspaceId = "legacy", status = "open", properties = {}) => ({
  id, type, workspaceId, title: "PRIVATE-" + id,
  status, properties: { ...properties }, createdAt: 1, updatedAt: 2,
});
const relation = (id, source, target, kind = "belongs_to_project") => ({
  id, sourceEntityId: source, targetEntityId: target, relationType: kind,
  workspaceId: "legacy", createdAt: 3,
});
const before = () => ({
  revision: 10, restoreGeneration: 8,
  entities: [
    workspace("legacy"),
    workspace("personal", "personal"),
    entity("a-open", "task", "legacy", "open", { today: true, inbox: true }),
    entity("b-owned", "task", "legacy", "open", { assigneeUserId: "owner" }),
    entity("completed", "task", "legacy", "completed"),
    entity("private-task", "task", "personal"),
    entity("project", "project", "legacy", "active"),
    entity("note", "note", "legacy", "active"),
  ],
  relations: [
    relation("r-task", "a-open", "project"),
    relation("r-note", "note", "project"),
  ],
  tombstones: [{ id: "previously-deleted", deletedAt: 12 }],
});
const after = (original = before()) => {
  const current = structuredClone(original);
  current.revision += 1;
  current.entities.find(e => e.id === "a-open").properties.assigneeUserId = "owner";
  current.entities.find(e => e.id === "a-open").updatedAt += 1;
  return current;
};
const audit = (old = before(), current = after(old)) =>
  checkLegacyAssigneeStorePreservation({
    before: old, after: current, legacySharedWorkspaceIds: ["legacy"],
  });
const rejected = (old, current) =>
  assert.throws(() => audit(old, current), LegacyAssigneeStorePostcheckBlocked);

test("2c/3 accepts strictly preserved relation/tombstone graphs without mutating inputs", () => {
  const old = before(), current = after(old);
  const savedOld = structuredClone(old), savedCurrent = structuredClone(current);
  const report = audit(old, current);
  assert.deepEqual(report, {
    phase: "legacy-assignee-store-postcheck-only",
    sourceRevision: 10, resultRevision: 11, restoreGeneration: 8,
    checkedEntityCount: 8, assignedTaskCount: 1,
    checkedRelationCount: 2, checkedTombstoneCount: 1,
    verifiedPersistedState: false, verifiedSideTables: false,
    verifiedHomeTodayInbox: false, canApply: false, canReleaseHold: false,
    canActivateMyPlan: false, canEnableSharing: false,
  });
  assert.ok(Object.isFrozen(report));
  assert.deepEqual(old, savedOld);
  assert.deepEqual(current, savedCurrent);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|a-open|r-task|previously-deleted|assigneeUserId|today|inbox/);
});

test("2c/3 does not care about array order or object property key order", () => {
  const old = before(), current = after(old);
  old.entities.reverse();
  current.entities.reverse();
  old.relations.reverse();
  current.tombstones.reverse();
  current.relations = current.relations.map(({ id, ...rest }) => ({ ...rest, id }));
  assert.deepEqual(audit(old, current), audit());
});

test("2c/3 accepts a no-op with unchanged revision and complete store", () => {
  const old = after(before()), current = structuredClone(old);
  const report = audit(old, current);
  assert.equal(report.assignedTaskCount, 0);
  assert.equal(report.sourceRevision, report.resultRevision);
  current.revision += 1;
  rejected(old, current);
});

test("2c/3 rejects every relation identity, endpoint, scope, timestamp and content drift", () => {
  for (const mutate of [
    r => { r.id = "replacement"; },
    r => { r.sourceEntityId = "b-owned"; },
    r => { r.targetEntityId = "a-open"; },
    r => { r.relationType = "unrelated"; },
    r => { r.workspaceId = "personal"; },
    r => { r.createdAt += 1; },
    r => { r.metadata = { private: true }; },
  ]) {
    const old = before(), current = after(old);
    mutate(current.relations[0]);
    rejected(old, current);
  }
  const old = before();
  const extra = after(old);
  extra.relations.push(relation("new-link", "b-owned", "project"));
  rejected(old, extra);
  const missing = after(old);
  missing.relations.pop();
  rejected(old, missing);
  const duplicate = after(old);
  duplicate.relations[1].id = "r-task";
  rejected(old, duplicate);
});

test("2c/3 rejects every tombstone identity, timestamp, addition and removal", () => {
  for (const mutate of [
    t => { t.id = "different-id"; },
    t => { t.deletedAt = 13; },
    t => { t.extra = "changed"; },
  ]) {
    const old = before(), current = after(old);
    mutate(current.tombstones[0]);
    rejected(old, current);
  }
  const old = before();
  const added = after(old);
  added.tombstones.push({ id: "another-delete", deletedAt: 10 });
  rejected(old, added);
  const removed = after(old);
  removed.tombstones = [];
  rejected(old, removed);
  const duplicate = after(old);
  duplicate.tombstones.push({ ...duplicate.tombstones[0] });
  rejected(old, duplicate);
});

test("2c/3 rejects incomplete collections or malformed canonical graphs", () => {
  for (const kind of ["relations", "tombstones"]) {
    const old = before(), current = after(old);
    delete current[kind];
    rejected(old, current);
  }
  const old = before();
  const missingTarget = after(old);
  missingTarget.relations[0].targetEntityId = "nonexistent";
  rejected(old, missingTarget);
  const overlapping = after(old);
  overlapping.tombstones[0].id = "project";
  rejected(old, overlapping);
  const idCollision = after(old);
  idCollision.relations[0].id = "note";
  rejected(old, idCollision);
  const crossWorkspace = after(old);
  crossWorkspace.relations[0].targetEntityId = "private-task";
  rejected(old, crossWorkspace);
  const malformedBefore = before();
  malformedBefore.relations[0].targetEntityId = "nonexistent";
  rejected(malformedBefore, after(malformedBefore));
});

test("2c/3 rejects non-JSON relation and tombstone fields even with matching values", () => {
  for (const mutate of [
    r => { r.extra = new Date("2026-10-26"); },
    r => { r.extra = NaN; },
    r => { r.extra = [, 1]; },
    r => { r.extra = undefined; },
    r => { r.extra = new Map(); },
    r => { r.extra = {}; r.extra.itself = r.extra; },
  ]) {
    const old = before(), current = after(old);
    mutate(current.relations[0]);
    rejected(old, current);
  }
  const old = before(), current = after(old);
  current.tombstones[0].deletedAt = Infinity;
  rejected(old, current);
});

test("2c/3 delegates entity-assignee and revision safety to 2c/2", () => {
  const old = before();
  const wrongAssignee = after(old);
  wrongAssignee.entities.find(e => e.id === "a-open").properties.assigneeUserId = "partner";
  rejected(old, wrongAssignee);
  const extraChange = after(old);
  extraChange.entities.find(e => e.id === "a-open").properties.inbox = false;
  rejected(old, extraChange);
  const changedGeneration = after(old);
  changedGeneration.restoreGeneration += 1;
  rejected(old, changedGeneration);
  const changedRevision = after(old);
  changedRevision.revision += 2;
  rejected(old, changedRevision);
});
