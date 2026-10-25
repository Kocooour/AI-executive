import assert from "node:assert/strict";
import test from "node:test";
import { offlineRecoveryHoldKey, beginOfflineRecoveryHold, offlineRecoveryIsHeld, parseOfflineRecoveryHold, readOfflineRecoveryHold } from "../lib/d2b-recovery-hold.ts";
import { readRawRecoveryDrafts, readRawRecoveryMarkers } from "../lib/d2b-recovery-local.ts";
import { OfflineRecoveryInvalid } from "../lib/d2b-offline-reconciliation.ts";
import { deletedKey, revivedKey, pendingKey } from "../lib/pending-markers.ts";
import { notesDraftsKey } from "../lib/notes-drafts.ts";
import { projectContextDraftPrefix } from "../lib/project-context-drafts.ts";

const storage = (pairs = []) => {
  const data = new Map(pairs);
  return {
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    snapshot() { return [...data.entries()]; },
  };
};

test("D2b: a persisted stop marker is parsed strictly, including legacy and corrupt cases", () => {
  const s = storage();
  assert.equal(offlineRecoveryIsHeld(s), false);
  assert.equal(parseOfflineRecoveryHold(null), null);
  assert.equal(parseOfflineRecoveryHold('{"version":1}'), null);
  assert.equal(parseOfflineRecoveryHold("bad json"), null);
  const hold = beginOfflineRecoveryHold(2, 3, s, 1000);
  assert.deepEqual(hold, { version: 1, knownGeneration: 2, observedGeneration: 3, createdAt: 1000 });
  assert.equal(offlineRecoveryIsHeld(s), true);
  assert.deepEqual(readOfflineRecoveryHold(s), hold);
  assert.deepEqual(beginOfflineRecoveryHold(2, 4, s, 2000), hold, "cannot silently reset sticky recovery metadata");
  assert.ok(s.getItem(offlineRecoveryHoldKey));
  s.setItem(offlineRecoveryHoldKey, "corrupt");
  assert.equal(offlineRecoveryIsHeld(s), true);
  assert.equal(readOfflineRecoveryHold(s), null);
  assert.throws(() => beginOfflineRecoveryHold(2, 4, s), /OFFLINE_RECOVERY_HOLD_CORRUPT/);
});

test("D2b: storage failures keep the in-memory write barrier engaged", () => {
  const broken = { getItem() { throw Error("denied"); }, setItem() { throw Error("denied"); } };
  assert.throws(() => beginOfflineRecoveryHold(1, 2, broken), /OFFLINE_RECOVERY_HOLD_UNAVAILABLE/);
  assert.equal(offlineRecoveryIsHeld(broken), true);
});

test("D2b: capture all draft bytes, including malformed drafts, without modifying localStorage", () => {
  const initial = [
    [notesDraftsKey, "malformed but must be rescued"],
    [notesDraftsKey + ":tab:task", '{"text":"unsaved"}'],
    [projectContextDraftPrefix + ":tab:project", "unparseable owner context"],
    ["unrelated", "private unrelated data"],
  ];
  const s = storage(initial);
  const snap = s.snapshot();
  const result = readRawRecoveryDrafts(s);
  assert.deepEqual(result.noteDrafts.map(x => x.rawValue).sort(), ['{"text":"unsaved"}', "malformed but must be rescued"].sort());
  assert.deepEqual(result.projectContextDrafts.map(x => x.rawValue), ["unparseable owner context"]);
  assert.deepEqual(s.snapshot(), snap);
});

test("D2b: markers are read without migration or silent loss of pending deletion/revival", () => {
  const entries = [
    [deletedKey, '["legacy-delete"]'],
    [deletedKey + ":0000000000010-tab-1", "same-record"],
    [revivedKey + ":0000000000020-tab-1", "same-record"],
    [revivedKey + ":0000000000030-tab-1", "another-record"],
    [pendingKey, "1"],
  ];
  const s = storage(entries);
  const before = s.snapshot();
  assert.deepEqual(readRawRecoveryMarkers(s), {
    pendingDeletedIds: ["legacy-delete"],
    pendingRevivedIds: ["another-record", "same-record"],
    pendingSync: true,
  });
  assert.deepEqual(s.snapshot(), before);
});

test("D2b: corrupt legacy markers and contradictory intents fail closed", () => {
  assert.throws(() => readRawRecoveryMarkers(storage([[deletedKey, "invalid json"]])), OfflineRecoveryInvalid);
  assert.throws(() => readRawRecoveryMarkers(storage([[deletedKey, "[null]"]])), OfflineRecoveryInvalid);
  assert.throws(() => readRawRecoveryMarkers(storage([
    [deletedKey, '["id"]'], [revivedKey, '["id"]'],
  ])), OfflineRecoveryInvalid);
  assert.throws(() => readRawRecoveryMarkers(storage([[deletedKey + ":t", ""]])), OfflineRecoveryInvalid);
});

test("D2b: drafts above per-record cap are rejected instead of truncated", () => {
  const s = storage([[notesDraftsKey + ":one:two", "x".repeat(128 * 1024 + 1)]]);
  assert.throws(() => readRawRecoveryDrafts(s), OfflineRecoveryInvalid);
});
