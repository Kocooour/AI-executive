import assert from "node:assert/strict";
import test from "node:test";
const { describeAttentionSources } = await import("../lib/attention-sources.ts");

const entity = (id, type, title, workspaceId = "personal") => ({ id, type, title, status: "open", workspaceId, properties: {}, createdAt: 1, updatedAt: 1 });
const relation = (id, workspaceId = "personal") => ({ id, workspaceId, sourceEntityId: "t1", targetEntityId: "p1", relationType: "belongs_to_project", createdAt: 1 });

test("a project item lists its records by name, counts claims and leaves out the links to its tasks", () => {
  const items = [entity("p1", "project", "Web"), entity("t1", "task", "Texty"), entity("x1", "task", "Cizí", "work")];
  const result = describeAttentionSources(["p1", "t1", "r1", "claim:c1", "claim:c2", "p1"], "personal", items, [relation("r1")]);
  assert.deepEqual(result.records.map((record) => record.title), ["Web", "Texty"]);
  assert.equal(result.claims, 2);
  assert.equal(result.missing, 0);
});

test("a record or link of another workspace is never named and counts as missing", () => {
  const items = [entity("x1", "task", "Cizí", "work")];
  const result = describeAttentionSources(["x1", "r9"], "personal", items, [relation("r9", "work")]);
  assert.deepEqual(result.records, []);
  assert.equal(result.missing, 2);
});
