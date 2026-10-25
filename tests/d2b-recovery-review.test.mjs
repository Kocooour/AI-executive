import assert from "node:assert/strict";
import test from "node:test";
import { inspectOfflineRecoveryBytes } from "../lib/d2b-recovery-review.ts";
import { prepareOfflineRecovery, OfflineRecoveryInvalid } from "../lib/d2b-offline-reconciliation.ts";
import { encodeOfflineRecoveryFile } from "../lib/d2b-offline-recovery-file.ts";

const entity = (id, title, workspaceId = "personal") => ({
  id, type: "task", title, status: "open", workspaceId,
  properties: {}, createdAt: 1, updatedAt: 2,
});
const hold = (changes = {}) => ({ version: 1, knownGeneration: 1, observedGeneration: 2, createdAt: 5, ...changes });
const rescueInput = () => ({
  base: { entities: [entity("edited", "Private original"), entity("missing", "Prior")], relations: [] },
  local: { entities: [entity("edited", "Private local edit"), entity("missing", "Local only")], relations: [] },
  pendingDeletedIds: [], pendingRevivedIds: [],
  noteDrafts: [{ rawKey: "private", rawValue: "Secret owner draft" }],
  projectContextDrafts: [], pendingSync: true,
  oldRestoreGeneration: 1, newRestoreGeneration: 2, baseRevision: null,
});
const rescue = (overrides = {}, at = 10) => encodeOfflineRecoveryFile(prepareOfflineRecovery({ ...rescueInput(), ...overrides }, at));

test("D2b rescue inspection shows only bounded aggregate diagnostics; never private IDs or text", () => {
  const bytes = rescue();
  const server = {
    restoreGeneration: 2, entities: [entity("edited", "Remote changed")], relations: [],
  };
  const originalServer = JSON.stringify(server);
  const result = inspectOfflineRecoveryBytes(bytes, server, hold());
  assert.equal(result.status, "manual-review-required");
  assert.equal(result.autoResumeAllowed, false);
  assert.equal(result.requiresSeparateMembershipReview, true);
  assert.equal(result.serverGeneration, 2);
  assert.equal(result.counts.entities, 2);
  assert.equal(result.counts.drafts, 1);
  assert.equal(result.totalCandidates, 2);
  assert.equal(result.reasons["remote-diverged"], 1);
  assert.equal(result.reasons["remote-missing"], 1);
  const summaryText = JSON.stringify(result);
  for (const privateValue of ['"id":"edited"', '"id":"missing"', "Secret owner draft", "Private local edit", "Remote changed"])
    assert.equal(summaryText.includes(privateValue), false);
  assert.equal(JSON.stringify(server), originalServer, "inspection must not change server data");
});

test("D2b rescue inspection rejects corrupted file and old server generation", () => {
  const bytes = rescue();
  const server = { restoreGeneration: 2, entities: [], relations: [] };
  assert.throws(() => inspectOfflineRecoveryBytes(
    new TextEncoder().encode(new TextDecoder().decode(bytes).replace("Private local edit", "Altered private")),
    server, hold(),
  ), OfflineRecoveryInvalid);
  assert.throws(() => inspectOfflineRecoveryBytes(bytes, { ...server, restoreGeneration: 1 }, hold()), OfflineRecoveryInvalid);
  assert.throws(() => inspectOfflineRecoveryBytes(new Uint8Array(), server, hold()), OfflineRecoveryInvalid);
});

test("D2b rescue inspection does not treat an empty bundle as authorization to resume", () => {
  const bytes = encodeOfflineRecoveryFile(prepareOfflineRecovery({
    base: { entities: [], relations: [] }, local: { entities: [], relations: [] },
    pendingDeletedIds: [], pendingRevivedIds: [],
    noteDrafts: [], projectContextDrafts: [],
    pendingSync: false, oldRestoreGeneration: 1, newRestoreGeneration: 2, baseRevision: null,
  }, 11));
  const result = inspectOfflineRecoveryBytes(bytes, { restoreGeneration: 2, entities: [], relations: [] }, hold());
  assert.equal(result.status, "no-local-changes");
  assert.equal(result.autoResumeAllowed, false);
  assert.equal(result.requiresSeparateMembershipReview, true);
  assert.equal(result.totalCandidates, 0);
});

test("D2b inspection rejects valid files from another hold or before the hold existed", () => {
  const server = { restoreGeneration: 4, entities: [], relations: [] };
  assert.throws(() => inspectOfflineRecoveryBytes(
    rescue({ oldRestoreGeneration: 0 }), server, hold(),
  ), OfflineRecoveryInvalid, "a valid bundle against another known generation is unrelated");
  assert.throws(() => inspectOfflineRecoveryBytes(
    rescue(), server, hold({ observedGeneration: 3 }),
  ), OfflineRecoveryInvalid, "a file older than the first observed restore cannot be related");
  assert.throws(() => inspectOfflineRecoveryBytes(
    rescue({}, 4), server, hold(),
  ), OfflineRecoveryInvalid, "an export predating the active hold is not a valid comparison");
  assert.throws(() => inspectOfflineRecoveryBytes(
    rescue(), server, hold({ knownGeneration: Number.NaN }),
  ), OfflineRecoveryInvalid, "a malformed active hold is not trustworthy");
  // A later second restore can still be inspected under the SAME initial hold.
  const later = inspectOfflineRecoveryBytes(
    rescue({ newRestoreGeneration: 4 }, 12), server, hold(),
  );
  assert.equal(later.autoResumeAllowed, false);
  assert.equal(later.serverGeneration, 4);
  // Legacy hold with no known generation exports with oldRestoreGeneration = 0.
  const unknownBase = inspectOfflineRecoveryBytes(
    rescue({ oldRestoreGeneration: 0 }, 12), server, hold({ knownGeneration: null }),
  );
  assert.equal(unknownBase.autoResumeAllowed, false);
});

test("D2b breakdown accounts for every classified entity, including already-applied edits", () => {
  const base = ["diverged", "missing", "local", "workspace", "already-deleted"]
    .map((id) => entity(id, "base"));
  const local = [
    entity("diverged", "edited"), entity("missing", "edited"),
    entity("local", "edited"), entity("workspace", "edited"),
    entity("already-present", "new"), entity("collision", "new"),
  ];
  const remote = {
    restoreGeneration: 2,
    entities: [
      entity("diverged", "server"), entity("local", "base"),
      entity("workspace", "server", "other"),
      entity("already-present", "new"), entity("collision", "server"),
    ],
    relations: [],
  };
  const bytes = rescue({
    base: { entities: base, relations: [] }, local: { entities: local, relations: [] },
    noteDrafts: [], pendingSync: true,
  });
  const result = inspectOfflineRecoveryBytes(bytes, remote, hold());
  assert.equal(result.totalCandidates, 7);
  assert.equal(result.counts.entities, 7);
  for (const reason of ["remote-missing", "workspace-changed", "remote-diverged",
    "local-change", "already-present", "id-collision", "already-deleted"])
    assert.equal(result.reasons[reason], 1, reason);
  assert.equal(Object.values(result.reasons).reduce((sum, n) => sum + n, 0), result.totalCandidates);
  assert.equal(result.autoResumeAllowed, false);
});
