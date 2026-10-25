import assert from "node:assert/strict";
import test from "node:test";
import { offlineRecoveryHoldKey, offlineRecoveryIntentKey, beginOfflineRecoveryHold, beginOfflineRecoveryHoldSafely, withOfflineRecoveryDataLock, recoveryExportGeneration, recoveryPullDecision, offlineRecoveryIsHeld, parseOfflineRecoveryHold, readOfflineRecoveryHold } from "../lib/d2b-recovery-hold.ts";
import { readRawRecoveryDrafts, readRawRecoveryMarkers } from "../lib/d2b-recovery-local.ts";
import { OfflineRecoveryInvalid } from "../lib/d2b-offline-reconciliation.ts";
import { deletedKey, revivedKey, pendingKey, pendingSeqKey, captureMarkers, clearSentMarkers, clearAllMarkers } from "../lib/pending-markers.ts";
import { notesDraftsKey, clearNotesDrafts, settleNotesDraft, dropNotesDraft } from "../lib/notes-drafts.ts";
import { projectContextDraftPrefix, clearProjectContextDrafts, dropProjectContextDraft } from "../lib/project-context-drafts.ts";
import { adoptionWriteGuard, allowAdoptionWrites, AdoptionWriteRefused } from "../lib/adoption.ts";
import { clearLocalData, finishInterruptedWipe } from "../lib/local-data.ts";

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

test("D2b: an old in-flight save cannot clear pending markers after a sibling holds recovery", () => {
  // The persistent hold was installed by earlier tests; these are precisely the
  // cleanup calls made when a request started before the hold eventually returns.
  const s = storage([
    [pendingKey, "1"],
    [pendingSeqKey, "000001-old-save"],
    [deletedKey + ":0000000000010-tab-old", "deleted-record"],
    [revivedKey + ":0000000000011-tab-old", "revived-record"],
    [deletedKey, '["legacy-record"]'],
  ]);
  const oldSave = captureMarkers(s);
  const before = s.snapshot();
  clearSentMarkers(s, oldSave);
  clearAllMarkers(s);
  assert.deepEqual(s.snapshot(), before, "the recovery file still needs the raw intent markers");
  assert.deepEqual(readRawRecoveryMarkers(s), {
    pendingDeletedIds: ["deleted-record", "legacy-record"],
    pendingRevivedIds: ["revived-record"],
    pendingSync: true,
  });
});

test("D2b: late note/project draft settlement and cleanup cannot remove rescue data", () => {
  const note = { id: "task-1", text: "typed text", base: "", at: 101, page: "tab-1" };
  const noteKey = notesDraftsKey + ":tab-1:task-1";
  const contextKey = projectContextDraftPrefix + ":tab-1:personal:project-1";
  const s = storage([[noteKey, JSON.stringify(note)], [contextKey, "raw context draft"]]);
  const before = s.snapshot();
  settleNotesDraft(s, note.page, note.id, note.text);
  dropNotesDraft(s, note);
  clearNotesDrafts(s);
  dropProjectContextDraft(s, "tab-1", "personal", "project-1");
  clearProjectContextDrafts(s);
  assert.deepEqual(s.snapshot(), before);
});

test("D2b: even a pre-authorized adoption transaction may not mutate under recovery hold", async () => {
  const transaction = {};
  allowAdoptionWrites(transaction);
  let mutationCount = 0;
  const core = adoptionWriteGuard({
    table() {
      return { mutate: async () => { mutationCount += 1; } };
    },
  });
  await assert.rejects(core.table("entities").mutate({ trans: transaction }), AdoptionWriteRefused);
  assert.equal(mutationCount, 0);
});

test("D2b: interrupted sign-out cleanup and explicit wipe are forbidden while recovery is held", async () => {
  // The prior tests installed a sticky hold in this process. No localStorage
  // or IndexedDB cleanup may start, including after a crashed sign-out.
  await finishInterruptedWipe();
  await assert.rejects(clearLocalData(), /OFFLINE_RECOVERY_HELD/);
});

test("D2b: multiple server restores still allow a recovery export without changing the first hold", () => {
  const first = { version: 1, knownGeneration: 2, observedGeneration: 3, createdAt: 100 };
  assert.equal(recoveryExportGeneration(first, 3), 3);
  assert.equal(recoveryExportGeneration(first, 4), 4);
  assert.throws(() => recoveryExportGeneration(first, 1), /OFFLINE_RECOVERY_GENERATION_INVALID/);
  assert.throws(() => recoveryExportGeneration(first, 2), /OFFLINE_RECOVERY_GENERATION_INVALID/);
  assert.throws(() => recoveryExportGeneration(first, Number.NaN), /OFFLINE_RECOVERY_GENERATION_INVALID/);
});

test("D2b: recovery hold waits for an existing wipe before becoming browser-wide", async () => {
  const previousStorage = globalThis.localStorage;
  const previousNavigator = globalThis.navigator;
  const s = storage();
  let unlock;
  let entered = false;
  const gate = new Promise((resolve) => { unlock = resolve; });
  const locks = { request: async (_name, callback) => {
    entered = true;
    await gate;
    return callback();
  } };
  try {
    Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
    const promise = beginOfflineRecoveryHoldSafely(2, 3);
    assert.equal(entered, true, "hold waits for the shared lock");
    assert.equal(offlineRecoveryIsHeld(s), true, "the restoring tab stops its own writes immediately");
    assert.equal(s.getItem(offlineRecoveryHoldKey), null);
    assert.equal(s.getItem(offlineRecoveryIntentKey), null);
    assert.equal(readOfflineRecoveryHold(s), null, "a sibling's authorized wipe cannot be interrupted mid-deletion");
    unlock();
    const hold = await promise;
    assert.equal(readOfflineRecoveryHold(s).observedGeneration, 3);
    assert.deepEqual(hold, readOfflineRecoveryHold(s));
  } finally {
    unlock();
    Object.defineProperty(globalThis, "localStorage", { value: previousStorage, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
  }
});

test("D2b: the recovery-data lock runs critical sections serially", async () => {
  const previousNavigator = globalThis.navigator;
  let queue = Promise.resolve();
  const locks = { request: (_name, callback) => {
    const current = queue.then(callback);
    queue = current.then(() => undefined, () => undefined);
    return current;
  } };
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  try {
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
    const first = withOfflineRecoveryDataLock(async () => {
      order.push("wipe-start");
      await gate;
      order.push("wipe-end");
    });
    const second = withOfflineRecoveryDataLock(async () => { order.push("final-hold"); });
    await Promise.resolve();
    assert.deepEqual(order, ["wipe-start"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["wipe-start", "wipe-end", "final-hold"]);
  } finally {
    release();
    Object.defineProperty(globalThis, "navigator", { value: previousNavigator, configurable: true });
  }
});

test("D2b: existing legacy recovery intents remain sticky after a crash", () => {
  const held = { version: 1, knownGeneration: 2, observedGeneration: 3, createdAt: 100 };
  const storageWithIntent = storage([[offlineRecoveryIntentKey, JSON.stringify(held)]]);
  assert.equal(offlineRecoveryIsHeld(storageWithIntent), true);
  assert.deepEqual(readOfflineRecoveryHold(storageWithIntent), held);
  assert.deepEqual(beginOfflineRecoveryHold(2, 3, storageWithIntent), held);
  assert.deepEqual(readOfflineRecoveryHold(storageWithIntent), held);
});

test("D2b: queued local wipe observes the hold and must not erase rescue data", async () => {
  const priorStorage = globalThis.localStorage;
  const priorNavigator = globalThis.navigator;
  const s = storage([["ai-executive-pending-sync", "1"], ["ai-executive-notes-drafts:tab:id", "raw-owner-draft"]]);
  let queue = Promise.resolve();
  const locks = { request: (_name, callback) => {
    const run = queue.then(callback);
    queue = run.then(() => undefined, () => undefined);
    return run;
  } };
  try {
    Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
    await beginOfflineRecoveryHoldSafely(2, 3);
    const before = s.snapshot();
    await assert.rejects(clearLocalData(), /OFFLINE_RECOVERY_HELD/);
    assert.deepEqual(s.snapshot(), before);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: priorStorage, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: priorNavigator, configurable: true });
  }
});

test("D2b: a new restore generation wins over an equal or lower server revision", () => {
  // A server restored to an older backup commonly comes back with a lower
  // revision: do NOT return synced before comparing generations.
  assert.equal(recoveryPullDecision(true, 3, 17), "restore");
  assert.equal(recoveryPullDecision(true, 17, 17), "restore");
  assert.equal(recoveryPullDecision(true, 18, 17), "restore");
  assert.equal(recoveryPullDecision(false, 16, 17), "synced");
  assert.equal(recoveryPullDecision(false, 17, 17), "synced");
  assert.equal(recoveryPullDecision(false, 18, 17), "apply");
});

test("D2b: a wipe holding the cross-tab lock finishes before a later restore; no empty rescue marker", async () => {
  const priorStorage = globalThis.localStorage;
  const priorNavigator = globalThis.navigator;
  const s = storage([["ai-executive-pending-sync", "1"], ["ai-executive-notes-drafts:tab:owner", "private"]]);
  let unlock;
  const wipeGate = new Promise((resolve) => { unlock = resolve; });
  let queue = Promise.resolve();
  const locks = { request: (_name, callback) => {
    const next = queue.then(callback);
    queue = next.then(() => undefined, () => undefined);
    return next;
  } };
  try {
    Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
    const wipe = withOfflineRecoveryDataLock(async () => {
      s.setItem("ai-executive-wipe-pending", "1");
      await wipeGate;
      s.removeItem("ai-executive-pending-sync");
      s.removeItem("ai-executive-notes-drafts:tab:owner");
      s.setItem("ai-executive-signed-out", "1");
      s.removeItem("ai-executive-wipe-pending");
    }, true);
    await Promise.resolve(); // Let the wipe acquire the exclusive lock first.
    const delayedHold = beginOfflineRecoveryHoldSafely(2, 3);
    assert.equal(s.getItem(offlineRecoveryHoldKey), null, "no shared hold during an authorized wipe");
    unlock();
    await wipe;
    await assert.rejects(delayedHold, /OFFLINE_RECOVERY_WIPE_PRECEDED_HOLD/);
    assert.equal(s.getItem(offlineRecoveryHoldKey), null, "do not advertise a rescue for deleted data");
    assert.equal(s.getItem("ai-executive-signed-out"), "1");
  } finally {
    unlock();
    Object.defineProperty(globalThis, "localStorage", { value: priorStorage, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: priorNavigator, configurable: true });
  }
});

test("D2b: an interrupted prior wipe is never declared a valid recovery source", async () => {
  const priorStorage = globalThis.localStorage;
  const priorNavigator = globalThis.navigator;
  const s = storage([["ai-executive-wipe-pending", "1"]]);
  const locks = { request: async (_name, callback) => callback() };
  try {
    Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
    await assert.rejects(beginOfflineRecoveryHoldSafely(2, 3), /OFFLINE_RECOVERY_WIPE_PRECEDED_HOLD/);
    assert.equal(s.getItem(offlineRecoveryHoldKey), null);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: priorStorage, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: priorNavigator, configurable: true });
  }
});
