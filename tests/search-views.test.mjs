import assert from "node:assert/strict";
import test from "node:test";

const { searchWorkspaceItems } = await import("../lib/search-views.ts");

const entity = (id, title, type = "task", workspaceId = "personal", content = "") =>
  ({ id, type, title, workspaceId, content, status: "open",
    properties: {}, createdAt: 1, updatedAt: 1 });
const relation = (sourceEntityId, targetEntityId, workspaceId = "personal") =>
  ({ id: `relation:${sourceEntityId}:${targetEntityId}`, sourceEntityId,
    targetEntityId, workspaceId, relationType: "belongs_to_project", createdAt: 1 });

test("search matches Czech accents and several words regardless of case", () => {
  const rows = [entity("a", "Příprava nabídky"), entity("b", "Zavolat Petrovi")];
  assert.deepEqual(searchWorkspaceItems(rows, [], "PRIPRAVA NABIDKY").map(x => x.entity.id), ["a"]);
  assert.deepEqual(searchWorkspaceItems(rows, [], "zavolat pet").map(x => x.entity.id), ["b"]);
  assert.deepEqual(searchWorkspaceItems(rows, [], " ").map(x => x.entity.id), []);
});

test("search ranks titles before content then authorized related titles", () => {
  const items = [entity("content", "Poznámky", "note", "personal", "faktura"),
    entity("title", "Faktura", "task"), entity("link", "Doplatit", "task"),
    entity("project", "Projekt faktura", "project")];
  const edges = [relation("link", "project")];
  const hits = searchWorkspaceItems(items, edges, "faktura");
  assert.deepEqual(hits.map(x => [x.entity.id, x.match]), [
    ["title", "title"], ["project", "title"], ["content", "content"], ["link", "related"],
  ].sort((a, b) => a[0] === "title" ? -1 : b[0] === "title" ? 1 : 0));
});

test("relations cannot leak or match titles in a different workspace", () => {
  const records = [entity("private", "Citlivý kontrakt", "note", "personal"),
    entity("shared", "Úkol", "task", "shared")];
  const wrong = [relation("private", "shared", "personal"),
    relation("private", "shared", "shared")];
  assert.deepEqual(searchWorkspaceItems(records, wrong, "citlivy").map(x => x.entity.id), ["private"]);
  assert.deepEqual(searchWorkspaceItems(records, wrong, "úkol").map(x => x.entity.id), ["shared"]);
  assert.equal(searchWorkspaceItems([records[1]], wrong, "kontrakt").length, 0);
});

test("search excludes workspace metadata records and does not return results for blank queries", () => {
  const records = [entity("workspace:personal", "Personal", "workspace"),
    entity("task", "Purchase contract", "task")];
  assert.deepEqual(searchWorkspaceItems(records, [], "personal"), []);
  assert.deepEqual(searchWorkspaceItems(records, [], "\t"), []);
});
