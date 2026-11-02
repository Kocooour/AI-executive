import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTE_SYNC_CURSOR_LENGTH, NOTE_SYNC_CURSOR_MAX_AGE_SECONDS,
  openTargetNoteSyncCursor as open, sealTargetNoteSyncCursor as seal,
  validNoteSyncCursorScope as validScope, validNoteSyncCursorPosition as validPosition,
} from "../lib/target-note-sync-cursor.ts";
import { openStagingFeedCursor } from "../lib/target-staging-feed-cursor.ts";

const SECRET = "a-server-only-secret-with-at-least-thirty-two-bytes";
const OTHER_SECRET = "another-server-only-secret-with-at-least-thirty-two-bytes";
const GEN = "a25e8d19-8c47-4f26-bad3-f6cf08630e11";
const GEN2 = "b25e8d19-8c47-4f26-bad3-f6cf08630e11";
const scope = {
  actorUserId: "alice", sessionEpoch: 4, restoreGeneration: GEN,
  areaId: "team-area", policyRevision: 6, access: "editor",
};
const bootstrap = { phase: "bootstrap", afterId: "note-7", snapshotRevision: "a".repeat(64) };
const changes = { phase: "changes", afterSeq: 287 };
const NOW = 1_800_000_000;

test("bootstrap and change cursors roundtrip; claims are encrypted, fixed-length and randomized", () => {
  for (const position of [bootstrap, changes]) {
    const a = seal(SECRET, scope, position, NOW);
    const b = seal(SECRET, scope, position, NOW);
    assert.equal(typeof a, "string");
    assert.equal(a.length, NOTE_SYNC_CURSOR_LENGTH);
    assert.equal(b.length, NOTE_SYNC_CURSOR_LENGTH);
    assert.notEqual(a, b, "new random 96-bit nonce per seal");
    assert.deepEqual(open(SECRET, a, scope, NOW), {
      ok: true, position, issuedAt: NOW,
    });
    for (const sensitive of ["team-area", "note-7", GEN]) {
      assert.equal(a.includes(sensitive), false);
    }
    // Other encrypted cursor namespaces cannot open or accept this token.
    assert.deepEqual(openStagingFeedCursor(SECRET, a), { ok: false });
  }
});

test("deny stale and foreign actor, Area, ACL, role, revocation epoch and restore generation", () => {
  const token = seal(SECRET, scope, bootstrap, NOW);
  assert.ok(token);
  const variants = [
    { actorUserId: "bob" }, { sessionEpoch: 5 }, { areaId: "other-area" },
    { policyRevision: 7 }, { access: "viewer" }, { restoreGeneration: GEN2 },
  ];
  for (const changed of variants) {
    assert.deepEqual(open(SECRET, token, { ...scope, ...changed }, NOW), { ok: false });
  }
  assert.equal(open(SECRET, token, { ...scope, restoreGeneration: GEN.toUpperCase() }, NOW).ok, true);
  assert.deepEqual(open(OTHER_SECRET, token, scope, NOW), { ok: false });
});

test("reject tampering, corrupt base64, malformed tokens, wrong version and non-secret inputs", () => {
  const token = seal(SECRET, scope, changes, NOW);
  assert.ok(token);
  assert.deepEqual(open(SECRET, token.slice(0, -1), scope, NOW), { ok: false });
  assert.deepEqual(open(SECRET, token + "A", scope, NOW), { ok: false });
  assert.deepEqual(open(SECRET, "*".repeat(token.length), scope, NOW), { ok: false });
  const mutate = token.slice(0, 25) + (token[25] === "A" ? "B" : "A") + token.slice(26);
  assert.deepEqual(open(SECRET, mutate, scope, NOW), { ok: false });
  const raw = Buffer.from(token, "base64url");
  raw[0] = 9;
  assert.deepEqual(open(SECRET, raw.toString("base64url"), scope, NOW), { ok: false });
  assert.deepEqual(open("short", token, scope, NOW), { ok: false });
  assert.equal(seal("short", scope, changes, NOW), null);
  for (const bad of [null, {}, 1, true, ["x"]]) {
    assert.deepEqual(open(SECRET, bad, scope, NOW), { ok: false });
  }
});

test("age-bounded, allows 60s future skew, rejects future and expired tokens", () => {
  const token = seal(SECRET, scope, changes, NOW);
  assert.equal(open(SECRET, token, scope, NOW + NOTE_SYNC_CURSOR_MAX_AGE_SECONDS).ok, true);
  assert.deepEqual(open(SECRET, token, scope, NOW + NOTE_SYNC_CURSOR_MAX_AGE_SECONDS + 1),
    { ok: false });
  assert.equal(open(SECRET, token, scope, NOW - 60).ok, true);
  assert.deepEqual(open(SECRET, token, scope, NOW - 61), { ok: false });
  assert.equal(seal(SECRET, scope, changes, -1), null);
  assert.deepEqual(open(SECRET, token, scope, -1), { ok: false });
});

test("fail closed for extra keys, malformed actors, Areas, revisions and pagination markers", () => {
  assert.equal(validScope(scope), true);
  for (const invalid of [
    { ...scope, injected: "unsafe" }, { ...scope, actorUserId: "bob\n" },
    { ...scope, areaId: ".." }, { ...scope, areaId: "x".repeat(513) },
    { ...scope, restoreGeneration: "00000000-0000-0000-0000-000000000000" },
    { ...scope, policyRevision: -1 }, { ...scope, sessionEpoch: 1.5 },
    { ...scope, access: "owner" }, { ...scope, access: "viewer", sessionEpoch: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.equal(validScope(invalid), false);
    assert.equal(seal(SECRET, invalid, bootstrap, NOW), null);
  }
  for (const invalid of [
    { ...bootstrap, next: 1 }, { ...bootstrap, afterId: "" },
    { ...bootstrap, afterId: "x".repeat(513) },
    { ...bootstrap, snapshotRevision: "bad" },
    { phase: "bootstrap", afterId: null, snapshotRevision: "a".repeat(64) },
    { phase: "changes", afterSeq: -1 }, { phase: "changes", afterSeq: 3.5 },
    { phase: "changes", afterSeq: Number.MAX_SAFE_INTEGER },
    { phase: "changes", afterSeq: 0, injected: 1 },
    { phase: "unknown", afterSeq: 2 },
  ]) {
    assert.equal(validPosition(invalid), false);
    assert.equal(seal(SECRET, scope, invalid, NOW), null);
  }
});

test("maximum valid UTF-8 Area and continuation IDs fit the padded token", () => {
  const maxScope = { ...scope, areaId: "ü".repeat(256) };
  const maxPosition = { ...bootstrap, afterId: "\\".repeat(512) };
  const token = seal(SECRET, maxScope, maxPosition, NOW);
  assert.ok(token, "max-size quoted identifiers must fit inside the constant envelope");
  assert.deepEqual(open(SECRET, token, maxScope, NOW), {
    ok: true, position: maxPosition, issuedAt: NOW,
  });
});
