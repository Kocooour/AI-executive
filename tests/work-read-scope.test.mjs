import assert from "node:assert/strict";
import test from "node:test";

const { selectScopedWork } = await import("../lib/work-read-scope.ts");

const entity = (id, type, workspaceId, options = {}) => ({
  id, type, workspaceId, title: id, status: type === "project" ? "active" : "open",
  properties: {}, createdAt: 10, updatedAt: 20, ...options,
});
const link = (id, task, project, workspaceId) => ({
  id, sourceEntityId: task, targetEntityId: project,
  relationType: "belongs_to_project", workspaceId, createdAt: 10,
});
const fixture = () => {
  const privateTask = entity("private", "task", "personal");
  const mySharedTask = entity("mine", "task", "area:a", { properties: { assigneeUserId: "owner" } });
  const myOtherSharedTask = entity("mine-b", "task", "area:b", { properties: { assigneeUserId: "owner" } });
  const otherTask = entity("other", "task", "area:a", { properties: { assigneeUserId: "partner" } });
  const unassigned = entity("unassigned", "task", "area:a");
  const completed = entity("done", "task", "area:b", {
    status: "completed", properties: { assigneeUserId: "owner" },
  });
  const unauthorized = entity("invisible", "task", "area:secret", {
    properties: { assigneeUserId: "owner" },
  });
  const privateProject = entity("private-project", "project", "personal");
  const mineProject = entity("mine-project", "project", "area:a");
  const otherProject = entity("other-project", "project", "area:a");
  const secondMineProject = entity("second-mine-project", "project", "area:b");
  const doneProject = entity("done-project", "project", "area:b");
  const invisibleProject = entity("invisible-project", "project", "area:secret");
  return {
    scope: "my-plan", actorUserId: "owner",
    personalWorkspaceId: "personal",
    authorizedSharedWorkspaceIds: ["area:a", "area:b"],
    entities: [
      privateTask, mySharedTask, myOtherSharedTask, otherTask, unassigned,
      completed, unauthorized, privateProject, mineProject, otherProject,
      secondMineProject, doneProject, invisibleProject,
    ],
    relations: [
      link("r1", "mine", "mine-project", "area:a"),
      link("r2", "other", "other-project", "area:a"),
      link("r3", "mine-b", "second-mine-project", "area:b"),
      link("r4", "done", "done-project", "area:b"),
      link("r5", "invisible", "invisible-project", "area:secret"),
    ],
  };
};
const ids = (items) => items.map((item) => item.id).sort();

test("My Plan includes private tasks and only shared tasks explicitly assigned to actor", () => {
  const data = fixture();
  const result = selectScopedWork(data);
  assert.deepEqual(ids(result.tasks), ["done", "mine", "mine-b", "private"]);
  assert.deepEqual(ids(result.projects), ["mine-project", "private-project", "second-mine-project"]);
  // The function does not silently assign unassigned legacy shared tasks.
  assert.equal(result.tasks.some((item) => item.id === "unassigned"), false);
});

test("Personal and Shared are separate read scopes and shared includes unassigned work", () => {
  const data = fixture();
  const personal = selectScopedWork({ ...data, scope: "personal" });
  const shared = selectScopedWork({ ...data, scope: "shared" });
  assert.deepEqual(ids(personal.tasks), ["private"]);
  assert.deepEqual(ids(personal.projects), ["private-project"]);
  assert.deepEqual(ids(shared.tasks), ["done", "mine", "mine-b", "other", "unassigned"]);
  assert.deepEqual(ids(shared.projects), [
    "done-project", "mine-project", "other-project", "second-mine-project",
  ]);
});

test("read scope is never a write target and never mutates a canonical task", () => {
  const data = fixture();
  const task = data.entities[1];
  const before = structuredClone(data);
  const myPlan = selectScopedWork(data);
  const shared = selectScopedWork({ ...data, scope: "shared" });
  assert.strictEqual(myPlan.tasks.find((item) => item.id === "mine"), task);
  assert.strictEqual(shared.tasks.find((item) => item.id === "mine"), task);
  assert.deepEqual(data, before);
});

test("unauthorized workspaces are not shown even if a task names the actor", () => {
  const data = fixture();
  const result = selectScopedWork({ ...data, authorizedSharedWorkspaceIds: ["area:a"] });
  assert.deepEqual(ids(result.tasks), ["mine", "private"]);
  assert.deepEqual(ids(result.projects), ["mine-project", "private-project"]);
});

test("foreign and fabricated project relations never make a shared project appear", () => {
  const data = fixture();
  const result = selectScopedWork({
    ...data,
    relations: [
      link("forged-ws", "mine", "other-project", "area:b"),
      link("forged-private", "private", "other-project", "area:a"),
      link("forged-other-area", "mine", "second-mine-project", "area:a"),
      link("correct", "mine", "mine-project", "area:a"),
    ],
  });
  assert.deepEqual(ids(result.projects), ["mine-project", "private-project"]);
});

test("completed shared task remains readable but alone does not qualify its project", () => {
  const data = fixture();
  const result = selectScopedWork({ ...data,
    entities: data.entities.filter((item) => item.id !== "mine-b"),
  });
  assert.ok(result.tasks.find((task) => task.id === "done" && task.status === "completed"));
  assert.equal(result.projects.some((project) => project.id === "done-project"), false);
});

test("shared project details must not use the My Plan task subset", () => {
  const data = fixture();
  const summary = selectScopedWork(data);
  const authorizedShared = selectScopedWork({ ...data, scope: "shared" });
  assert.ok(summary.projects.some((item) => item.id === "mine-project"));
  assert.ok(authorizedShared.tasks.some((item) => item.id === "other"));
  assert.equal(summary.tasks.some((item) => item.id === "other"), false);
});

test("deduplicates identical canonical IDs and fails closed on conflicting revisions/workspaces", () => {
  const data = fixture();
  const task = data.entities[1];
  const repeated = selectScopedWork({ ...data, entities: [...data.entities, task, structuredClone(task)] });
  assert.equal(repeated.tasks.filter((item) => item.id === task.id).length, 1);
  assert.throws(() => selectScopedWork({
    ...data,
    entities: [...data.entities, { ...task, workspaceId: "area:b" }],
  }), /Conflicting canonical entity ID/);
  assert.throws(() => selectScopedWork({
    ...data,
    entities: [...data.entities, { ...task, updatedAt: task.updatedAt + 1 }],
  }), /Conflicting canonical entity ID/);
});

test("rejects ambiguous, missing or invalid access scope inputs", () => {
  const data = fixture();
  assert.throws(() => selectScopedWork({ ...data, scope: "all" }), /Unsupported/);
  assert.throws(() => selectScopedWork({ ...data, actorUserId: "" }), /requires an actor/);
  assert.throws(() => selectScopedWork({ ...data, personalWorkspaceId: "all" }), /requires an actor/);
  assert.throws(() => selectScopedWork({
    ...data, authorizedSharedWorkspaceIds: ["area:a", "personal"],
  }), /must not overlap/);
});

test("My Plan treats assigneeUserId as an exact identity, never an author/owner fallback", () => {
  const data = fixture();
  const result = selectScopedWork({
    ...data,
    entities: [...data.entities, entity("author-only", "task", "area:a", {
      properties: { createdByUserId: "owner", ownerUserId: "owner" },
    })],
  });
  assert.equal(result.tasks.some((task) => task.id === "author-only"), false);
});
