import assert from "node:assert/strict";
import test from "node:test";
import {
  ownerRestoreOrigin, restoreKindForGeneration, restoredSinceKnownGeneration,
  restoreGenerationDecision,
} from "../lib/restore-generation-origin.ts";

test("restore evidence is bound to its exact server generation and absent in backups", () => {
  const valid = ownerRestoreOrigin(4);
  assert.equal(restoreKindForGeneration(4, valid), "owner_restore");
  assert.equal(restoreKindForGeneration(5, valid), undefined, "a later partition bump cannot inherit the old proof");
  assert.equal(restoreKindForGeneration(0, valid), undefined);
  for (const raw of ["", "garbage", "{}", JSON.stringify({ version: 1, generation: 4, kind: "partition_recovery" }),
    JSON.stringify({ version: 1, generation: 4, kind: "owner_restore", attacker: true })]) {
    assert.equal(restoreKindForGeneration(4, raw), undefined);
  }
  assert.throws(() => ownerRestoreOrigin(-1));
});

test("known and unknown generation: only a previously synchronized browser adopts", () => {
  assert.equal(restoredSinceKnownGeneration(3, 4, true), true);
  assert.equal(restoredSinceKnownGeneration(3, 3, true), false);
  assert.equal(restoredSinceKnownGeneration(undefined, 4, true), true);
  assert.equal(restoredSinceKnownGeneration(undefined, 4, false), false);
  assert.equal(restoredSinceKnownGeneration(undefined, 0, true), false);
  assert.equal(restoredSinceKnownGeneration(3, undefined, true), false);
});

test("unsent edits, parked drafts and deletion markers are discarded only for certified replaced data", () => {
  // Pending, draft and unsent work of an old generation do NOT veto a
  // user-authorized restore, even on a different device. The adoption
  // transaction wipes these; no saved draft is subsequently replayed.
  const unsent = { changes: ["task-local"], noteDraft: "unsaved title", deleted: ["task-old"] };
  assert.ok(unsent.noteDraft && unsent.changes.length && unsent.deleted.length);
  assert.equal(restoreGenerationDecision(true, "owner_restore", false), "adopt");
  assert.equal(restoreGenerationDecision(true, undefined, false), "hold");
  assert.equal(restoreGenerationDecision(true, "partition_recovery", false), "hold");
  assert.equal(restoreGenerationDecision(true, "owner_restore", true), "hold", "old explicit rescue holds stay intact");
  assert.equal(restoreGenerationDecision(false, "owner_restore", false), "normal",
    "unreplaced data with pending edits must NEVER be discarded for a normal server revision");
});
