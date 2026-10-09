import assert from "node:assert/strict";
import test from "node:test";

const { hasChangesBeyond } = await import("../lib/tab-coordination.ts");

const task = (id, updatedAt = 1) => ({ id, type: "task", title: id, status: "open", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt });
const relation = (id, target = "p1") => ({ id, workspaceId: "personal", sourceEntityId: "t1", targetEntityId: target, relationType: "belongs_to_project", createdAt: 1 });

test("the local copy equal to what the server has holds no unsent change", () => {
  assert.equal(hasChangesBeyond([task("t1"), task("t2")], [relation("r1")], { entities: [task("t2"), task("t1")], relations: [relation("r1")] }), false);
});

test("a record added, changed or removed locally is an unsent change", () => {
  const known = { entities: [task("t1")], relations: [] };
  assert.equal(hasChangesBeyond([task("t1"), task("t2")], [], known), true);
  assert.equal(hasChangesBeyond([task("t1", 2)], [], known), true);
  assert.equal(hasChangesBeyond([], [], known), true);
});

test("a relation added, moved or removed locally is an unsent change", () => {
  const known = { entities: [task("t1")], relations: [relation("r1")] };
  assert.equal(hasChangesBeyond([task("t1")], [relation("r1"), relation("r2")], known), true);
  assert.equal(hasChangesBeyond([task("t1")], [relation("r1", "p2")], known), true);
  assert.equal(hasChangesBeyond([task("t1")], [], known), true);
});
