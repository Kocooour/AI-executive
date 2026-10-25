import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../lib/sha256.ts";
import {
  encodeOfflineRecoveryFile, decodeOfflineRecoveryFile, offlineRecoveryFile,
} from "../lib/d2b-offline-recovery-file.ts";
import {
  prepareOfflineRecovery, OfflineRecoveryInvalid,
} from "../lib/d2b-offline-reconciliation.ts";

const ownerEntity = (title) => ({
  id: "task-1", type: "task", title, status: "open", workspaceId: "shared-legacy",
  properties: { today: true }, createdAt: 1, updatedAt: 2,
});
const input = () => ({
  base: { entities: [ownerEntity("Private original")], relations: [] },
  local: { entities: [ownerEntity("Changed locally: private")], relations: [] },
  pendingDeletedIds: [], pendingRevivedIds: [],
  noteDrafts: [{ page: "tab-a", id: "task-1", text: "Neodeslaná soukromá poznámka", base: "", at: 3 }],
  projectContextDrafts: [],
  pendingSync: true, oldRestoreGeneration: 1, newRestoreGeneration: 2, baseRevision: 7,
});
const remote = () => ({
  restoreGeneration: 2, entities: [ownerEntity("Changed on server")], relations: [],
});
const bundle = () => prepareOfflineRecovery(input(), 8);

test("D2b: local rescue file round-trips as UTF-8 without importing any changes", () => {
  const original = bundle();
  const server = remote();
  const serverBefore = JSON.stringify(server);
  const bytes = encodeOfflineRecoveryFile(original);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.byteLength > JSON.stringify(original).length, "UTF-8 may use more bytes than JS characters");
  const { bundle: decoded, assessment } = decodeOfflineRecoveryFile(bytes, server);
  assert.deepEqual(decoded, original);
  assert.equal(assessment.status, "manual-review-required");
  assert.equal(assessment.automaticReplayAllowed, false);
  assert.equal(assessment.requiresSeparateMembershipReview, true);
  assert.deepEqual(assessment.candidates, [
    { id: "task-1", kind: "entity", reason: "remote-diverged" },
  ]);
  assert.equal(JSON.stringify(server), serverBefore, "the server snapshot is never modified");
  assert.equal(offlineRecoveryFile.filename, "lumi-offline-recovery.json");
  assert.ok(offlineRecoveryFile.mimeType.startsWith("application/json"));
});

test("D2b: imported file checksum and server generation must be valid", () => {
  const bytes = encodeOfflineRecoveryFile(bundle());
  assert.throws(() => decodeOfflineRecoveryFile(bytes, { ...remote(), restoreGeneration: 1 }), OfflineRecoveryInvalid);
  const text = new TextDecoder().decode(bytes);
  const changed = new TextEncoder().encode(text.replace("Neodeslaná soukromá poznámka", "Pozměněná soukromá poznámka"));
  assert.throws(() => decodeOfflineRecoveryFile(changed, remote()), OfflineRecoveryInvalid);
});

test("D2b: a rehashed but structurally invalid file is still rejected", () => {
  const original = bundle();
  const forged = { ...original, changes: { ...original.changes, entities: [null] } };
  const { contentSha256: ignored, ...withoutHash } = forged;
  const bytes = new TextEncoder().encode(JSON.stringify({
    ...withoutHash, contentSha256: sha256Hex(JSON.stringify(withoutHash)),
  }));
  assert.throws(() => decodeOfflineRecoveryFile(bytes, remote()), OfflineRecoveryInvalid);
  assert.throws(() => encodeOfflineRecoveryFile(forged), OfflineRecoveryInvalid);
});

test("D2b: invalid UTF-8, non-JSON, empty and oversized files fail closed", () => {
  assert.throws(() => decodeOfflineRecoveryFile(Uint8Array.of(0xc3, 0x28), remote()), OfflineRecoveryInvalid);
  assert.throws(() => decodeOfflineRecoveryFile(new TextEncoder().encode("not JSON"), remote()), OfflineRecoveryInvalid);
  assert.throws(() => decodeOfflineRecoveryFile(new Uint8Array(), remote()), OfflineRecoveryInvalid);
  assert.throws(() =>
    decodeOfflineRecoveryFile(new Uint8Array(offlineRecoveryFile.maxUtf8Bytes + 1), remote()),
    OfflineRecoveryInvalid);
});

test("D2b: codec does not consume or mutate its caller's bundle", () => {
  const value = bundle();
  const before = JSON.stringify(value);
  const a = encodeOfflineRecoveryFile(value);
  const b = encodeOfflineRecoveryFile(value);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(value), before);
  const parsed = decodeOfflineRecoveryFile(a, remote());
  parsed.bundle.changes.noteDrafts[0].text = "After import, mutable caller copy";
  assert.equal(JSON.stringify(value), before, "imported data must be detached from exporter data");
});

test("D2b: structurally malformed source and non-buffer input fail closed", () => {
  assert.throws(() => encodeOfflineRecoveryFile(null), OfflineRecoveryInvalid);
  assert.throws(() => decodeOfflineRecoveryFile("a private string", remote()), OfflineRecoveryInvalid);
  assert.throws(() => decodeOfflineRecoveryFile(new TextEncoder().encode("null"), remote()), OfflineRecoveryInvalid);
});
