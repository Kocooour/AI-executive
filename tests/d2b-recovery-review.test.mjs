import assert from "node:assert/strict";
import test from "node:test";
import { inspectOfflineRecoveryBytes } from "../lib/d2b-recovery-review.ts";
import { prepareOfflineRecovery, OfflineRecoveryInvalid } from "../lib/d2b-offline-reconciliation.ts";
import { encodeOfflineRecoveryFile } from "../lib/d2b-offline-recovery-file.ts";

const entity = (id, title, workspaceId = "personal") => ({
  id, type: "task", title, status: "open", workspaceId,
  properties: {}, createdAt: 1, updatedAt: 2,
});
const rescue = () => encodeOfflineRecoveryFile(prepareOfflineRecovery({
  base: { entities: [entity("edited", "Private original"), entity("missing", "Prior")], relations: [] },
  local: { entities: [entity("edited", "Private local edit"), entity("missing", "Local only")], relations: [] },
  pendingDeletedIds: [], pendingRevivedIds: [],
  noteDrafts: [{ rawKey: "private", rawValue: "Secret owner draft" }],
  projectContextDrafts: [], pendingSync: true,
  oldRestoreGeneration: 1, newRestoreGeneration: 2, baseRevision: null,
}, 10));

test("D2b rescue inspection shows only bounded aggregate diagnostics; never private IDs or text", () => {
  const bytes = rescue();
  const server = {
    restoreGeneration: 2, entities: [entity("edited", "Remote changed")], relations: [],
  };
  const originalServer = JSON.stringify(server);
  const result = inspectOfflineRecoveryBytes(bytes, server);
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
  for (const privateValue of ["edited", "missing", "Secret owner draft", "Private local edit", "Remote changed"])
    assert.equal(summaryText.includes(privateValue), false);
  assert.equal(JSON.stringify(server), originalServer, "inspection must not change server data");
});

test("D2b rescue inspection rejects corrupted file and old server generation", () => {
  const bytes = rescue();
  const server = { restoreGeneration: 2, entities: [], relations: [] };
  assert.throws(() => inspectOfflineRecoveryBytes(
    new TextEncoder().encode(new TextDecoder().decode(bytes).replace("Private local edit", "Altered private")),
    server,
  ), OfflineRecoveryInvalid);
  assert.throws(() => inspectOfflineRecoveryBytes(bytes, { ...server, restoreGeneration: 1 }), OfflineRecoveryInvalid);
  assert.throws(() => inspectOfflineRecoveryBytes(new Uint8Array(), server), OfflineRecoveryInvalid);
});

test("D2b rescue inspection does not treat an empty bundle as authorization to resume", () => {
  const bytes = encodeOfflineRecoveryFile(prepareOfflineRecovery({
    base: { entities: [], relations: [] }, local: { entities: [], relations: [] },
    pendingDeletedIds: [], pendingRevivedIds: [],
    noteDrafts: [], projectContextDrafts: [],
    pendingSync: false, oldRestoreGeneration: 1, newRestoreGeneration: 2, baseRevision: null,
  }, 11));
  const result = inspectOfflineRecoveryBytes(bytes, { restoreGeneration: 2, entities: [], relations: [] });
  assert.equal(result.status, "no-local-changes");
  assert.equal(result.autoResumeAllowed, false);
  assert.equal(result.requiresSeparateMembershipReview, true);
  assert.equal(result.totalCandidates, 0);
});
