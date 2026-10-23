import assert from "node:assert/strict";
import test from "node:test";

const { planAreaNormalization, AreaNormalizationBlocked } =
  await import("../lib/area-normalization.ts");

const entity = (id, type, workspaceId, properties = {}, title = id) => ({
  id, type, title, workspaceId, properties,
  status: type === "task" ? "open" : "active",
  createdAt: 10, updatedAt: 20,
});
const workspace = (id, kind) => entity("workspace:" + id, "workspace", id, {
  kind, role: "owner", members: [{ id: "owner", role: "owner" }],
});
const relation = (id, source, target, type, workspaceId) => ({
  id, sourceEntityId: source, targetEntityId: target, relationType: type,
  workspaceId, createdAt: 15,
});
const link = (id, source, target, scope = "personal") =>
  relation(id, source, target, "belongs_to_area", scope);
const projectLink = (id, source, target, scope = "personal") =>
  relation(id, source, target, "belongs_to_project", scope);
const areaFor = (snapshot, entityId) => snapshot.relations
  .filter((r) => r.sourceEntityId === entityId && r.relationType === "belongs_to_area");
const expectsBlocked = (fn, reason) =>
  assert.throws(fn, (error) => error instanceof AreaNormalizationBlocked
    && error.issues.some((issue) => issue.startsWith(reason)));

test("2a adds a single private Nezařazeno for missing project and standalone task", () => {
  const project = entity("p", "project", "personal");
  const task = entity("t", "task", "personal");
  const before = { entities: [workspace("personal", "personal"), project, task], relations: [] };
  const original = structuredClone(before);
  const result = planAreaNormalization(before, 100);
  assert.equal(result.report.createdAreaIds.length, 1);
  const area = result.entities.find((e) => e.type === "area");
  assert.equal(area.title, "Nezařazeno");
  assert.equal(area.workspaceId, "personal");
  assert.equal(area.properties.kind, "personal");
  assert.equal(areaFor(result, "p")[0].targetEntityId, area.id);
  assert.equal(areaFor(result, "t")[0].targetEntityId, area.id);
  assert.equal(result.report.unchangedWorkspaceIds, true);
  assert.strictEqual(result.entities.find((e) => e.id === "t"), task);
  assert.deepEqual(before, original);
});

test("tasks inside a project inherit its Area without persisting a second Area link", () => {
  const area = entity("a", "area", "personal", {}, "Work");
  const p = entity("p", "project", "personal");
  const task = entity("t", "task", "personal", { area: "Work" });
  const source = {
    entities: [workspace("personal", "personal"), area, p, task],
    relations: [link("pa", "p", "a"), link("old-direct", "t", "a"), projectLink("tp", "t", "p")],
  };
  const result = planAreaNormalization(source, 100);
  assert.deepEqual(result.report.removedRedundantRelationIds, ["old-direct"]);
  assert.deepEqual(result.report.inheritedTaskIds, ["t"]);
  assert.equal(areaFor(result, "t").length, 0);
  assert.equal(areaFor(result, "p").length, 1);
  assert.equal(result.relations.some((r) => r.id === "tp"), true);
  assert.equal(result.entities.find((e) => e.id === "t"), task);
  const second = planAreaNormalization(result, 101);
  assert.deepEqual(second.entities, result.entities);
  assert.deepEqual(second.relations, result.relations);
  assert.deepEqual(second.report.createdAreaIds, []);
  assert.deepEqual(second.report.addedRelationIds, []);
});

test("a project task inherits when an old property holds the project reference", () => {
  const snapshot = {
    entities: [workspace("personal", "personal"),
      entity("p", "project", "personal"), entity("t", "task", "personal", { projectId: "p" })],
    relations: [],
  };
  const result = planAreaNormalization(snapshot, 100);
  assert.equal(areaFor(result, "p").length, 1);
  assert.equal(areaFor(result, "t").length, 0);
  assert.equal(result.report.inheritedTaskIds[0], "t");
});

test("shared legacy workspace remains shared, with compatibility Area in same workspace", () => {
  const snapshot = {
    entities: [workspace("personal", "personal"), workspace("legacy", "shared"),
      entity("p", "project", "legacy"), entity("t", "task", "legacy")],
    relations: [],
  };
  const result = planAreaNormalization(snapshot, 100);
  const fallback = result.entities.find((e) => e.type === "area");
  assert.equal(fallback.workspaceId, "legacy");
  assert.equal(fallback.properties.kind, "shared");
  assert.match(fallback.title, /původní sdílené/);
  assert.equal(result.report.unchangedWorkspaceIds, true);
  assert.deepEqual(result.entities.filter((e) => e.workspaceId === "legacy" && e.type !== "workspace").length, 3);
});

test("text labels map to same-workspace area, never cross into other workspace", () => {
  const snapshot = {
    entities: [workspace("personal", "personal"), workspace("legacy", "shared"),
      entity("known", "area", "personal", {}, "Rodina"),
      entity("p1", "project", "personal", { area: " Rodina  " }),
      entity("p2", "project", "legacy", { area: "Rodina" }),
      entity("t", "task", "personal", { area: "auto" })],
    relations: [],
  };
  const result = planAreaNormalization(snapshot, 100);
  assert.equal(areaFor(result, "p1")[0].targetEntityId, "known");
  const sharedArea = result.entities.find((e) => e.type === "area" && e.workspaceId === "legacy");
  assert.equal(areaFor(result, "p2")[0].targetEntityId, sharedArea.id);
  assert.equal(sharedArea.properties.kind, "shared");
  assert.equal(result.entities.find((e) => e.title === "auto").workspaceId, "personal");
  assert.equal(result.entities.find((e) => e.id === "known").updatedAt, 20);
});

test("generated IDs and content are deterministic for an identical input", () => {
  const source = {
    entities: [workspace("personal", "personal"), entity("t", "task", "personal", { area: "Cars" })],
    relations: [],
  };
  assert.deepEqual(planAreaNormalization(source, 100), planAreaNormalization(source, 100));
});

test("ambiguous Area links fail closed without dropping any relation", () => {
  const snapshot = {
    entities: [workspace("personal", "personal"),
      entity("a1", "area", "personal"), entity("a2", "area", "personal"),
      entity("p", "project", "personal")],
    relations: [link("r1", "p", "a1"), link("r2", "p", "a2")],
  };
  const before = structuredClone(snapshot);
  expectsBlocked(() => planAreaNormalization(snapshot, 100), "ambiguous-area:p");
  assert.deepEqual(snapshot, before);
});

test("a conflicting task Area is never silently rewritten when it joins a project", () => {
  const source = {
    entities: [workspace("personal", "personal"), entity("a1", "area", "personal"),
      entity("a2", "area", "personal"), entity("p", "project", "personal"),
      entity("t", "task", "personal")],
    relations: [link("p-area", "p", "a1"), link("t-area", "t", "a2"),
      projectLink("t-project", "t", "p")],
  };
  expectsBlocked(() => planAreaNormalization(source, 100), "project-task-area-disagrees:t");
});

test("conflicting project targets and cross-workspace relations are rejected", () => {
  const source = {
    entities: [workspace("personal", "personal"), workspace("legacy", "shared"),
      entity("p1", "project", "personal"), entity("p2", "project", "personal"),
      entity("t", "task", "personal")],
    relations: [projectLink("tp1", "t", "p1"), projectLink("tp2", "t", "p2")],
  };
  expectsBlocked(() => planAreaNormalization(source, 100), "ambiguous-task-project:t");
  const forged = {
    entities: [...source.entities, entity("p3", "project", "legacy")],
    relations: [projectLink("tp3", "t", "p3", "personal")],
  };
  expectsBlocked(() => planAreaNormalization(forged, 100), "invalid-scope-relation:tp3");
});

test("duplicate Area names fail if a legacy text label needs disambiguation", () => {
  const source = {
    entities: [workspace("personal", "personal"), entity("a1", "area", "personal", {}, "Work"),
      entity("a2", "area", "personal", {}, "WORK"),
      entity("p", "project", "personal", { area: "Work" })],
    relations: [],
  };
  expectsBlocked(() => planAreaNormalization(source, 100), "ambiguous-area-label:personal");
});

test("missing area ID, unknown workspace, and mismatched labels fail closed", () => {
  expectsBlocked(() => planAreaNormalization({
    entities: [workspace("personal", "personal"), entity("p", "project", "personal", { areaId: "gone" })],
    relations: [],
  }, 100), "invalid-area-reference:p");
  expectsBlocked(() => planAreaNormalization({
    entities: [workspace("personal", "personal"), entity("p", "project", "unknown")],
    relations: [],
  }, 100), "unknown-workspace:p");
  expectsBlocked(() => planAreaNormalization({
    entities: [workspace("personal", "personal"), entity("a", "area", "personal", {}, "Work"),
      entity("p", "project", "personal", { area: "Cars" })],
    relations: [link("pa", "p", "a")],
  }, 100), "conflicting-legacy-area-label:p");
});

test("redundant duplicate links are removed but the surviving relation keeps its ID/revision", () => {
  const source = {
    entities: [workspace("personal", "personal"), entity("a", "area", "personal"),
      entity("p", "project", "personal")],
    relations: [link("one", "p", "a"), link("two", "p", "a")],
  };
  const result = planAreaNormalization(source, 100);
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0], source.relations[0]);
  assert.deepEqual(result.report.removedRedundantRelationIds, ["two"]);
});
