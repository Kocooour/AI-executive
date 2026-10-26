import assert from "node:assert/strict";
import test from "node:test";
import { checkLegacyOwnerAssigneeBackfill, LegacyAssigneePostcheckBlocked } from "../lib/legacy-assignee-postcheck.ts";

const workspace = (id, members = [{ id: "owner", role: "owner" }], kind = "shared") => ({
  id: "workspace:" + id, type: "workspace", workspaceId: id, status: "active",
  title: "SECRET-WORKSPACE", properties: { kind, role: "owner", members },
  createdAt: 1, updatedAt: 2,
});
const task = (id, workspaceId, status = "open", properties = {}) => ({
  id, type: "task", title: "SECRET-" + id, workspaceId, status,
  properties: {
    deadline: "2026-11-07", today: true, when: "2026-11-03",
    inbox: true, priority: 3, manualOrder: 11, ...properties,
  },
  createdAt: 1, updatedAt: 2,
});
const before = () => ({
  revision: 25, restoreGeneration: 4,
  entities: [
    workspace("legacy-shared"), workspace("personal", [{ id: "owner", role: "owner" }], "personal"),
    workspace("other", [{ id: "owner", role: "owner" }, { id: "partner", role: "editor" }]),
    task("z-open", "legacy-shared"),
    task("a-open", "legacy-shared", "open", { assigneeUserId: null }),
    task("owned", "legacy-shared", "open", { assigneeUserId: "owner" }),
    task("completed", "legacy-shared", "completed"),
    task("private", "personal"),
    task("partner-task", "other"),
  ],
});
const after = (original = before()) => {
  const state = structuredClone(original);
  state.revision += 1;
  for (const e of state.entities) {
    if (["z-open", "a-open"].includes(e.id)) {
      e.properties.assigneeUserId = "owner";
      e.updatedAt += 1;
    }
  }
  return state;
};
const audit = (old = before(), current = after(old), ids = ["legacy-shared"]) =>
  checkLegacyOwnerAssigneeBackfill({ before: old, after: current, legacySharedWorkspaceIds: ids });

test("2c/2 verifies only owner assignments without touching either snapshot", () => {
  const old = before();
  const current = after(old);
  const savedOld = structuredClone(old);
  const savedCurrent = structuredClone(current);
  const report = audit(old, current);
  assert.deepEqual(report, {
    phase: "legacy-assignee-postcheck-only",
    sourceRevision: 25, resultRevision: 26, restoreGeneration: 4,
    checkedEntityCount: 9, assignedTaskCount: 2,
    verifiedPersistedState: false, canApply: false,
    canActivateMyPlan: false, canEnableSharing: false,
  });
  assert.ok(Object.isFrozen(report));
  assert.deepEqual(old, savedOld);
  assert.deepEqual(current, savedCurrent);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|deadline|today|when|priority|private|z-open|a-open/);
});

test("2c/2 verifies order-independent entity identity and null/absent assignees", () => {
  const old = before(), current = after(old);
  old.entities.reverse();
  current.entities.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(audit(old, current), audit());
});

test("2c/2 allows a no-op when no candidate remains and revision does not change", () => {
  const old = after(before());
  const current = structuredClone(old);
  assert.equal(audit(old, current).assignedTaskCount, 0);
  current.revision += 1;
  assert.throws(() => audit(old, current), LegacyAssigneePostcheckBlocked);
});

test("2c/2 rejects incomplete or forged assignments", () => {
  for (const value of [undefined, null, "partner", "", 42]) {
    const old = before(), current = after(old);
    if (value === undefined) delete current.entities.find(e => e.id === "a-open").properties.assigneeUserId;
    else current.entities.find(e => e.id === "a-open").properties.assigneeUserId = value;
    assert.throws(() => audit(old, current), LegacyAssigneePostcheckBlocked);
  }
  const old = before(), current = after(old);
  current.entities.find(e => e.id === "owned").properties.assigneeUserId = "partner";
  assert.throws(() => audit(old, current), LegacyAssigneePostcheckBlocked);
});

test("2c/2 rejects changed task placement, metadata, status, timestamps, workspace and identity", () => {
  for (const mutate of [
    e => { e.properties.deadline = "2026-11-08"; },
    e => { e.properties.today = false; },
    e => { e.properties.when = null; },
    e => { e.properties.inbox = false; },
    e => { e.properties.priority = 5; },
    e => { e.properties.manualOrder = 12; },
    e => { e.properties.areaId = "shared-outside"; },
    e => { e.status = "completed"; },
    e => { e.title = "modified"; },
    e => { e.workspaceId = "other"; },
    e => { e.id = "renamed"; },
    e => { e.createdAt = 19; },
    e => { e.updatedAt = 1; },
    e => { e.properties.extra = "unexpected"; },
  ]) {
    const old = before(), current = after(old);
    mutate(current.entities.find(e => e.id === "z-open"));
    assert.throws(() => audit(old, current), LegacyAssigneePostcheckBlocked);
  }
});

test("2c/2 rejects changes to noncandidates, workspace membership or existing owner assignments", () => {
  for (const id of ["owned", "completed", "private", "partner-task", "workspace:legacy-shared"]) {
    const old = before(), current = after(old);
    current.entities.find(e => e.id === id).updatedAt += 1;
    assert.throws(() => audit(old, current), LegacyAssigneePostcheckBlocked);
  }
  const old = before(), current = after(old);
  current.entities[0].properties.members.push({ id: "partner", role: "editor" });
  assert.throws(() => audit(old, current), LegacyAssigneePostcheckBlocked);
});

test("2c/2 rejects additions, deletions, duplicate IDs and unexpected ID reuse", () => {
  const old = before();
  const missing = after(old); missing.entities.pop();
  assert.throws(() => audit(old, missing), LegacyAssigneePostcheckBlocked);
  const extra = after(old); extra.entities.push(task("extra", "personal"));
  assert.throws(() => audit(old, extra), LegacyAssigneePostcheckBlocked);
  const duplicate = after(old); duplicate.entities[8].id = "owned";
  assert.throws(() => audit(old, duplicate), LegacyAssigneePostcheckBlocked);
  const reused = after(old); reused.entities[7] = { ...reused.entities[7], type: "project" };
  assert.throws(() => audit(old, reused), LegacyAssigneePostcheckBlocked);
});

test("2c/2 rejects stale/mismatched generation and revisions, including overflow", () => {
  const old = before();
  const badRevision = after(old); badRevision.revision += 1;
  assert.throws(() => audit(old, badRevision), LegacyAssigneePostcheckBlocked);
  const backwards = after(old); backwards.revision = old.revision;
  assert.throws(() => audit(old, backwards), LegacyAssigneePostcheckBlocked);
  const otherGeneration = after(old); otherGeneration.restoreGeneration += 1;
  assert.throws(() => audit(old, otherGeneration), LegacyAssigneePostcheckBlocked);
  const overflow = before();
  overflow.revision = Number.MAX_SAFE_INTEGER;
  const overflowAfter = after(overflow);
  assert.throws(() => audit(overflow, overflowAfter), LegacyAssigneePostcheckBlocked);
  const invalid = after(old); invalid.revision = Number.NaN;
  assert.throws(() => audit(old, invalid), LegacyAssigneePostcheckBlocked);
});

test("2c/2 remains strictly diagnostic and refuses unauthenticated/multi-user selection", () => {
  const old = before(), current = after(old);
  for (const ids of [[], ["unknown"], ["personal"], ["other"], ["legacy-shared", "other"], ["legacy-shared", "legacy-shared"]]) {
    assert.throws(() => audit(old, current, ids), LegacyAssigneePostcheckBlocked);
  }
  const changed = before();
  changed.entities[0].properties.members = [{ id: "partner", role: "owner" }];
  assert.throws(() => audit(changed, after(changed)), LegacyAssigneePostcheckBlocked);
});
