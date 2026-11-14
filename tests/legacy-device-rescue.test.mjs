import assert from "node:assert/strict";
import test from "node:test";

const { detectLegacyPending, createLegacyLocalCopy } = await import("../lib/legacy-device-rescue.ts");
const item = (id, updatedAt = 1, title = id) => ({
  id, type: "task", title, status: "open", workspaceId: "personal",
  properties: { inbox: true }, createdAt: 1, updatedAt,
});
const empty = () => ({
  local: { entities: [], relations: [] },
  base: { entities: [], relations: [] },
  markers: { pendingDeletedIds: [], pendingRevivedIds: [], pendingSync: false },
  drafts: { noteDrafts: [], projectContextDrafts: [] },
});

test("clean legacy device has no pending work", () => {
  assert.deepEqual(detectLegacyPending(empty()), { pending: false, count: 0, atLeast: false });
});

test("detects unsent entity edits, relation edits, deleted/revived markers and held-back records", () => {
  const input = empty();
  input.base.entities.push(item("task", 1, "old"));
  input.local.entities.push(item("task", 2, "unsent"), { ...item("held"), title: "" });
  input.markers.pendingDeletedIds.push("deleted-task");
  input.markers.pendingRevivedIds.push("revived-task");
  assert.deepEqual(detectLegacyPending(input), { pending: true, count: 4, atLeast: false });
  const bundle = createLegacyLocalCopy(input, 1234);
  assert.equal(bundle.local.entities[0].title, "unsent");
  assert.equal(bundle.automaticReplayAllowed, false);
  assert.deepEqual(bundle.pendingDeletedIds, ["deleted-task"]);
  assert.deepEqual(bundle.pendingRevivedIds, ["revived-task"]);
});

test("keeps drafts and pending-only markers; no sync base errs toward preserving data", () => {
  const input = empty();
  input.drafts.noteDrafts.push({ storageKey: "note:a", rawValue: "unsent note" });
  input.drafts.projectContextDrafts.push({ storageKey: "context:b", rawValue: "unsent context" });
  assert.equal(detectLegacyPending(input).count, 2);
  input.drafts.noteDrafts = [];
  input.drafts.projectContextDrafts = [];
  input.markers.pendingSync = true;
  assert.deepEqual(detectLegacyPending(input), { pending: true, count: 1, atLeast: true });
  input.markers.pendingSync = false;
  input.base = null;
  input.local.entities.push(item("local-only"));
  assert.deepEqual(detectLegacyPending(input), { pending: true, count: 1, atLeast: true });
});

test("counts relationships and removes as pending changes even without a marker", () => {
  const input = empty();
  input.base.entities.push(item("removed"));
  const relation = { id: "rel", workspaceId: "personal", sourceEntityId: "a", targetEntityId: "b", relationType: "belongs_to_area", createdAt: 1 };
  input.local.relations.push(relation);
  assert.equal(detectLegacyPending(input).count, 2);
});
