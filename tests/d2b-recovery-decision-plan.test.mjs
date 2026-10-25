import assert from "node:assert/strict";
import test from "node:test";
import { draftOfflineRecoveryDecisions, preferOfflineRecoveryOutcome } from "../lib/d2b-recovery-decision-plan.ts";
import { OfflineRecoveryInvalid, prepareOfflineRecovery } from "../lib/d2b-offline-reconciliation.ts";
import { encodeOfflineRecoveryFile } from "../lib/d2b-offline-recovery-file.ts";

const entity = (id, title, wid = "personal") => ({
  id, type: "task", title, status: "open", workspaceId: wid,
  properties: {}, createdAt: 1, updatedAt: 2,
});
const hold = (extra = {}) => ({
  version: 1, knownGeneration: 1, observedGeneration: 2, createdAt: 5, ...extra,
});
const blank = () => ({
  base: { entities: [], relations: [] }, local: { entities: [], relations: [] },
  pendingDeletedIds: [], pendingRevivedIds: [], noteDrafts: [],
  projectContextDrafts: [], pendingSync: false,
  oldRestoreGeneration: 1, newRestoreGeneration: 2, baseRevision: 1,
});
const rescue = (changes = {}) =>
  encodeOfflineRecoveryFile(prepareOfflineRecovery({ ...blank(), ...changes }, 10));
const server = (entities = [], relations = [], extra = {}) => ({
  restoreGeneration: 2, revision: 15, entities, relations, ...extra,
});

test("D2b/6 produces only a local draft; neither clean nor matching data releases the hold", () => {
  const s = server();
  const before = JSON.stringify(s);
  const p = draftOfflineRecoveryDecisions(rescue(), s, hold());
  assert.equal(p.phase, "local-preferences-only");
  assert.equal(p.identity, "unverified");
  assert.equal(p.membership, "unverified");
  assert.equal(p.areaPermission, "unverified");
  assert.equal(p.consent, "not-requested");
  assert.equal(p.automaticReplayAllowed, false);
  assert.equal(p.canApply, false);
  assert.equal(p.canReleaseHold, false);
  assert.equal(p.serverRevision, 15);
  assert.deepEqual(p.candidates, []);
  assert.equal(p.unresolvedNonRecordWork, false);
  assert.equal(JSON.stringify(s), before);
});

test("D2b/6 keeps private titles, raw drafts and record bodies out of decision entries", () => {
  const bytes = rescue({
    base: { entities: [entity("private-record", "Original secret")], relations: [] },
    local: { entities: [entity("private-record", "Local private secret")], relations: [] },
    noteDrafts: [{ rawKey: "private-draft", rawValue: "Hidden draft body" }],
    pendingDeletedIds: ["delete-private"], pendingSync: true,
  });
  const s = server([entity("private-record", "Original secret")]);
  const old = JSON.stringify(s);
  const p = draftOfflineRecoveryDecisions(bytes, s, hold());
  assert.deepEqual(p.candidates.map(({id,reason,preference}) => ({id,reason,preference})), [
    { id: "private-record", reason: "local-change", preference: "defer" },
  ]);
  assert.equal(p.unresolvedNonRecordWork, true);
  assert.equal(p.counts.drafts, 1);
  assert.equal(p.counts.deletions, 1);
  const serialized = JSON.stringify(p);
  for (const secret of ["Original secret", "Local private secret", "Hidden draft body", "private-draft", "delete-private"])
    assert.equal(serialized.includes(secret), false);
  assert.equal(JSON.stringify(s), old);
});

test("D2b/6 suggests choices only in volatile memory; conflict stays unresolved", () => {
  const bytes = rescue({
    base: { entities: [entity("conflict", "Before")], relations: [] },
    local: { entities: [entity("conflict", "Owner new")], relations: [] },
  });
  const p = draftOfflineRecoveryDecisions(bytes, server([entity("conflict", "Server new")]), hold());
  assert.equal(p.candidates[0].reason, "remote-diverged");
  const suggested = preferOfflineRecoveryOutcome(p, "entity", "conflict", "prefer-local");
  assert.equal(suggested.candidates[0].preference, "prefer-local");
  assert.equal(p.candidates[0].preference, "defer", "original input is immutable");
  assert.equal(suggested.canApply, false);
  assert.equal(suggested.consent, "not-requested");
  assert.equal(suggested.canReleaseHold, false);
  assert.throws(() => preferOfflineRecoveryOutcome(suggested, "relation", "conflict", "prefer-server"), OfflineRecoveryInvalid);
  assert.throws(() => preferOfflineRecoveryOutcome(suggested, "entity", "missing", "defer"), OfflineRecoveryInvalid);
});

test("D2b/6 refuses value preferences for cross-kind ID collisions and workspace moves", () => {
  const relation = (id, wid = "personal") => ({
    id, sourceEntityId: "source", targetEntityId: "target",
    relationType: "belongs_to_area", workspaceId: wid, createdAt: 1,
  });
  const bytes = rescue({
    base: { entities: [entity("moved", "Before")], relations: [] },
    local: {
      entities: [entity("moved", "Locally edited"), entity("collision", "New local")],
      relations: [],
    },
  });
  const p = draftOfflineRecoveryDecisions(bytes, server([
    entity("moved", "Remote", "shared"),
  ], [relation("collision")]), hold());
  assert.deepEqual(p.candidates.map(x => [x.id, x.reason, x.availablePreferences]), [
    ["collision", "id-collision", ["defer"]],
    ["moved", "workspace-changed", ["defer"]],
  ]);
  for (const id of ["collision", "moved"]) {
    assert.throws(() => preferOfflineRecoveryOutcome(p, "entity", id, "prefer-local"), OfflineRecoveryInvalid);
    assert.throws(() => preferOfflineRecoveryOutcome(p, "entity", id, "prefer-server"), OfflineRecoveryInvalid);
  }
  assert.equal(p.areaPermission, "unverified");
});

test("D2b/6 cannot mistake already-applied work for permission to finish the restore", () => {
  const bytes = rescue({
    base: { entities: [entity("removed", "Prior")], relations: [] },
    local: { entities: [], relations: [] },
    pendingRevivedIds: ["revive-other"],
  });
  const p = draftOfflineRecoveryDecisions(bytes, server(), hold());
  assert.equal(p.candidates[0].reason, "already-deleted");
  assert.deepEqual(p.candidates[0].availablePreferences, ["defer", "prefer-server"]);
  assert.equal(p.unresolvedNonRecordWork, true);
  const q = preferOfflineRecoveryOutcome(p, "entity", "removed", "prefer-server");
  assert.equal(q.canReleaseHold, false);
  assert.equal(q.canApply, false);
});

test("D2b/6 fails closed on foreign hold, corrupt content, missing server revision or stale generation", () => {
  const bytes = rescue();
  const s = server();
  assert.throws(() => draftOfflineRecoveryDecisions(bytes, s, hold({ knownGeneration: 0 })), OfflineRecoveryInvalid);
  assert.throws(() => draftOfflineRecoveryDecisions(bytes, s, hold({ createdAt: 11 })), OfflineRecoveryInvalid);
  assert.throws(() => draftOfflineRecoveryDecisions(bytes, server([], [], { revision: undefined }), hold()), OfflineRecoveryInvalid);
  assert.throws(() => draftOfflineRecoveryDecisions(bytes, server([], [], { revision: -1 }), hold()), OfflineRecoveryInvalid);
  assert.throws(() => draftOfflineRecoveryDecisions(bytes, server([], [], { restoreGeneration: 1 }), hold()), OfflineRecoveryInvalid);
  const corrupted = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('"automaticReplayAllowed":false', '"automaticReplayAllowed":true'));
  assert.throws(() => draftOfflineRecoveryDecisions(corrupted, s, hold()), OfflineRecoveryInvalid);
});

test("D2b/6 rejects tampered plan safety fields even when expressing a preference", () => {
  const p = draftOfflineRecoveryDecisions(rescue({
    local: { entities: [entity("new", "New")], relations: [] },
  }), server(), hold());
  assert.throws(() => preferOfflineRecoveryOutcome({ ...p, canApply: true }, "entity", "new", "defer"), OfflineRecoveryInvalid);
  assert.throws(() => preferOfflineRecoveryOutcome({ ...p, membership: "verified" }, "entity", "new", "defer"), OfflineRecoveryInvalid);
});
