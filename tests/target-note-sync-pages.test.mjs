import test from "node:test";
import assert from "node:assert/strict";
import {
  applyNoteSyncPage as apply, decodeNoteSyncWirePage as decode,
  emptyNoteSyncPageState as empty, readableNoteMetadata as readable,
} from "../lib/target-sync/note-pages.ts";

const C = "A".repeat(4135);
const B = "B".repeat(4135);
const note = (id, revision = 1, projectId = null, parentRevision = null) =>
  ({ id, revision, projectId, parentRevision });
const bootstrap = (entries, more = false, cursor = C) => ({
  phase: "bootstrap", entries, changes: [], more, cursor,
});
const changes = (events, more = false, cursor = B) => ({
  phase: "changes", entries: [], changes: events, more, cursor,
});
const edit = (noteId, revision, projectId = null) => ({ kind: "edit", noteId, revision, projectId });
const del = (noteId, revision, projectId = null) => ({ kind: "delete", noteId, revision, projectId });
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.state; };

test("two bootstrap pages remain hidden until complete and carry forward an opaque cursor", () => {
  const origin = empty();
  const first = ok(apply(origin, bootstrap([note("n1"), note("p1", 5, "proj", 9)], true)));
  assert.deepEqual(readable(first), []);
  assert.equal(first.cursor, C);
  assert.equal(first.pending.length, 2);
  assert.deepEqual(readable(origin), []);
  const complete = ok(apply(first, bootstrap([note("n2")], false, B)));
  assert.equal(complete.phase, "changes");
  assert.equal(complete.cursor, B);
  assert.deepEqual(readable(complete).map(n => n.id), ["n1", "p1", "n2"]);
  assert.deepEqual(complete.pending, []);
  // Read API returns independent values.
  const received = readable(complete);
  received[0].revision = 100;
  assert.equal(readable(complete)[0].revision, 1);
});

test("empty final bootstrap publishes an empty Area and enables empty change pages", () => {
  const state = ok(apply(empty(), bootstrap([])));
  assert.equal(state.phase, "changes");
  const next = ok(apply(state, changes([])));
  assert.deepEqual(readable(next), []);
  assert.equal(next.cursor, B);
});

test("ordered edits and deletions update known entries, never leak tombstones", () => {
  let state = ok(apply(empty(), bootstrap([note("a"), note("b", 2, "p", 7)])));
  state = ok(apply(state, changes([edit("a", 2), edit("a", 3), del("b", 3, "p")], true)));
  assert.deepEqual(readable(state), [note("a", 3)]);
  assert.equal(state.cursor, B);
  state = ok(apply(state, changes([del("a", 4)])));
  assert.deepEqual(readable(state), []);
});

test("unknown changes, skipped revisions, changed parent and duplicate deletes force full bootstrap", () => {
  const state = ok(apply(empty(), bootstrap([note("a"), note("child", 4, "project", 12)])));
  for (const event of [
    edit("new", 1), del("new", 2), edit("a", 4), edit("a", 1),
    edit("child", 5, "different"), del("child", 5, null),
  ]) {
    const result = apply(state, changes([event]));
    assert.deepEqual(result, { ok: false, reason: "resync_required" });
    assert.deepEqual(readable(state), [note("a"), note("child", 4, "project", 12)]);
  }
  const twice = apply(state, changes([del("a", 2), del("a", 3)]));
  assert.deepEqual(twice, { ok: false, reason: "resync_required" });
});

test("duplicate IDs across bootstrap pages and extra page over Area cap fail closed", () => {
  const first = ok(apply(empty(), bootstrap([note("dup")], true)));
  assert.deepEqual(apply(first, bootstrap([note("dup", 2)])),
    { ok: false, reason: "resync_required" });
  let state = empty();
  for (let i = 0; i < 40; i++) {
    state = ok(apply(state, bootstrap(Array.from({ length: 100 },
      (_, n) => note("n" + (i * 100 + n))), true)));
  }
  state = ok(apply(state, bootstrap(Array.from({ length: 96 },
    (_, n) => note("n" + (4000 + n))), true)));
  assert.equal(state.pending.length, 4096);
  assert.deepEqual(apply(state, bootstrap([note("overflow")], false)),
    { ok: false, reason: "resync_required" });
});

test("malformed schema and content-bearing fields are rejected rather than persisted", () => {
  const good = bootstrap([note("n")]);
  for (const raw of [
    { ...good, actorUserId: "alice" }, { ...good, entries: [{ ...note("n"), title: "secret" }] },
    { ...good, changes: [edit("n", 2)] }, { ...good, entries: [note("n"), note("n")] },
    { ...good, cursor: "bad" }, { ...good, cursor: C + "A" },
    { ...good, more: "false" }, bootstrap([], true), bootstrap(Array.from({ length: 101 }, (_, i) => note("n" + i))),
    bootstrap([note("../bad") , note("n")]), bootstrap([note("bad\\n")]),
    bootstrap([note("n", -1)]), bootstrap([note("n", 1, "p", null)]),
    bootstrap([note("n", 1, null, 2)]), bootstrap([note("n", 1.5)]),
    changes([edit("n", 2)], true), { ...changes([edit("n", 2)]), changes: [{ ...edit("n", 2), body: "secret" }] },
    { ...changes([]), entries: [note("n")] },
    null, [], 42,
  ]) {
    assert.equal(decode(raw), null, JSON.stringify(raw)?.slice(0, 100));
  }
});

test("invalid phase transitions reject without altering a page or its cursor", () => {
  const first = ok(apply(empty(), bootstrap([note("a")], true)));
  assert.deepEqual(apply(first, changes([edit("a", 2)])),
    { ok: false, reason: "invalid_page" });
  const live = ok(apply(first, bootstrap([])));
  assert.deepEqual(apply(live, bootstrap([note("a", 1)])),
    { ok: false, reason: "invalid_page" });
  assert.deepEqual(apply(empty(), changes([])),
    { ok: false, reason: "invalid_page" });
  assert.deepEqual(readable(live), [note("a")]);
  assert.equal(live.cursor, C);
});

test("restart following server resync must explicitly clear the old visible Area", () => {
  const live = ok(apply(empty(), bootstrap([note("private")])));
  assert.deepEqual(readable(live).map(n => n.id), ["private"]);
  const reset = empty();
  assert.deepEqual(readable(reset), []);
  const newState = ok(apply(reset, bootstrap([note("public")])));
  assert.deepEqual(readable(newState).map(n => n.id), ["public"]);
  assert.deepEqual(readable(live).map(n => n.id), ["private"],
    "the caller must discard the prior immutable object on reset");
});
