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
  const base = { entities: [task("p"), task("known", { title: "Starý název" }), task("ok")], relations: [relation("known", "p")] };
  const result = forServer(entities, relations, base);
  assert.deepEqual(result.heldBack.map((entity) => entity.id), ["new", "known"]);
  assert.deepEqual(result.entities.map((entity) => [entity.id, entity.title]), [["p", "p"], ["known", "Starý název"], ["ok", "ok"]]);
  assert.deepEqual(result.relations.map((item) => item.id).sort(), ["known-p", "ok-p"]);
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

const workspace = (workspaceId, overrides = {}) => ({ id: `workspace:${workspaceId}`, type: "workspace", title: workspaceId, status: "active", workspaceId, properties: { kind: "shared", role: "owner", members: [] }, createdAt: 1, updatedAt: 1, ...overrides });

test("records of a workspace that cannot be sent are held back with it", () => {
  const entities = [workspace("w", { title: "x".repeat(121) }), task("in-w", { workspaceId: "w" }), task("personal-task"), task("odd", { type: "widget" })];
  const result = forServer(entities, [], null);
  assert.deepEqual(result.heldBack.map((entity) => entity.id), ["workspace:w", "in-w", "odd"]);
  assert.deepEqual(Object.fromEntries(result.reasons), { "workspace:w": "longTitle", "in-w": "workspace", odd: "invalid" });
  assert.deepEqual(result.entities.map((entity) => entity.id), ["personal-task"]);
});

test("a held record the server knows is sent with the relations the server knows", () => {
  const entities = [task("p1"), task("p2"), task("t", { title: "" })];
  const relations = [relation("t", "p2", "new-link")];
  const base = { entities: [task("p1"), task("p2"), task("t")], relations: [relation("t", "p1", "old-link")] };
  const result = forServer(entities, relations, base);
  assert.deepEqual(result.relations.map((item) => item.id), ["old-link"]);
});

test("notes that are too long are named as the reason", () => {
  const result = forServer([task("n", { properties: { notes: "x".repeat(250_001) } })], [], null);
  assert.equal(result.reasons.get("n"), "longNotes");
});

test("records of a held workspace the server knows are still sent", () => {
  const entities = [workspace("team", { title: "x".repeat(130) }), task("t1", { workspaceId: "team" }), task("t2", { workspaceId: "team" })];
  const relations = [{ ...relation("t1", "t2", "team-link"), workspaceId: "team" }];
  const base = { entities: [workspace("team"), task("t1", { workspaceId: "team" }), task("t2", { workspaceId: "team" })], relations };
  const result = forServer(entities, relations, base);
  assert.deepEqual(result.heldBack.map((entity) => entity.id), ["workspace:team"]);
  assert.deepEqual(result.entities.map((entity) => [entity.id, entity.title]), [["workspace:team", "team"], ["t1", "t1"], ["t2", "t2"]]);
  assert.deepEqual(result.relations.map((item) => item.id), ["team-link"]);
});

test("a relation across workspaces is not sent", () => {
  const entities = [workspace("w"), task("a"), task("b", { workspaceId: "w" })];
  const result = forServer(entities, [relation("a", "b", "cross")], null);
  assert.deepEqual(result.relations, []);
});
