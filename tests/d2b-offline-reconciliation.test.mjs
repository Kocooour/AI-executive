import assert from "node:assert/strict";
import test from "node:test";
import { prepareOfflineRecovery, assessOfflineRecovery, OfflineRecoveryInvalid, offlineRecoveryLimits } from "../lib/d2b-offline-reconciliation.ts";
import { sha256Hex } from "../lib/sha256.ts";

const workspace = "shared-legacy";
const entity = (id, title, wid = workspace) => ({
  id, type: "task", title, workspaceId: wid, status: "open",
  properties: { inbox: false, today: false }, createdAt: 10, updatedAt: 20,
});
const relation = (id, target, wid = workspace) => ({
  id, sourceEntityId: "task", targetEntityId: target,
  relationType: "belongs_to_area", workspaceId: wid, createdAt: 10,
});
const initial = () => ({
  base: {
    entities: [entity("task", "My private details"), entity("unchanged", "Same")],
    relations: [relation("area-link", "old-area")],
  },
  local: {
    entities: [entity("task", "Edited private details"), entity("unchanged", "Same"), entity("new", "Brand new")],
    relations: [relation("area-link", "old-area"), relation("extra-link", "another-area")],
  },
  pendingDeletedIds: ["removed-id", "removed-id"],
  pendingRevivedIds: ["revived-id"],
  noteDrafts: [{ id: "task", text: "Draft with sensitive content", page: "a" }],
  projectContextDrafts: [{ projectId: "project", draft: { why: "Private strategy" } }],
  pendingSync: true,
  oldRestoreGeneration: 2, newRestoreGeneration: 3, baseRevision: 41,
});
const prepare = (overrides = {}) => prepareOfflineRecovery({ ...initial(), ...overrides }, 123456);

test("D2b: the offline recovery package captures only deltas, markers and unsent drafts", () => {
  const value = prepare();
  assert.equal(value.format, "lumi-d2b-offline-recovery");
  assert.equal(value.version, 1);
  assert.equal(value.sensitiveOwnerData, true);
  assert.equal(value.automaticReplayAllowed, false);
  assert.equal(value.createdAt, 123456);
  assert.equal(value.baseRevision, 41);
  assert.equal(value.oldRestoreGeneration, 2);
  assert.equal(value.observedRestoreGeneration, 3);
  assert.deepEqual(value.changes.entities.map(x => x.id), ["new", "task"]);
  assert.deepEqual(value.changes.relations.map(x => x.id), ["extra-link"]);
  assert.deepEqual(value.changes.pendingDeletedIds, ["removed-id"]);
  assert.deepEqual(value.changes.pendingRevivedIds, ["revived-id"]);
  assert.equal(value.changes.entities.find(x => x.id === "task").before.title, "My private details");
  assert.equal(value.changes.entities.find(x => x.id === "task").after.title, "Edited private details");
  assert.equal(value.changes.noteDrafts[0].text, "Draft with sensitive content");
  assert.equal(value.changes.projectContextDrafts[0].draft.why, "Private strategy");
  assert.match(value.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(value).includes("Same"), false, "unchanged records are not exported");
});

test("D2b: recovery payload cannot lose data through caller mutation or undefined fields", () => {
  const i = initial();
  const value = prepareOfflineRecovery(i, 100);
  const before = value.contentSha256;
  i.local.entities[0].title = "Later edit";
  i.noteDrafts[0].text = "Later different draft";
  assert.equal(value.changes.entities.find(x => x.id === "task").after.title, "Edited private details");
  assert.equal(value.changes.noteDrafts[0].text, "Draft with sensitive content");
  assert.equal(value.contentSha256, before);
  assert.throws(() => prepare({ noteDrafts: [{ id: "note", text: undefined }] }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({ projectContextDrafts: [{ at: Number.NaN }] }), OfflineRecoveryInvalid);
});

test("D2b: baseline-only removals and changed relations remain recoverable", () => {
  const start = initial();
  const value = prepare({
    base: start.base,
    local: { entities: [entity("task", "My private details")], relations: [relation("area-link", "new-area")] },
    pendingDeletedIds: [],
    pendingRevivedIds: [],
    noteDrafts: [], projectContextDrafts: [], pendingSync: true,
  });
  assert.deepEqual(value.changes.entities.map(x => x.id), ["unchanged"]);
  assert.equal(value.changes.entities[0].after, null);
  assert.equal(value.changes.entities[0].before.title, "Same");
  assert.equal(value.changes.relations.length, 1);
  assert.equal(value.changes.relations[0].before.targetEntityId, "old-area");
  assert.equal(value.changes.relations[0].after.targetEntityId, "new-area");
});

test("D2b: same input in different order produces the same content digest", () => {
  const i = initial();
  const first = prepareOfflineRecovery(i, 42);
  const second = prepareOfflineRecovery({
    ...i,
    base: { entities: [...i.base.entities].reverse(), relations: i.base.relations },
    local: { entities: [...i.local.entities].reverse(), relations: [...i.local.relations].reverse() },
    pendingDeletedIds: [...i.pendingDeletedIds].reverse(),
  }, 42);
  assert.deepEqual(first, second);
});

test("D2b: new restore generation and non-contradictory markers are mandatory", () => {
  assert.throws(() => prepare({ newRestoreGeneration: 2 }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({ oldRestoreGeneration: -1 }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({ pendingDeletedIds: ["x"], pendingRevivedIds: ["x"] }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({ pendingDeletedIds: [""] }), OfflineRecoveryInvalid);
  const i = initial();
  assert.throws(() => prepare({ local: { ...i.local, entities: [...i.local.entities, i.local.entities[0]] } }), OfflineRecoveryInvalid);
});

test("D2b: manual reconciliation identifies scope movement and concurrent server edits without replay", () => {
  const bundle = prepare();
  const remote = {
    restoreGeneration: 3,
    entities: [
      entity("task", "Edited by another device", "new-shared-workspace"),
      entity("unchanged", "Same"),
      entity("new", "Brand new", "new-shared-workspace"),
    ],
    relations: [relation("extra-link", "another-area", "new-shared-workspace")],
  };
  const before = JSON.stringify(remote);
  const report = assessOfflineRecovery(bundle, remote);
  assert.equal(report.status, "manual-review-required");
  assert.equal(report.automaticReplayAllowed, false);
  assert.equal(report.requiresSeparateMembershipReview, true);
  assert.deepEqual(report.counts, { entities: 2, relations: 1, deletions: 1, revivals: 1, drafts: 2 });
  assert.deepEqual(report.candidates, [
    { id: "new", kind: "entity", reason: "workspace-changed" },
    { id: "task", kind: "entity", reason: "workspace-changed" },
    { id: "extra-link", kind: "relation", reason: "workspace-changed" },
  ]);
  assert.equal(JSON.stringify(remote), before, "no replay or mutations");
});

test("D2b: even identical remaining data must not authorize silent deletion or revival", () => {
  const i = initial();
  const clean = prepareOfflineRecovery({
    ...i, local: i.base, pendingSync: false,
    pendingDeletedIds: [], pendingRevivedIds: [], noteDrafts: [], projectContextDrafts: [],
  }, 99);
  const report = assessOfflineRecovery(clean, { restoreGeneration: 3, ...i.base });
  assert.equal(report.status, "no-local-changes");
  assert.equal(report.automaticReplayAllowed, false);
  assert.deepEqual(report.candidates, []);
  const changesOnly = prepareOfflineRecovery({
    ...i, local: i.base, pendingSync: false, pendingDeletedIds: ["removed"], pendingRevivedIds: [],
    noteDrafts: [], projectContextDrafts: [],
  }, 99);
  assert.equal(assessOfflineRecovery(changesOnly, { restoreGeneration: 3, ...i.base }).status, "manual-review-required");
});

test("D2b: tampered owner recovery bundle and rolled-back generation are rejected", () => {
  const bundle = prepare();
  const remote = { restoreGeneration: 3, ...initial().local };
  const forged = { ...bundle, changes: { ...bundle.changes, pendingDeletedIds: ["other-record"] } };
  assert.throws(() => assessOfflineRecovery(forged, remote), OfflineRecoveryInvalid);
  assert.throws(() => assessOfflineRecovery(bundle, { ...remote, restoreGeneration: 2 }), OfflineRecoveryInvalid);
});

test("D2b: same-scope new IDs with different remote payloads are collisions, including relations", () => {
  const i = initial();
  const bundle = prepareOfflineRecovery(i, 99);
  const server = {
    restoreGeneration: 3,
    entities: [
      entity("new", "Different owner's existing ID"),
      entity("task", "Edited private details"),
    ],
    relations: [relation("extra-link", "different-area")],
  };
  const r = assessOfflineRecovery(bundle, server);
  assert.deepEqual(r.candidates.filter((x) => x.reason === "id-collision"), [
    { id: "new", kind: "entity", reason: "id-collision" },
    { id: "extra-link", kind: "relation", reason: "id-collision" },
  ]);
  assert.equal(r.automaticReplayAllowed, false);
});

test("D2b: already applied deletions are not misreported as remote-missing", () => {
  const i = initial();
  const bundle = prepareOfflineRecovery({
    ...i,
    local: { entities: [entity("task", "My private details")], relations: [] },
    pendingDeletedIds: ["unchanged", "area-link"],
    pendingRevivedIds: [], noteDrafts: [], projectContextDrafts: [], pendingSync: true,
  }, 99);
  const r = assessOfflineRecovery(bundle, {
    restoreGeneration: 3,
    entities: [entity("task", "My private details")],
    relations: [],
  });
  assert.deepEqual(r.candidates, [
    { id: "unchanged", kind: "entity", reason: "already-deleted" },
    { id: "area-link", kind: "relation", reason: "already-deleted" },
  ]);
  assert.equal(r.automaticReplayAllowed, false);
});

test("D2b: shared namespace rejects entity/relation collisions in both snapshots", () => {
  const i = initial();
  assert.throws(() => prepare({
    base: { ...i.base, relations: [...i.base.relations, relation("task", "old-area")] },
  }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({
    local: { ...i.local, relations: [...i.local.relations, relation("new", "another-area")] },
  }), OfflineRecoveryInvalid);
});

test("D2b: rejects oversized drafts, markers and snapshots without touching sources", () => {
  const i = initial();
  const before = JSON.stringify(i);
  const bigDraft = { text: "x".repeat(offlineRecoveryLimits.maxDraftJsonChars + 1) };
  assert.throws(() => prepare({ noteDrafts: [bigDraft] }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({ projectContextDrafts: [bigDraft] }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({
    noteDrafts: Array.from({ length: offlineRecoveryLimits.maxDraftsPerKind + 1 }, () => ({})),
  }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({
    pendingDeletedIds: Array.from({ length: offlineRecoveryLimits.maxMarkersPerKind + 1 },
      (_, index) => "delete-" + index),
  }), OfflineRecoveryInvalid);
  assert.throws(() => prepare({
    local: {
      ...i.local,
      entities: Array.from({ length: offlineRecoveryLimits.maxEntitiesPerSnapshot + 1 },
        (_, index) => entity("task-" + index, "short")),
    },
  }), OfflineRecoveryInvalid);
  assert.equal(JSON.stringify(i), before, "overlimit rescue never mutates source records, drafts or markers");
});

test("D2b: rejects oversized serialized rescue atomically without silent truncation", () => {
  const largeText = "x".repeat(180 * 1024);
  const baseline = Array.from({ length: 25 }, (_, index) =>
    entity("large-" + index, "old-" + largeText));
  const local = baseline.map((item) => ({ ...item, title: "new-" + largeText }));
  assert.throws(() => prepare({
    base: { entities: baseline, relations: [] },
    local: { entities: local, relations: [] },
    noteDrafts: [], projectContextDrafts: [],
    pendingDeletedIds: [], pendingRevivedIds: [],
  }), OfflineRecoveryInvalid);
  assert.equal(baseline[0].title, "old-" + largeText);
  assert.equal(local[0].title, "new-" + largeText);
});

test("D2b: divergent remote content remains manual review even when Area does not change", () => {
  const bundle = prepare();
  const remote = { restoreGeneration: 3, entities: [entity("task", "Server edited instead")], relations: [] };
  const report = assessOfflineRecovery(bundle, remote);
  assert.ok(report.candidates.some(x => x.id === "task" && x.reason === "remote-diverged"));
  assert.ok(report.candidates.some(x => x.id === "new" && x.reason === "remote-missing"));
});
