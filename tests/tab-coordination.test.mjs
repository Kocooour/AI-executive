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

test("a record changed within the same millisecond is still seen as changed", () => {
  const known = { entities: [task("t1", 5)], relations: [] };
  assert.equal(hasChangesBeyond([{ ...task("t1", 5), title: "jiný název" }], [], known), true);
  assert.equal(hasChangesBeyond([{ ...task("t1", 5), status: "completed" }], [], known), true);
});

test("local write times are strictly increasing", async () => {
  const { writeTime } = await import("../lib/clock.ts");
  const times = Array.from({ length: 50 }, () => writeTime());
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]));
  assert.ok(times.every((time) => Number.isSafeInteger(time)));
});

test("a change of a property written by another tab in the same millisecond counts", () => {
  const base = { id: "t", type: "task", title: "T", status: "open", workspaceId: "personal", properties: { priority: "low" }, createdAt: 1, updatedAt: 1000 };
  const otherTab = { ...base, properties: { priority: "high" } };
  assert.equal(hasChangesBeyond([otherTab], [], { entities: [base], relations: [] }), true);
  // Same content with keys in another order (or an undefined value) is not a change.
  const reordered = { updatedAt: 1000, createdAt: 1, properties: { priority: "low", gone: undefined }, workspaceId: "personal", status: "open", title: "T", type: "task", id: "t" };
  assert.equal(hasChangesBeyond([reordered], [], { entities: [base], relations: [] }), false);
});
