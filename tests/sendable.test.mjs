import assert from "node:assert/strict";
import test from "node:test";

const { isSendable, forServer, unsentIds } = await import("../lib/sendable.ts");

const task = (id, overrides = {}) => ({ id, type: "task", title: id, status: "open", workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1, ...overrides });
const relation = (source, target, id = `${source}-${target}`) => ({ id, workspaceId: "personal", sourceEntityId: source, targetEntityId: target, relationType: "belongs_to_project", createdAt: 1 });

test("a record the server would refuse is recognised", () => {
  assert.equal(isSendable(task("a")), true);
  assert.equal(isSendable(task("a", { title: "" })), false);
  assert.equal(isSendable(task("a", { title: "x".repeat(1001) })), false);
  assert.equal(isSendable(task("a", { content: "x".repeat(100_001) })), false);
  assert.equal(isSendable(task("a", { properties: { notes: "x".repeat(250_001) } })), false);
});

test("a refused record is held back; one the server knows is sent as it knows it", () => {
  const entities = [task("p"), task("new", { title: "" }), task("known", { title: "", updatedAt: 5 }), task("ok")];
  const relations = [relation("new", "p"), relation("known", "p"), relation("ok", "p")];
  const base = { entities: [task("p"), task("known", { title: "Starý název" }), task("ok")] };
  const result = forServer(entities, relations, base);
  assert.deepEqual(result.heldBack.map((entity) => entity.id), ["new", "known"]);
  assert.deepEqual(result.entities.map((entity) => [entity.id, entity.title]), [["p", "p"], ["known", "Starý název"], ["ok", "ok"]]);
  assert.deepEqual(result.relations.map((item) => item.id), ["known-p", "ok-p"]);
});

test("nothing is held back when every record can be sent", () => {
  const entities = [task("a")], relations = [];
  const result = forServer(entities, relations, null);
  assert.equal(result.entities, entities);
  assert.deepEqual(result.heldBack, []);
});

test("records not on the server as they are here are unsent", () => {
  const base = { entities: [task("a"), task("b")] };
  assert.deepEqual([...unsentIds([task("a"), task("b", { updatedAt: 2 }), task("c")], base)], ["b", "c"]);
  assert.deepEqual([...unsentIds([task("a")], null)], []);
});
