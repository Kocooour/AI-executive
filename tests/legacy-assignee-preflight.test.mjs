import assert from "node:assert/strict";
import test from "node:test";
import { planLegacyOwnerAssignees, LegacyAssigneePreflightBlocked } from "../lib/legacy-assignee-preflight.ts";
import { selectScopedWork } from "../lib/work-read-scope.ts";

const workspace = (id, members = [{ id: "owner", role: "owner" }], kind = "shared") => ({
  id: "workspace:" + id, type: "workspace", workspaceId: id, title: "PRIVATE-WORKSPACE",
  status: "active", properties: { kind, members }, createdAt: 1, updatedAt: 2,
});
const task = (id, workspaceId, status = "open", properties = {}) => ({
  id, type: "task", workspaceId, title: "PRIVATE-TITLE-" + id, status,
  properties: { deadline: "2027-02-12", today: "2026-10-26", when: "2026-11-01",
    priority: 3, areaId: "private-area", ...properties },
  createdAt: 1, updatedAt: 2,
});
const source = () => ({
  revision: 25, restoreGeneration: 4,
  entities: [
    workspace("legacy-shared"),
    workspace("multi-user", [{ id: "owner", role: "owner" }, { id: "partner", role: "editor" }]),
    workspace("personal", [{ id: "owner", role: "owner" }], "personal"),
    task("z-unassigned", "legacy-shared"),
    task("a-unassigned", "legacy-shared", "open", { assigneeUserId: null }),
    task("already-mine", "legacy-shared", "open", { assigneeUserId: "owner" }),
    task("closed", "legacy-shared", "completed"),
    task("private-one", "personal"),
    task("actual-multiuser", "multi-user"),
  ],
});
const plan = (data = source(), ids = ["legacy-shared"]) =>
  planLegacyOwnerAssignees({ source: data, legacySharedWorkspaceIds: ids });

test("2c/1 deterministically drafts only open unassigned owner-only legacy tasks", () => {
  const s = source();
  const original = structuredClone(s);
  const p = plan(s);
  assert.equal(p.phase, "legacy-assignee-preflight-only");
  assert.deepEqual(p.candidateTaskIds, ["a-unassigned", "z-unassigned"]);
  assert.deepEqual(p.counts, {
    ownerOnlyLegacyWorkspaces: 1, openLegacyTasks: 3,
    candidates: 2, alreadyAssignedOwner: 1, nonOpenSkipped: 1,
  });
  assert.equal(p.sourceRevision, 25);
  assert.equal(p.sourceRestoreGeneration, 4);
  assert.equal(p.ownerUserId, "owner");
  assert.equal(p.membershipEvidence, "unverified");
  assert.equal(p.legacyOriginEvidence, "unverified");
  assert.equal(p.canApply, false);
  assert.equal(p.canActivateMyPlan, false);
  assert.equal(p.canEnableSharing, false);
  assert.equal(Object.isFrozen(p), true);
  assert.equal(Object.isFrozen(p.counts), true);
  assert.equal(Object.isFrozen(p.candidateTaskIds), true);
  assert.deepEqual(s, original, "planner never changes task data, timestamps, member list or inputs");
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE-TITLE|PRIVATE-WORKSPACE|deadline|priority|today|when/);
});

test("2c/1 proposal is input-order invariant and preserves canonical IDs", () => {
  const a = source();
  const b = structuredClone(a);
  b.entities.reverse();
  assert.deepEqual(plan(a), plan(b));
  assert.ok(plan(a).candidateTaskIds.every(id => a.entities.some(e => e.id === id)));
});

test("2c/1 candidate preview can preserve all legacy open tasks in future My Plan without touching runtime", () => {
  const s = source();
  const before = selectScopedWork({
    scope: "my-plan", actorUserId: "owner", personalWorkspaceId: "personal",
    authorizedSharedWorkspaceIds: ["legacy-shared"], entities: s.entities, relations: [],
  });
  assert.deepEqual(before.tasks.map(x => x.id).sort(), ["already-mine", "private-one"]);
  const p = plan(s);
  const proposed = new Set(p.candidateTaskIds);
  // A TEST-ONLY projection, deliberately not part of the library's API.
  const hypothetical = s.entities.map(e => proposed.has(e.id)
    ? { ...e, properties: { ...e.properties, assigneeUserId: "owner" } } : e);
  const after = selectScopedWork({
    scope: "my-plan", actorUserId: "owner", personalWorkspaceId: "personal",
    authorizedSharedWorkspaceIds: ["legacy-shared"], entities: hypothetical, relations: [],
  });
  assert.deepEqual(after.tasks.map(x => x.id).sort(), [
    "a-unassigned", "already-mine", "private-one", "z-unassigned",
  ]);
  assert.deepEqual(s.entities.find(e => e.id === "z-unassigned").properties, source().entities[3].properties);
  assert.equal(p.canActivateMyPlan, false, "preview alone never turns on the product scope");
});

test("2c/1 cannot target a real multi-member shared workspace", () => {
  assert.throws(() => plan(source(), ["multi-user"]), LegacyAssigneePreflightBlocked);
  assert.throws(() => plan(source(), ["legacy-shared", "multi-user"]), LegacyAssigneePreflightBlocked);
});

test("2c/1 refuses missing, ambiguous or forged single-owner workspace metadata", () => {
  for (const members of [
    [], [{ id: "partner", role: "owner" }], [{ id: "owner", role: "viewer" }],
    [{ id: "owner", role: "owner" }, { id: "owner", role: "owner" }],
    null, "owner", [{ id: "owner" }],
  ]) {
    const data = source();
    data.entities[0].properties.members = members;
    assert.throws(() => plan(data), LegacyAssigneePreflightBlocked);
  }
  const without = source();
  without.entities = without.entities.filter(e => e.id !== "workspace:legacy-shared");
  assert.throws(() => plan(without), LegacyAssigneePreflightBlocked);
  const archived = source();
  archived.entities[0].status = "archived";
  assert.throws(() => plan(archived), LegacyAssigneePreflightBlocked);
  const privateKind = source();
  privateKind.entities[0].properties.kind = "personal";
  assert.throws(() => plan(privateKind), LegacyAssigneePreflightBlocked);
});

test("2c/1 never replaces a non-owner or malformed existing assignee", () => {
  for (const foreign of ["partner", "", 17, false, [], { id: "owner" }]) {
    const s = source();
    s.entities.find(e => e.id === "z-unassigned").properties.assigneeUserId = foreign;
    assert.throws(() => plan(s), LegacyAssigneePreflightBlocked);
  }
});

test("2c/1 rejects guessed, duplicate, private and unknown legacy workspace sets", () => {
  for (const ids of [[], ["personal"], ["all"], ["unknown"], ["legacy-shared", "legacy-shared"],
    ["legacy-shared", "personal"], [null], [""]]) {
    assert.throws(() => plan(source(), ids), LegacyAssigneePreflightBlocked);
  }
});

test("2c/1 accepts valid counters without claiming snapshot freshness", () => {
  const s = source();
  s.revision = 0;
  s.restoreGeneration = 0;
  const original = structuredClone(s);
  // These values are structurally valid but may be stale; no trusted current
  // revision/generation is available to this diagnostic-only planner.
  const p = plan(s);
  assert.deepEqual(p.candidateTaskIds, ["a-unassigned", "z-unassigned"]);
  assert.equal(p.sourceRevision, 0);
  assert.equal(p.sourceRestoreGeneration, 0);
  assert.equal(p.membershipEvidence, "unverified");
  assert.equal(p.legacyOriginEvidence, "unverified");
  assert.equal(p.canApply, false);
  assert.equal(p.canActivateMyPlan, false);
  assert.deepEqual(s, original);
});

test("2c/1 rejects duplicate IDs, invalid workspace records, revisions and oversized snapshots", () => {
  const duplicate = source();
  duplicate.entities.push(structuredClone(duplicate.entities[3]));
  assert.throws(() => plan(duplicate), LegacyAssigneePreflightBlocked);
  const mismatch = source();
  mismatch.entities[0].id = "workspace:other";
  assert.throws(() => plan(mismatch), LegacyAssigneePreflightBlocked);
  assert.throws(() => plan({ ...source(), revision: -1 }), LegacyAssigneePreflightBlocked);
  assert.throws(() => plan({ ...source(), restoreGeneration: NaN }), LegacyAssigneePreflightBlocked);
  assert.throws(() => plan({ ...source(), entities: new Array(20_001) }), LegacyAssigneePreflightBlocked);
});

test("2c/1 must not show unrelated users' work or private data in a diagnostic", () => {
  const p = plan();
  const json = JSON.stringify(p);
  assert.equal(json.includes("actual-multiuser"), false);
  assert.equal(json.includes("private-one"), false);
  assert.equal(json.includes("closed"), false);
  assert.equal(p.canEnableSharing, false);
});
