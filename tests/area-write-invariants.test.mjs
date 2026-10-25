import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { enforceAreaWriteInvariants, planFallbackArea, fallbackRelationId, workspaceKinds, legacyAreaIdBecomesRelation, isFallbackArea } from "../lib/area-write-invariants.ts";
import { generatedAreaId, generatedRelationId, normalizedLabel } from "../lib/area-normalization.ts";
import { sha256Hex } from "../lib/sha256.ts";
import { planAreaNormalization } from "../lib/area-normalization.ts";

const NOW = 1_000_000;
const ent = (id, type, workspaceId = "personal", properties = {}, extra = {}) => ({
  id, type, title: extra.title ?? "T " + id, workspaceId, properties,
  status: type === "task" ? "open" : "active", createdAt: 10, updatedAt: 100, ...extra,
});
const workspace = (id, kind) => ent("workspace:" + id, "workspace", id, { kind, role: "owner", members: [{ id: "owner", role: "owner" }] }, { title: id });
const rel = (id, source, target, relationType, workspaceId = "personal", createdAt = 50) =>
  ({ id, sourceEntityId: source, targetEntityId: target, relationType, workspaceId, createdAt });
const FALLBACK = generatedAreaId("personal", "Nezařazeno");
const SHARED_FALLBACK = generatedAreaId("team", "Nezařazeno (původní sdílené)");
const baseEntities = () => [workspace("personal", "personal"), workspace("team", "shared"),
  ent("area:a", "area", "personal", { kind: "private" }), ent("area:b", "area", "personal", { kind: "private" }),
  ent("proj", "project", "personal"), ent("area:t", "area", "team", { kind: "shared" })];
const baseRelations = () => [rel("r:proj-area", "proj", "area:a", "belongs_to_area")];
const run = (current, next, tombstones = [], now = NOW, previousTombstones = tombstones) =>
  enforceAreaWriteInvariants({ current, next, tombstones, previousTombstones, now });
const state = (entities, relations) => ({ entities, relations });
const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
const areaLinks = (result, id) => result.relations.filter((r) => r.sourceEntityId === id && r.relationType === "belongs_to_area");
const entity = (result, id) => result.entities.find((e) => e.id === id);

test("sha256Hex matches node:crypto for ASCII, unicode and block-boundary lengths", () => {
  for (const text of ["", "abc", "Nezařazeno (původní sdílené)", "😀 emoji", "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "x".repeat(65),
    "ž".repeat(1000), randomBytes(300).toString("latin1")]) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"), text.slice(0, 10));
  }
});

test("fallback Area and relation IDs are the planner's (browser-safe digest is byte-identical)", () => {
  const plan = planAreaNormalization({
    entities: [workspace("personal", "personal"), ent("p", "project")], relations: [],
  }, 5);
  assert.deepEqual(plan.report.createdAreaIds, [FALLBACK]);
  assert.deepEqual(plan.report.addedRelationIds, [generatedRelationId("p", FALLBACK)]);
  assert.equal(fallbackRelationId("p", FALLBACK, () => false), generatedRelationId("p", FALLBACK));
});

test("R1: a new Area link on a task that is in a project is dropped, with a tombstone-ready ID", () => {
  const current = state([...baseEntities(), ent("t", "task")], [...baseRelations(), rel("r:t-proj", "t", "proj", "belongs_to_project")]);
  const next = state(current.entities, [...current.relations, rel("r:new", "t", "area:b", "belongs_to_area", "personal", 70)]);
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "t"), []);
  assert.deepEqual(out.droppedRelationIds, ["r:new"]);
  assert.equal(out.report.droppedProjectTaskAreaLinks, 1);
  assert.equal(entity(out, "t").updatedAt, NOW);
  assert.equal(entity(out, "t").properties.relationsUpdatedAt, NOW);
});

test("R1: a new properties.areaId on a project task is removed; an unchanged legacy one stays", () => {
  const legacyTask = ent("t", "task", "personal", { areaId: "area:a" });
  const current = state([...baseEntities(), legacyTask], [rel("r:t-proj", "t", "proj", "belongs_to_project")]);
  assert.equal(run(current, current).changed, false, "untouched legacy property");
  const next = state(current.entities.map((e) => e.id === "t" ? { ...e, properties: { areaId: "area:b" } } : e), current.relations);
  const out = run(current, next);
  assert.equal("areaId" in entity(out, "t").properties, false);
  assert.equal(out.report.droppedProjectTaskAreaLinks, 1);
});

test("R1: a brand-new task created inside a project never keeps a task-level Area link or areaId", () => {
  const current = state(baseEntities(), baseRelations());
  const next = state([...current.entities, ent("n", "task", "personal", { areaId: "area:b" })],
    [...current.relations, rel("r:n-proj", "n", "proj", "belongs_to_project"), rel("r:n-area", "n", "area:b", "belongs_to_area")]);
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "n"), []);
  assert.equal("areaId" in entity(out, "n").properties, false);
  assert.equal(out.relations.some((r) => r.id === "r:n-proj"), true);
  assert.equal(out.report.fallbackAssigned, 0);
});

test("R2: a task that moves into a project loses ALL its Area links, also pre-existing ones, and areaId", () => {
  const current = state([...baseEntities(), ent("t", "task", "personal", { areaId: "area:b" })],
    [...baseRelations(), rel("r:t-a", "t", "area:a", "belongs_to_area"), rel("r:t-b", "t", "area:b", "belongs_to_area")]);
  const next = state(current.entities, [...current.relations, rel("r:t-proj", "t", "proj", "belongs_to_project", "personal", 90)]);
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "t"), []);
  assert.deepEqual(out.droppedRelationIds, ["r:t-a", "r:t-b"]);
  assert.equal("areaId" in entity(out, "t").properties, false);
  assert.equal(out.report.tasksInheritingFromProject, 1);
  assert.equal(out.relations.some((r) => r.id === "r:t-proj"), true);
});

test("R3: a new project and a new standalone task get the fallback Area, which is created with its kind", () => {
  const current = state([workspace("personal", "personal")], []);
  const next = state([...current.entities, ent("p", "project"), ent("t", "task")], []);
  const out = run(current, next);
  const fallback = entity(out, FALLBACK);
  assert.equal(fallback.title, "Nezařazeno");
  assert.equal(fallback.properties.kind, "private");
  assert.equal(fallback.status, "active");
  assert.equal(fallback.workspaceId, "personal");
  assert.deepEqual(areaLinks(out, "p").map((r) => r.targetEntityId), [FALLBACK]);
  assert.deepEqual(areaLinks(out, "t").map((r) => r.targetEntityId), [FALLBACK]);
  assert.equal(out.report.fallbackAreasCreated, 1);
  assert.equal(out.report.fallbackAssigned, 2);
  assert.equal(entity(out, "p").properties.relationsUpdatedAt, NOW);
});

test("R3: a legacy shared workspace gets the shared fallback with kind shared; never a cross-workspace link", () => {
  const current = state([workspace("personal", "personal"), workspace("team", "shared")], []);
  const next = state([...current.entities, ent("sp", "project", "team"), ent("pt", "task", "personal")], []);
  const out = run(current, next);
  const shared = entity(out, SHARED_FALLBACK);
  assert.equal(shared.title, "Nezařazeno (původní sdílené)");
  assert.equal(shared.properties.kind, "shared");
  assert.equal(shared.workspaceId, "team");
  assert.deepEqual(areaLinks(out, "sp").map((r) => r.targetEntityId), [SHARED_FALLBACK]);
  assert.deepEqual(areaLinks(out, "pt").map((r) => r.targetEntityId), [FALLBACK]);
  for (const link of out.relations) {
    const source = entity(out, link.sourceEntityId), target = entity(out, link.targetEntityId);
    assert.equal(source.workspaceId, target.workspaceId);
    assert.equal(link.workspaceId, source.workspaceId);
  }
});

test("R3: a task leaving its project gets the fallback Area, not the old project's Area", () => {
  const current = state([...baseEntities(), ent("t", "task")], [...baseRelations(), rel("r:t-proj", "t", "proj", "belongs_to_project")]);
  const next = state(current.entities, current.relations.filter((r) => r.id !== "r:t-proj"));
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "t").map((r) => r.targetEntityId), [FALLBACK]);
  assert.equal(entity(out, "t").updatedAt, NOW);
  assert.equal(out.report.fallbackAssigned, 1);
});

test("R3: reuses the one existing Area with the fallback label (case/whitespace-insensitive) instead of creating one", () => {
  const existing = ent("area:mine", "area", "personal", { kind: "private" }, { title: "  nezařazeno " });
  const current = state([workspace("personal", "personal"), existing], []);
  const out = run(current, state([...current.entities, ent("t", "task")], []));
  assert.deepEqual(areaLinks(out, "t").map((r) => r.targetEntityId), ["area:mine"]);
  assert.equal(out.report.fallbackAreasCreated, 0);
  assert.equal(out.entities.length, 3);
});

test("R3: ambiguous or archived label matches leave the item unassigned (reported, nothing invented)", () => {
  const a = ent("area:x1", "area", "personal", { kind: "private" }, { title: "Nezařazeno" });
  const b = ent("area:x2", "area", "personal", { kind: "private" }, { title: "NEZAŘAZENO" });
  const current = state([workspace("personal", "personal"), a, b], []);
  const ambiguous = run(current, state([...current.entities, ent("t", "task")], []));
  assert.deepEqual(areaLinks(ambiguous, "t"), []);
  assert.equal(ambiguous.report.fallbackUnavailable, 1);
  const archived = { ...a, status: "archived" };
  const current2 = state([workspace("personal", "personal"), archived], []);
  const out = run(current2, state([...current2.entities, ent("t", "task")], []));
  assert.deepEqual(areaLinks(out, "t"), []);
  assert.equal(out.report.fallbackUnavailable, 1);
});

test("R3: a tombstoned fallback Area ID is never recreated; the item stays unassigned", () => {
  const current = state([workspace("personal", "personal")], []);
  const next = state([...current.entities, ent("t", "task")], []);
  const out = run(current, next, [{ id: FALLBACK }]);
  assert.deepEqual(areaLinks(out, "t"), []);
  assert.equal(out.entities.some((e) => e.id === FALLBACK), false);
  assert.equal(out.report.fallbackUnavailable, 1);
  assert.equal(planFallbackArea({ workspaceId: "personal", kind: "personal", entities: current.entities, tombstonedIds: new Set([FALLBACK]), now: 1 }).reason, "tombstoned");
});

test("R3: a tombstoned planner relation ID is skipped for a deterministic alternative", () => {
  const fallbackArea = ent(FALLBACK, "area", "personal", { kind: "private" }, { title: "Nezařazeno" });
  const current = state([workspace("personal", "personal"), fallbackArea], []);
  const next = state([...current.entities, ent("t", "task")], []);
  const tomb = [{ id: generatedRelationId("t", FALLBACK) }];
  const out = run(current, next, tomb);
  const links = areaLinks(out, "t");
  assert.equal(links.length, 1);
  assert.notEqual(links[0].id, generatedRelationId("t", FALLBACK));
  assert.match(links[0].id, /^relation:2w:/);
  assert.deepEqual(run(current, next, tomb).relations, out.relations, "deterministic");
});

test("R3: an item that already has an Area (link, areaId or legacy label) is left alone", () => {
  const current = state([workspace("personal", "personal"), ent("area:a", "area", "personal", { kind: "private" })], []);
  const next = state([...current.entities,
    ent("p", "project"), ent("t1", "task", "personal", { areaId: "area:a" }), ent("t2", "task", "personal", { area: "Domov" }), ent("t3", "task")],
  [rel("r:p", "p", "area:a", "belongs_to_area")]);
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "p").map((r) => r.id), ["r:p"]);
  assert.deepEqual(areaLinks(out, "t1").map((r) => r.targetEntityId), ["area:a"]);
  assert.deepEqual(areaLinks(out, "t2").map((r) => r.targetEntityId), [generatedAreaId("personal", "Domov")]);
  assert.equal("area" in entity(out, "t2").properties, false);
  assert.deepEqual(areaLinks(out, "t3").map((r) => r.targetEntityId), [FALLBACK]);
});

test("R4: restoring a tombstoned old Area relation must not override the current assignment", () => {
  const current = state([...baseEntities(), ent("t", "task")],
    [...baseRelations(), rel("r:new-b", "t", "area:b", "belongs_to_area", "personal", 200)]);
  const next = state(current.entities, [...current.relations,
    rel("r:revived-a", "t", "area:a", "belongs_to_area", "personal", 50)]);
  const out = run(current, next, [], NOW, [{ id: "r:revived-a" }]);
  assert.deepEqual(areaLinks(out, "t").map((r) => r.targetEntityId), ["area:b"]);
  assert.deepEqual(out.droppedRelationIds, ["r:revived-a"]);
  const plan = planAreaNormalization({ entities: out.entities, relations: out.relations, tombstones: [] }, NOW + 1);
  assert.deepEqual(plan.report.addedRelationIds, []);
});

test("R3: legacy text-only Area on a new task gets a canonical Area and relation", () => {
  const current = state([workspace("personal", "personal")], []);
  const next = state([...current.entities,
    ent("label-task", "task", "personal", { area: "  Rodina " }),
    ent("label-proj", "project", "personal", { area: "rodina" }),
  ], []);
  const out = run(current, next);
  const areaId = generatedAreaId("personal", "Rodina");
  assert.deepEqual(areaLinks(out, "label-task").map((r) => r.targetEntityId), [areaId]);
  assert.deepEqual(areaLinks(out, "label-proj").map((r) => r.targetEntityId), [areaId]);
  assert.equal(out.entities.filter((e) => e.id === areaId).length, 1);
  assert.equal(entity(out, areaId).properties.kind, "private");
  assert.equal("area" in entity(out, "label-task").properties, false);
  assert.equal(out.report.legacyAreaLabelsCanonicalized, 2);
  const plan = planAreaNormalization({ entities: out.entities, relations: out.relations, tombstones: [] }, NOW + 1);
  assert.deepEqual(plan.report.addedRelationIds, []);
  assert.deepEqual(plan.report.createdAreaIds, []);
});

test("R3: ambiguous, archived or tombstoned free-text Area is rejected atomically", () => {
  const base = state([workspace("personal", "personal")], []);
  const incoming = (current) => state([...current.entities, ent("text-only", "task", "personal", { area: "Rodina" })], []);
  const dup = state([...base.entities,
    ent("area:x", "area", "personal", { kind: "private" }, { title: "Rodina" }),
    ent("area:y", "area", "personal", { kind: "private" }, { title: " RODINA " })], []);
  assert.throws(() => run(dup, incoming(dup)), /Invalid Area assignment/);
  const archived = state([...base.entities, ent("area:old", "area", "personal", { kind: "private" }, { title: "Rodina", status: "archived" })], []);
  assert.throws(() => run(archived, incoming(archived)), /Invalid Area assignment/);
  assert.throws(() => run(base, incoming(base), [{ id: generatedAreaId("personal", "Rodina") }]), /Invalid Area assignment/);
});

test("system fallback Area cannot be renamed, archived or removed by a new write", () => {
  const fallback = ent(FALLBACK, "area", "personal", { kind: "private" }, { title: "Nezařazeno" });
  const current = state([workspace("personal", "personal"), fallback], []);
  for (const next of [
    state([workspace("personal", "personal")], []),
    state([workspace("personal", "personal"), { ...fallback, title: "Changed" }], []),
    state([workspace("personal", "personal"), { ...fallback, status: "archived" }], []),
  ]) assert.throws(() => run(current, next), /Invalid Area assignment/);
});

test("R4: a second Area on an entity keeps the newest new link and drops the other new ones", () => {
  const current = state([...baseEntities(), ent("t", "task")], [rel("r:t-a", "t", "area:a", "belongs_to_area", "personal", 60)]);
  const next = state(current.entities, [
    rel("r:t-a", "t", "area:a", "belongs_to_area", "personal", 60),
    rel("r:t-b", "t", "area:b", "belongs_to_area", "personal", 80),
    rel("r:t-b2", "t", "area:b", "belongs_to_area", "personal", 85),
  ]);
  const out = run(current, next);
  assert.deepEqual(byId(areaLinks(out, "t")).map((r) => r.id), ["r:t-b2"], "the new assignment replaces the previous Area");
  assert.deepEqual(out.droppedRelationIds, ["r:t-a", "r:t-b"]);
  assert.equal(out.report.duplicateAreaLinksDropped, 2);
  // ties on createdAt are broken by ID
  const tie = state(current.entities, [
    rel("r:z1", "t", "area:a", "belongs_to_area", "personal", 90), rel("r:z2", "t", "area:b", "belongs_to_area", "personal", 90),
  ]);
  assert.deepEqual(areaLinks(run(state(current.entities, []), tie), "t").map((r) => r.id), ["r:z2"]);
});

test("R3: a new standalone task or project with legacy areaId gains one canonical Area link", () => {
  const current = state(baseEntities(), baseRelations());
  const next = state([...current.entities,
    ent("legacy-task", "task", "personal", { areaId: "area:b" }),
    ent("legacy-proj", "project", "personal", { areaId: "area:a" }),
  ], current.relations);
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "legacy-task").map((link) => link.targetEntityId), ["area:b"]);
  assert.deepEqual(areaLinks(out, "legacy-proj").map((link) => link.targetEntityId), ["area:a"]);
  assert.equal("areaId" in entity(out, "legacy-task").properties, false);
  assert.equal("areaId" in entity(out, "legacy-proj").properties, false);
  assert.equal(out.report.legacyAreaIdsCanonicalized, 2);
  const plan = planAreaNormalization({ entities: out.entities, relations: out.relations, tombstones: [] }, NOW + 1);
  assert.deepEqual(plan.report.addedRelationIds, []);
});

test("R4: a new canonical relation supersedes an unchanged stale areaId and label", () => {
  const current = state([...baseEntities(),
    ent("t", "task", "personal", { areaId: "area:a", area: "Earlier Area" })], baseRelations());
  const next = state(current.entities, [
    ...current.relations, rel("r:t-choice", "t", "area:b", "belongs_to_area"),
  ]);
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "t").map((link) => link.targetEntityId), ["area:b"]);
  assert.equal("areaId" in entity(out, "t").properties, false);
  assert.equal("area" in entity(out, "t").properties, false);
});

test("R4: explicitly changing areaId to an existing link drops other historical links", () => {
  const current = state([...baseEntities(), ent("t", "task", "personal", { areaId: "area:a" })],
    [rel("r:old-a", "t", "area:a", "belongs_to_area"), rel("r:old-b", "t", "area:b", "belongs_to_area")]);
  const next = state(current.entities.map((item) =>
    item.id === "t" ? { ...item, properties: { areaId: "area:b" } } : item), current.relations);
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "t").map((link) => link.id), ["r:old-b"]);
  assert.deepEqual(out.droppedRelationIds, ["r:old-a"]);
  assert.equal(entity(out, "t").properties.areaId, undefined);
});

test("new invalid legacy areaId is rejected instead of persisting a broken reference", () => {
  const current = state(baseEntities(), baseRelations());
  for (const areaId of ["absent", "area:t"]) {
    const next = state([...current.entities, ent("invalid", "task", "personal", { areaId })], current.relations);
    assert.throws(() => run(current, next), /Invalid Area assignment/);
  }
});

test("R4: several links that all pre-existed are legacy and stay untouched", () => {
  const links = [rel("r:1", "t", "area:a", "belongs_to_area"), rel("r:2", "t", "area:b", "belongs_to_area")];
  const current = state([...baseEntities(), ent("t", "task")], links);
  const out = run(current, state(current.entities, links));
  assert.equal(out.changed, false);
  assert.equal(areaLinks(out, "t").length, 2);
});

test("R5: a new or changed Area gets the workspace kind; an unchanged one with a wrong/missing kind is left (applicator)", () => {
  const untouched = ent("area:old", "area", "personal", {});
  const wrong = ent("area:wrong", "area", "team", { kind: "private" });
  const current = state([workspace("personal", "personal"), workspace("team", "shared"), untouched, wrong, ent("area:chg", "area", "personal", { kind: "private" })], []);
  const next = state([
    ...current.entities.map((e) => e.id === "area:chg" ? { ...e, title: "renamed", updatedAt: 500, properties: {} } : e),
    ent("area:new", "area", "personal", {}), ent("area:new-team", "area", "team", { kind: "private" }),
  ], []);
  const out = run(current, next);
  assert.equal(entity(out, "area:chg").properties.kind, "private");
  assert.equal(entity(out, "area:new").properties.kind, "private");
  assert.equal(entity(out, "area:new-team").properties.kind, "shared");
  assert.equal(entity(out, "area:old").properties.kind, undefined);
  assert.equal(entity(out, "area:wrong").properties.kind, "private");
  assert.equal(out.report.areaKindsRestored, 3);
  assert.equal(entity(out, "area:chg").updatedAt, 500 < NOW ? NOW : 501);
  assert.equal(entity(out, "area:chg").properties.relationsUpdatedAt, undefined);
});

test("updatedAt is max(now, old + 1): a client clock ahead of the server cannot win over the correction", () => {
  const current = state(baseEntities(), baseRelations());
  const future = NOW + 5000;
  const next = state([...current.entities, ent("n", "task", "personal", {}, { updatedAt: future })], [rel("r:n-proj", "n", "proj", "belongs_to_project")]);
  const withArea = state(next.entities, [...next.relations, rel("r:n-a", "n", "area:a", "belongs_to_area")]);
  const out = run(current, withArea);
  assert.equal(entity(out, "n").updatedAt, future + 1);
});

test("legacy violations the write did not touch are neither fixed nor dropped", () => {
  const entities = [...baseEntities(), ent("lp", "project"), ent("lt", "task"), ent("pt", "task", "personal", { areaId: "area:a" }),
    ent("dup", "task"), ent("area:nokind", "area", "personal", {})];
  const relations = [rel("r:pt-proj", "pt", "proj", "belongs_to_project"), rel("r:pt-area", "pt", "area:a", "belongs_to_area"),
    rel("r:d1", "dup", "area:a", "belongs_to_area"), rel("r:d2", "dup", "area:b", "belongs_to_area")];
  const current = state(entities, relations);
  // an unrelated edit
  const next = state(entities.map((e) => e.id === "proj" ? { ...e, title: "renamed", updatedAt: 200 } : e), relations);
  const out = run(current, next);
  assert.equal(out.changed, false);
  assert.deepEqual(out.entities, next.entities);
  assert.deepEqual(out.relations, next.relations);
  assert.deepEqual(out.droppedRelationIds, []);
});

test("idempotent: applying to its own output changes nothing (also against the same current)", () => {
  const current = state([...baseEntities(), ent("t", "task"), ent("mv", "task", "personal", { areaId: "area:b" })],
    [...baseRelations(), rel("r:mv-a", "mv", "area:a", "belongs_to_area"), rel("r:t-proj", "t", "proj", "belongs_to_project")]);
  const next = state([...current.entities, ent("p2", "project"), ent("s", "task"), ent("area:k", "area", "personal", {})], [
    ...current.relations.filter((r) => r.id !== "r:t-proj"), rel("r:mv-proj", "mv", "proj", "belongs_to_project"),
    rel("r:s-a", "s", "area:a", "belongs_to_area", "personal", 70), rel("r:s-b", "s", "area:b", "belongs_to_area", "personal", 71),
  ]);
  const once = run(current, next);
  assert.equal(once.changed, true);
  for (const against of [current, state(once.entities, once.relations)]) {
    const twice = run(against, state(once.entities, once.relations), [...once.droppedRelationIds.map((id) => ({ id }))]);
    assert.deepEqual(twice.entities, once.entities);
    assert.deepEqual(twice.relations, once.relations);
    assert.deepEqual(twice.droppedRelationIds, []);
  }
});

test("deterministic and independent of input order", () => {
  const current = state([workspace("personal", "personal"), workspace("team", "shared"), ent("area:a", "area", "personal", { kind: "private" })], []);
  const items = [ent("p", "project"), ent("t1", "task"), ent("t2", "task"), ent("sp", "project", "team"), ent("st", "task", "team", { areaId: "area:team" }), ent("area:team", "area", "team", { kind: "shared" })];
  const links = [rel("r1", "t1", "area:a", "belongs_to_area", "personal", 70), rel("r2", "t1", "area:a", "belongs_to_area", "personal", 71)];
  const forward = run(current, state([...current.entities, ...items], links));
  const backward = run(current, state([...current.entities, ...[...items].reverse()], [...links].reverse()));
  assert.deepEqual(byId(backward.entities), byId(forward.entities));
  assert.deepEqual(byId(backward.relations), byId(forward.relations));
  assert.deepEqual(backward.droppedRelationIds, forward.droppedRelationIds);
  assert.deepEqual(backward.report, forward.report);
});

test("the report carries counts only, never titles or IDs", () => {
  const current = state([workspace("personal", "personal")], []);
  const out = run(current, state([...current.entities, ent("secret-id", "task", "personal", {}, { title: "SECRET" })], []));
  const text = JSON.stringify(out.report);
  assert.doesNotMatch(text, /SECRET|secret-id/);
  assert.ok(Object.values(out.report).every((value) => Number.isInteger(value)));
});

test("workspaces of unknown kind are skipped (no fallback invented), personal is implicit", () => {
  const current = state([], []);
  const next = state([ent("t", "task", "personal"), ent("x", "task", "ghost")], []);
  const out = run(current, next);
  assert.deepEqual(areaLinks(out, "t").map((r) => r.targetEntityId), [FALLBACK]);
  assert.deepEqual(areaLinks(out, "x"), []);
  assert.equal(out.report.fallbackUnavailable, 1);
  assert.equal(workspaceKinds([workspace("team", "shared")]).get("team"), "shared");
  assert.equal(normalizedLabel(" Nezařazeno "), "nezařazeno");
});

test("an output the invariants produced is accepted by the audited planner as already normalized for the touched items", () => {
  const current = state([workspace("personal", "personal")], []);
  const next = state([...current.entities, ent("p", "project"), ent("t", "task"), ent("n", "task", "personal", { areaId: "x" })],
    [rel("r:n", "n", "p", "belongs_to_project")]);
  const out = run(current, next);
  const plan = planAreaNormalization({ entities: out.entities, relations: out.relations, tombstones: [] }, NOW + 1);
  assert.deepEqual(plan.report.addedRelationIds, []);
  assert.deepEqual(plan.report.createdAreaIds, []);
});

test("migratePropertyRelations rule: a legacy areaId on a task in a project is dropped without a task-level link", () => {
  assert.equal(legacyAreaIdBecomesRelation("task", true), false);
  assert.equal(legacyAreaIdBecomesRelation("task", false), true);
  assert.equal(legacyAreaIdBecomesRelation("project", true), true, "only tasks inherit");
  assert.equal(legacyAreaIdBecomesRelation("project", false), true);
});

test("deleting a project: member tasks lose the dangling projectId and get the fallback Area; untouched dangling ones stay", () => {
  const members = [ent("m1", "task", "personal", { projectId: "proj" }), ent("m2", "task", "personal")];
  const stale = ent("stale", "task", "personal", { projectId: "ghost" });
  const current = state([...baseEntities(), ...members, stale], [...baseRelations(), rel("r:m2", "m2", "proj", "belongs_to_project")]);
  const next = state(current.entities.filter((e) => e.id !== "proj"), current.relations.filter((r) => r.sourceEntityId !== "proj" && r.targetEntityId !== "proj"));
  const out = run(current, next);
  assert.equal("projectId" in entity(out, "m1").properties, false);
  assert.deepEqual(areaLinks(out, "m1").map((r) => r.targetEntityId), [FALLBACK]);
  assert.deepEqual(areaLinks(out, "m2").map((r) => r.targetEntityId), [FALLBACK]);
  assert.equal(entity(out, "stale").properties.projectId, "ghost", "legacy dangling reference of an untouched task");
  assert.deepEqual(areaLinks(out, "stale"), []);
  const plan = planAreaNormalization({ entities: out.entities.filter((e) => e.id !== "stale"), relations: out.relations, tombstones: [] }, NOW + 1);
  assert.deepEqual(plan.report.addedRelationIds, []);
});

test("R4 newly assigned Area replaces the old one despite skewed clocks", () => {
  const current = state([...baseEntities(), ent("t", "task")], [rel("r:old", "t", "area:a", "belongs_to_area", "personal", 9_999_999)]);
  const next = state(current.entities, [...current.relations, rel("r:new", "t", "area:b", "belongs_to_area", "personal", 70)]);
  const out = run(current, next);
  assert.deepEqual(out.droppedRelationIds, ["r:old"], "the old link must be tombstoned when a new assignment arrives");
  assert.deepEqual(areaLinks(out, "t").map((link) => link.targetEntityId), ["area:b"]);
});

test("the workspace kind comes from the stored record: redeclaring shared as personal creates no private fallback", () => {
  const current = state([workspace("personal", "personal"), workspace("team", "shared")], []);
  const next = state([workspace("personal", "personal"), workspace("team", "personal"), ent("t", "task", "team")], []);
  const out = run(current, next);
  assert.equal(entity(out, generatedAreaId("team", "Nezařazeno")), undefined);
  assert.deepEqual(areaLinks(out, "t").map((r) => r.targetEntityId), [SHARED_FALLBACK]);
});

test("many join/leave cycles never leave the task unassigned", () => {
  const taken = new Set();
  for (let cycle = 0; cycle < 25; cycle += 1) {
    const id = fallbackRelationId("t", FALLBACK, (candidate) => taken.has(candidate));
    assert.ok(id, "cycle " + cycle);
    taken.add(id);
  }
  assert.equal(taken.size, 25);
});

test("isFallbackArea identifies the system Area exactly as planFallbackArea does", () => {
  const all = [workspace("personal", "personal"), workspace("team", "shared")];
  const generated = ent(FALLBACK, "area", "personal", { kind: "private" }, { title: "renamed away" });
  assert.equal(isFallbackArea(generated, [...all, generated]), true, "the deterministic ID");
  const unique = ent("area:mine", "area", "personal", { kind: "private" }, { title: " nezařazeno " });
  assert.equal(isFallbackArea(unique, [...all, unique]), true, "the unique active Area with the label");
  const twin = ent("area:twin", "area", "personal", { kind: "private" }, { title: "Nezařazeno" });
  assert.equal(isFallbackArea(unique, [...all, unique, twin]), false, "ambiguous label");
  assert.equal(isFallbackArea({ ...unique, status: "archived" }, [...all, { ...unique, status: "archived" }]), false);
  const other = ent("area:a", "area", "personal", { kind: "private" });
  assert.equal(isFallbackArea(other, [...all, other]), false);
  const shared = ent("area:s", "area", "team", { kind: "shared" }, { title: "Nezařazeno" });
  assert.equal(isFallbackArea(shared, [...all, shared]), false, "the shared workspace's fallback is the (původní sdílené) one");
  assert.equal(isFallbackArea(ent("t", "task"), all), false);
});
