import assert from "node:assert/strict";
import test from "node:test";

const { openTaskCountsByProject } = await import("../app/ui/open-task-counts.ts");

const entity = (id, type, workspaceId, status = "active") => ({
  id, type, workspaceId, status, title: id, properties: {}, createdAt: 1, updatedAt: 1,
});
const relation = (id, sourceEntityId, targetEntityId, workspaceId = "personal", relationType = "belongs_to_project") => ({
  id, sourceEntityId, targetEntityId, workspaceId, relationType, createdAt: 1,
});

test("open project counts scan each relation once and retain the current workspace boundary", () => {
  const projects = [entity("p1", "project", "personal"), entity("p2", "project", "work")];
  const items = [
    entity("t1", "task", "personal", "open"),
    entity("t2", "task", "personal", "completed"),
    entity("t3", "task", "work", "open"),
  ];
  const relations = [
    relation("r1", "t1", "p1"),
    relation("r2", "t2", "p1"),
    relation("r3", "t3", "p2", "work"),
    relation("r4", "t1", "p2"),
    relation("r5", "t1", "p1", "personal", "belongs_to_area"),
    relation("r6", "missing", "p1"),
  ];

  assert.deepEqual([...openTaskCountsByProject(items, projects, relations)], [["p1", 1], ["p2", 1]]);
});
