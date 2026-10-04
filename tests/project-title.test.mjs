import assert from "node:assert/strict";
import test from "node:test";

const { findActiveProjectWithTitle, normalizeProjectTitle } = await import("../lib/project-title.ts");

const entity = (overrides = {}) => ({
  id: "project:1", type: "project", title: "Rekonstrukce koupelny", status: "active",
  workspaceId: "personal", properties: {}, createdAt: 1, updatedAt: 1, ...overrides,
});

test("project title normalization is case, accent and punctuation insensitive", () => {
  assert.equal(normalizeProjectTitle("  REKONSTRUKCE – Koupelny! "), "rekonstrukce koupelny");
});

test("duplicate detection is limited to active projects in the same workspace", () => {
  const entities = [
    entity(),
    entity({ id: "project:archived", title: "Jiný projekt", status: "archived" }),
    entity({ id: "project:other", title: "Jiný projekt", workspaceId: "work" }),
  ];
  assert.equal(findActiveProjectWithTitle(entities, "personal", "rekonstrukce koupelny")?.id, "project:1");
  assert.equal(findActiveProjectWithTitle(entities, "personal", "Jiný projekt"), null);
  assert.equal(findActiveProjectWithTitle(entities, "work", "Jiný projekt")?.id, "project:other");
});
