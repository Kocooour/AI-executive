import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const { planAreaNormalization, AreaNormalizationBlocked } =
  await import("../lib/area-normalization.ts");
const { validateSnapshotStructure } = await import("../lib/snapshot-validation.ts");

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
  assert.equal(area.properties.kind, "private");
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
  assert.equal(result.relations.filter((relation) =>
    relation.sourceEntityId === "t" && relation.relationType === "belongs_to_project").length, 1);
  assert.equal(result.report.addedLegacyProjectRelationIds.length, 1);
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

test("an existing Area whose visibility contradicts its workspace is rejected", () => {
  const source = {
    entities: [workspace("personal", "personal"),
      entity("a", "area", "personal", { kind: "shared" }, "Do not expose"),
      entity("p", "project", "personal")],
    relations: [link("pa", "p", "a")],
  };
  expectsBlocked(() => planAreaNormalization(source, 100), "area-visibility-mismatch:a");
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
  expectsBlocked(() => planAreaNormalization(forged, 100), "snapshot-structure-invalid");
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
  }, 100), "snapshot-structure-invalid");
  expectsBlocked(() => planAreaNormalization({
    entities: [workspace("personal", "personal"), entity("a", "area", "personal", {}, "Work"),
      entity("p", "project", "personal", { area: "Cars" })],
    relations: [link("pa", "p", "a")],
  }, 100), "conflicting-legacy-area-label:p");
});

test("Area dedup retains earliest relation across snapshot permutations and stable ID on ties", () => {
  const entities = [workspace("personal", "personal"), entity("a", "area", "personal"),
    entity("p", "project", "personal")];
  const earliest = { ...link("later-lexically", "p", "a"), createdAt: 1 };
  const later = { ...link("first-lexically", "p", "a"), createdAt: 9 };
  for (const relations of [[later, earliest], [earliest, later]]) {
    const result = planAreaNormalization({ entities, relations }, 100);
    assert.deepEqual(areaFor(result, "p").map((rel) => rel.id), ["later-lexically"]);
    assert.strictEqual(areaFor(result, "p")[0], earliest);
    assert.deepEqual(result.report.removedRedundantRelationIds, ["first-lexically"]);
    assert.equal(result.report.after.relations, 1);
  }

  const high = { ...link("z", "p", "a"), createdAt: 5 };
  const low = { ...link("a", "p", "a"), createdAt: 5 };
  for (const relations of [[high, low], [low, high]]) {
    const result = planAreaNormalization({ entities, relations }, 100);
    assert.deepEqual(areaFor(result, "p").map((rel) => rel.id), ["a"]);
    assert.strictEqual(areaFor(result, "p")[0], low);
    assert.deepEqual(result.report.removedRedundantRelationIds, ["z"]);
    // Re-running a normalized snapshot cannot replace that surviving ID.
    assert.deepEqual(areaFor(planAreaNormalization(result, 101), "p").map((rel) => rel.id), ["a"]);
  }
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

test("invalid legacy projectId and areaId types block rather than assigning a fallback", () => {
  const base = [workspace("personal", "personal"), entity("p", "project", "personal"),
    entity("a", "area", "personal", { kind: "private" }, "Work")];
  const samples = [
    { task: entity("t", "task", "personal", { projectId: 123 }), reason: "invalid-legacy-reference:t:projectId" },
    { task: entity("t", "task", "personal", { projectId: { id: "p" } }), reason: "invalid-legacy-reference:t:projectId" },
    { task: entity("t", "task", "personal", { areaId: ["a"] }), reason: "invalid-legacy-reference:t:areaId" },
    { task: entity("t", "task", "personal", { area: { label: "Work" } }), reason: "invalid-legacy-area-label:t" },
    { task: entity("t", "project", "personal", { areaId: true }), reason: "invalid-legacy-reference:t:areaId" },
  ];
  for (const { task, reason } of samples) {
    const snapshot = { entities: [...base, task], relations: [] };
    const unchanged = structuredClone(snapshot);
    expectsBlocked(() => planAreaNormalization(snapshot, 100), reason);
    assert.deepEqual(snapshot, unchanged);
  }
  // Explicit null, absent and legacy empty values still represent "no link".
  const legacyEmpty = {
    entities: [workspace("personal", "personal"),
      entity("t", "task", "personal", { projectId: null, areaId: "", area: " " })],
    relations: [],
  };
  assert.equal(areaFor(planAreaNormalization(legacyEmpty, 100), "t").length, 1);
});

test("new Area names are deterministic across entity order and canonical labels are bounded", () => {
  const a = entity("p", "project", "personal", { area: "  Rodina   " });
  const b = entity("t", "task", "personal", { area: "rodina" });
  const c = entity("q", "project", "personal", { area: "RODINA" });
  const snapshots = [
    [workspace("personal", "personal"), a, b, c],
    [c, b, a, workspace("personal", "personal")],
  ].map((entities) => planAreaNormalization({ entities, relations: [] }, 100));
  const created = snapshots.map((snapshot) => snapshot.entities.filter((e) => e.type === "area"));
  assert.deepEqual(created[0], created[1]);
  assert.equal(created[0].length, 1);
  assert.equal(created[0][0].title, "RODINA");
  for (const snapshot of snapshots) {
    assert.equal(areaFor(snapshot, "p")[0].targetEntityId, created[0][0].id);
    assert.equal(areaFor(snapshot, "t")[0].targetEntityId, created[0][0].id);
    assert.equal(areaFor(snapshot, "q")[0].targetEntityId, created[0][0].id);
  }
  expectsBlocked(() => planAreaNormalization({
    entities: [workspace("personal", "personal"),
      entity("p", "project", "personal", { area: "x".repeat(1001) })],
    relations: [],
  }, 100), "invalid-area-label-length:p");
});

test("legacy Area without kind is reported as an explicit unresolved authorization gate", () => {
  const oldArea = entity("legacy-area", "area", "personal", {}, "Work");
  const snapshot = {
    entities: [workspace("personal", "personal"), oldArea,
      entity("p", "project", "personal", { areaId: "legacy-area" })],
    relations: [],
  };
  const result = planAreaNormalization(snapshot, 100);
  assert.deepEqual(result.report.existingAreaKindBackfillIds, ["legacy-area"]);
  assert.equal(result.report.areaKindBackfillRequired, true);
  assert.equal(result.entities.find((e) => e.id === "legacy-area"), oldArea);
  assert.equal(result.entities.find((e) => e.id === "legacy-area").properties.kind, undefined);
  const second = planAreaNormalization(result, 101);
  assert.deepEqual(second.report.existingAreaKindBackfillIds, ["legacy-area"]);
  assert.equal(second.report.areaKindBackfillRequired, true);
  const classified = planAreaNormalization({
    entities: [workspace("personal", "personal"),
      entity("typed", "area", "personal", { kind: "private" }, "Work"),
      entity("p", "project", "personal", { areaId: "typed" })],
    relations: [],
  }, 100);
  assert.deepEqual(classified.report.existingAreaKindBackfillIds, []);
  assert.equal(classified.report.areaKindBackfillRequired, false);
});

test("archived Area rejects active tasks/projects via label, property and relation", () => {
  const archived = { ...entity("area-archived", "area", "personal", { kind: "private" }, "Rodina"),
    status: "archived" };
  const combinations = [
    ["task", "open"],
    ["project", "active"],
  ];
  for (const [type, status] of combinations) {
    for (const reference of ["label", "property", "relation"]) {
      const item = { ...entity("item", type, "personal",
        reference === "label" ? { area: "Rodina" }
          : reference === "property" ? { areaId: archived.id } : {}), status };
      const snapshot = { entities: [workspace("personal", "personal"), archived, item],
        relations: reference === "relation" ? [link("prior", item.id, archived.id)] : [] };
      const before = structuredClone(snapshot);
      expectsBlocked(() => planAreaNormalization(snapshot, 100),
        "archived-area-for-active-item:item:area-archived");
      assert.deepEqual(snapshot, before);
    }
  }
  // An archived fallback is not a valid assignment for new unclassified work.
  const fallback = { ...entity("old-default", "area", "personal",
    { kind: "private" }, "Nezařazeno"), status: "archived" };
  expectsBlocked(() => planAreaNormalization({
    entities: [workspace("personal", "personal"), fallback, entity("t", "task", "personal")],
    relations: [],
  }, 100), "archived-area-for-active-item:t:old-default");
});

test("archived historical projects and tasks preserve their archived Area", () => {
  const archivedArea = { ...entity("a", "area", "personal", { kind: "private" }, "History"),
    status: "archived" };
  const oldProject = { ...entity("p", "project", "personal", { areaId: "a" }), status: "archived" };
  const oldTask = { ...entity("t", "task", "personal", { area: "History" }), status: "archived" };
  const snapshot = {
    entities: [workspace("personal", "personal"), archivedArea, oldProject, oldTask],
    relations: [],
  };
  const result = planAreaNormalization(snapshot, 100);
  assert.equal(areaFor(result, "p")[0].targetEntityId, "a");
  assert.equal(areaFor(result, "t")[0].targetEntityId, "a");
  assert.deepEqual(planAreaNormalization(result, 101).relations, result.relations);
});

test("workspace preflight rejects duplicate scopes and noncanonical workspace IDs", () => {
  const valid = workspace("personal", "personal");
  const duplicateScope = entity("workspace:alternate", "workspace", "personal",
    { kind: "personal", role: "owner", members: [] });
  const invalidId = entity("wrong", "workspace", "shared-area",
    { kind: "shared", role: "owner", members: [] });
  const illegalKind = workspace("unrelated", "personal");
  expectsBlocked(() => planAreaNormalization({
    entities: [valid, duplicateScope, entity("p", "project", "personal")],
    relations: [],
  }, 100), "snapshot-structure-invalid");
  expectsBlocked(() => planAreaNormalization({
    entities: [invalidId, entity("p", "project", "shared-area")],
    relations: [],
  }, 100), "snapshot-structure-invalid");
  expectsBlocked(() => planAreaNormalization({
    entities: [illegalKind, entity("p", "project", "unrelated")],
    relations: [],
  }, 100), "nonpersonal-workspace-kind-mismatch:workspace:unrelated");
  // Old snapshots without an explicit personal workspace remain supported.
  const implicit = planAreaNormalization({
    entities: [entity("p", "project", "personal")], relations: [],
  }, 100);
  assert.equal(implicit.report.createdAreaIds.length, 1);
});

test("added Area and legacy project relation audit IDs are sorted across permutations", () => {
  const projects = [entity("project-z", "project", "personal"),
    entity("project-a", "project", "personal")];
  const tasks = [entity("task-z", "task", "personal"),
    entity("task-a", "task", "personal"),
    entity("project-task-z", "task", "personal", { projectId: "project-z" }),
    entity("project-task-a", "task", "personal", { projectId: "project-a" })];
  const one = planAreaNormalization({
    entities: [workspace("personal", "personal"), ...projects, ...tasks], relations: [],
  }, 100);
  const two = planAreaNormalization({
    entities: [...tasks].reverse().concat([...projects].reverse(), workspace("personal", "personal")),
    relations: [],
  }, 100);
  const sorted = (ids) => [...ids].sort();
  assert.deepEqual(one.report.addedRelationIds, sorted(one.report.addedRelationIds));
  assert.deepEqual(one.report.addedLegacyProjectRelationIds, sorted(one.report.addedLegacyProjectRelationIds));
  assert.deepEqual(one.report.addedRelationIds, two.report.addedRelationIds);
  assert.deepEqual(one.report.addedLegacyProjectRelationIds, two.report.addedLegacyProjectRelationIds);
  assert.equal(one.report.addedLegacyProjectRelationIds.length, 2);
  assert.equal(one.report.addedRelationIds.length, 4);
  assert.deepEqual(one.report.createdAreaIds, two.report.createdAreaIds);
});

test("canonical structural validation blocks malformed entities before 2a planning", () => {
  const valid = { entities: [workspace("personal", "personal"),
    entity("t", "task", "personal")], relations: [] };
  const mutations = [
    [() => ({ ...entity("alien", "not-a-type", "personal") }), "unknown entity type"],
    [() => ({ ...entity("t", "task", "personal"), properties: null }), "null properties"],
    [() => ({ ...entity("t", "task", "personal"), title: "" }), "empty title"],
    [() => ({ ...entity("t", "task", "personal"), updatedAt: "bad" }), "nonnumeric update"],
    [() => ({ ...entity("t", "task", "personal"), id: "x".repeat(241) }), "oversized ID"],
  ];
  for (const [change, reason] of mutations) {
    const bad = change();
    const entities = reason === "unknown entity type"
      ? [...valid.entities, bad] : [valid.entities[0], bad];
    const snapshot = { entities, relations: [] };
    const saved = structuredClone(snapshot);
    expectsBlocked(() => planAreaNormalization(snapshot, 100), "snapshot-structure-invalid");
    assert.deepEqual(snapshot, saved, reason);
  }
});

test("canonical structural validation rejects invalid relations, including timestamps", () => {
  const area = entity("a", "area", "personal", {}, "Family");
  const task = entity("t", "task", "personal");
  const good = link("belongs", "t", "a");
  const entities = [workspace("personal", "personal"), area, task];
  for (const invalid of [
    { ...good, createdAt: "yesterday" },
    { ...good, createdAt: Number.NaN },
    { ...good, relationType: "" },
    { ...good, targetEntityId: "missing" },
    { ...good, workspaceId: "other" },
  ]) {
    expectsBlocked(() => planAreaNormalization({ entities, relations: [invalid] }, 100),
      "snapshot-structure-invalid");
  }
});

test("canonical structural validation rejects malformed workspace properties", () => {
  const baseline = workspace("personal", "personal");
  for (const properties of [
    { ...baseline.properties, role: "editor" },
    { ...baseline.properties, members: "owner" },
    { ...baseline.properties, calendarDecisions: { "occ:test": "yes" } },
  ]) {
    const snapshot = { entities: [{ ...baseline, properties },
      entity("t", "task", "personal")], relations: [] };
    expectsBlocked(() => planAreaNormalization(snapshot, 100), "snapshot-structure-invalid");
  }
  const titleTooLong = { ...baseline, title: "X".repeat(121) };
  expectsBlocked(() => planAreaNormalization({ entities: [titleTooLong], relations: [] }, 100),
    "snapshot-structure-invalid");
  // Valid calendar decisions remain accepted without a live server connection.
  const valid = { ...baseline, properties: {
    ...baseline.properties, calendarDecisions: { "occ:source:item": "hidden" },
  } };
  assert.equal(planAreaNormalization({ entities: [valid,
    entity("t", "task", "personal")], relations: [] }, 100).report.addedRelationIds.length, 1);
});

test("canonical structural validation also checks supplied tombstones without changing them", () => {
  const entities = [workspace("personal", "personal"), entity("t", "task", "personal")];
  const valid = { entities, relations: [], tombstones: [{ id: "obsolete", deletedAt: 100 }] };
  const planned = planAreaNormalization(valid, 100);
  assert.equal(planned.report.addedRelationIds.length, 1);
  assert.deepEqual(valid.tombstones, [{ id: "obsolete", deletedAt: 100 }]);
  for (const tombstones of [[{ id: "obsolete", deletedAt: "today" }], "invalid"]) {
    expectsBlocked(() => planAreaNormalization({ entities, relations: [], tombstones }, 100),
      "snapshot-structure-invalid");
  }
});

test("tombstoned generated Area IDs block a new Area instead of resurrecting it", () => {
  const entities = [workspace("personal", "personal"),
    entity("project", "project", "personal")];
  const first = planAreaNormalization({ entities, relations: [] }, 100);
  const deletedAreaId = first.report.createdAreaIds[0];
  assert.ok(deletedAreaId.startsWith("area:2a:"));
  const input = {
    entities, relations: [],
    tombstones: [{ id: deletedAreaId, deletedAt: 101 }],
  };
  const original = structuredClone(input);
  expectsBlocked(() => planAreaNormalization(input, 102),
    "tombstoned-generated-area-id:" + deletedAreaId);
  assert.deepEqual(input, original);
});

test("tombstoned generated belongs_to_area relation IDs block relinking", () => {
  const entities = [workspace("personal", "personal"),
    entity("known-area", "area", "personal", { kind: "private" }, "Family"),
    entity("task", "task", "personal", { areaId: "known-area" })];
  const initial = planAreaNormalization({ entities, relations: [] }, 100);
  assert.deepEqual(initial.report.createdAreaIds, []);
  const deletedRelationId = initial.report.addedRelationIds[0];
  assert.ok(deletedRelationId.startsWith("relation:2a:"));
  const input = {
    entities, relations: [],
    tombstones: [{ id: deletedRelationId, deletedAt: 101 }],
  };
  const original = structuredClone(input);
  expectsBlocked(() => planAreaNormalization(input, 102),
    "tombstoned-generated-area-relation-id:" + deletedRelationId);
  assert.deepEqual(input, original);
});

test("tombstoned generated legacy belongs_to_project IDs block project relinking", () => {
  const entities = [workspace("personal", "personal"),
    entity("known-area", "area", "personal", { kind: "private" }, "Family"),
    entity("project", "project", "personal", { areaId: "known-area" }),
    entity("task", "task", "personal", { projectId: "project" })];
  const initial = planAreaNormalization({ entities, relations: [] }, 100);
  const deletedRelationId = initial.report.addedLegacyProjectRelationIds[0];
  assert.ok(deletedRelationId.startsWith("relation:2a:"));
  const input = {
    entities, relations: [],
    tombstones: [{ id: deletedRelationId, deletedAt: 101 }],
  };
  const original = structuredClone(input);
  expectsBlocked(() => planAreaNormalization(input, 102),
    "tombstoned-generated-project-relation-id:" + deletedRelationId);
  assert.deepEqual(input, original);

  // Unrelated historical tombstones must not suppress valid new IDs.
  const allowed = planAreaNormalization({
    entities, relations: [], tombstones: [{ id: "unrelated-deleted-record", deletedAt: 101 }],
  }, 102);
  assert.equal(allowed.report.addedLegacyProjectRelationIds.length, 1);
  assert.equal(allowed.report.addedRelationIds.length, 1);
});

test("2a preflight preserves main project-context validation", () => {
  const validContext = {
    why: "Proč", goals: ["Dokončit"], doneWhen: "Hotovo", provenance: "owner", updatedAt: 100,
  };
  const source = (properties) => ({
    entities: [workspace("personal", "personal"),
      entity("project", "project", "personal", properties)],
    relations: [],
  });
  const valid = source({ context: validContext });
  assert.equal(planAreaNormalization(valid, 101).report.addedRelationIds.length, 1);
  // Existing projects may have the legacy goal and no context.
  assert.equal(planAreaNormalization(source({ goal: "legacy" }), 101).report.addedRelationIds.length, 1);

  const invalid = [
    { ...validContext, why: "x".repeat(601) },
    { ...validContext, goals: Array(6).fill("A") },
    { ...validContext, goals: ["x".repeat(201)] },
    { ...validContext, doneWhen: "x".repeat(301) },
    { ...validContext, provenance: "unknown" },
    { ...validContext, extra: "unexpected" },
    "not-a-project-context",
  ];
  for (const context of invalid) {
    const snapshot = source({ context });
    const before = structuredClone(snapshot);
    expectsBlocked(() => planAreaNormalization(snapshot, 101), "snapshot-structure-invalid");
    assert.deepEqual(snapshot, before);
  }
});

test("shared canonical validation rejects tombstones on existing entity and relation IDs", () => {
  const entities = [workspace("personal", "personal"),
    entity("old-area", "area", "personal", { kind: "private" }, "Work"),
    entity("p", "project", "personal", { areaId: "old-area" })];
  const relations = [link("project-area", "p", "old-area")];
  for (const id of ["old-area", "project-area", "workspace:personal", "p"]) {
    const snapshot = {
      entities, relations, tombstones: [{ id, deletedAt: 120 }],
    };
    const before = structuredClone(snapshot);
    assert.throws(() => validateSnapshotStructure(snapshot), /tombstone overlaps a live record/);
    expectsBlocked(() => planAreaNormalization(snapshot, 121), "snapshot-structure-invalid");
    assert.deepEqual(snapshot, before, `snapshot must remain unchanged for ${id}`);
  }
});

test("shared canonical validation rejects duplicate tombstone IDs even at different timestamps", () => {
  const entities = [workspace("personal", "personal"),
    entity("t", "task", "personal")];
  for (const timestamps of [[100, 100], [100, 200]]) {
    const snapshot = {
      entities, relations: [],
      tombstones: timestamps.map((deletedAt) => ({ id: "previously-deleted", deletedAt })),
    };
    const before = structuredClone(snapshot);
    assert.throws(() => validateSnapshotStructure(snapshot), /duplicate tombstone IDs/);
    expectsBlocked(() => planAreaNormalization(snapshot, 201), "snapshot-structure-invalid");
    assert.deepEqual(snapshot, before);
  }
});

test("distinct unrelated tombstones remain valid for shared validation and offline 2a", () => {
  const snapshot = {
    entities: [workspace("personal", "personal"),
      entity("p", "project", "personal")],
    relations: [],
    tombstones: [
      { id: "deleted-task", deletedAt: 40 },
      { id: "deleted-project", deletedAt: 50 },
    ],
  };
  const before = structuredClone(snapshot);
  assert.doesNotThrow(() => validateSnapshotStructure(snapshot));
  const planned = planAreaNormalization(snapshot, 201);
  assert.equal(planned.report.createdAreaIds.length, 1);
  assert.equal(planned.report.addedRelationIds.length, 1);
  assert.deepEqual(snapshot, before);
});

test("duplicate belongs_to_project links keep a stable canonical ID and audit removals", () => {
  const entities = [
    workspace("personal", "personal"),
    entity("a", "area", "personal", { kind: "private" }, "Work"),
    entity("p", "project", "personal", { areaId: "a" }),
    entity("t", "task", "personal", { projectId: "p" }),
  ];
  const projectArea = link("p-area", "p", "a");
  for (const [first, second, survivor, removedId] of [
    [{ ...projectLink("earlier", "t", "p"), createdAt: 5 },
      { ...projectLink("later", "t", "p"), createdAt: 25 }, "earlier", "later"],
    [projectLink("a", "t", "p"), projectLink("z", "t", "p"), "a", "z"],
  ]) {
    const results = [];
    for (const links of [[first, second], [second, first]]) {
      const snapshot = { entities, relations: [projectArea, ...links] };
      const before = structuredClone(snapshot);
      const result = planAreaNormalization(snapshot, 100);
      assert.deepEqual(snapshot, before, "planning must never modify source records");
      assert.deepEqual(
        result.relations.filter((r) => r.sourceEntityId === "t" && r.relationType === "belongs_to_project")
          .map((r) => r.id),
        [survivor],
      );
      assert.strictEqual(result.relations.find((r) => r.id === survivor),
        links.find((r) => r.id === survivor), "surviving relation must keep its identity and timestamps");
      assert.deepEqual(result.report.removedRedundantRelationIds, [removedId]);
      assert.deepEqual(result.report.addedLegacyProjectRelationIds, []);
      assert.equal(result.report.before.relations, 3);
      assert.equal(result.report.after.relations, 2);
      assert.equal(result.report.inheritedTaskIds.length, 1);
      const secondPass = planAreaNormalization(result, 101);
      assert.deepEqual(secondPass.entities, result.entities);
      assert.deepEqual(secondPass.relations, result.relations);
      assert.deepEqual(secondPass.report.removedRedundantRelationIds, []);
      results.push(result);
    }
    assert.deepEqual(results[0].report, results[1].report,
      "audit report must be independent of incoming duplicate link order");
  }
});

const predicted2aId = (...parts) => "relation:2a:"
  + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

test("generated Area ID cannot reuse an existing belongs_to_area relation ID", () => {
  const area = entity("known-area", "area", "personal", { kind: "private" }, "Known");
  const existing = entity("existing", "project", "personal", { areaId: area.id });
  const missing = entity("missing", "project", "personal", { area: "Cars" });
  const collisionId = "area:2a:"
    + createHash("sha256").update(JSON.stringify(["personal", "cars"])).digest("hex").slice(0, 32);
  const snapshot = {
    entities: [workspace("personal", "personal"), area, existing, missing],
    relations: [link(collisionId, existing.id, area.id)],
  };
  const before = structuredClone(snapshot);
  expectsBlocked(() => planAreaNormalization(snapshot, 100), "generated-area-id-collision:" + collisionId);
  assert.deepEqual(snapshot, before);
});

test("generated belongs_to_area ID cannot reuse an existing entity ID", () => {
  const area = entity("known-area", "area", "personal", { kind: "private" }, "Known");
  const project = entity("project", "project", "personal", { areaId: area.id });
  const collisionId = predicted2aId(project.id, area.id);
  const snapshot = {
    entities: [workspace("personal", "personal"), area, project,
      entity(collisionId, "note", "personal")],
    relations: [],
  };
  const before = structuredClone(snapshot);
  expectsBlocked(() => planAreaNormalization(snapshot, 100), "generated-relation-id-collision:" + collisionId);
  assert.deepEqual(snapshot, before);
});

test("generated belongs_to_project ID cannot reuse an existing entity ID", () => {
  const area = entity("known-area", "area", "personal", { kind: "private" }, "Known");
  const project = entity("project", "project", "personal", { areaId: area.id });
  const task = entity("task", "task", "personal", { projectId: project.id });
  const collisionId = predicted2aId("project", task.id, project.id);
  const snapshot = {
    entities: [workspace("personal", "personal"), area, project, task,
      entity(collisionId, "note", "personal")],
    relations: [],
  };
  const before = structuredClone(snapshot);
  expectsBlocked(() => planAreaNormalization(snapshot, 100),
    "generated-project-relation-id-collision:" + collisionId);
  assert.deepEqual(snapshot, before);
});
