import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync } from "node:crypto";
import {
  NOTE_SYNC_CURSOR_LENGTH, NOTE_SYNC_CURSOR_MAX_AGE_SECONDS,
  NOTE_SYNC_CURSOR_PLAINTEXT_BYTES,
  openTargetNoteSyncCursor as open, sealTargetNoteSyncCursor as seal,
  validNoteSyncCursorScope as validScope, validNoteSyncCursorPosition as validPosition,
} from "../lib/target-note-sync-cursor.ts";

const SECRET = "a-server-only-secret-with-at-least-thirty-two-bytes";
const OTHER_SECRET = "another-server-only-secret-with-at-least-thirty-two-bytes";
const GEN = "a25e8d19-8c47-4f26-bad3-f6cf08630e11";
const GEN2 = "b25e8d19-8c47-4f26-bad3-f6cf08630e11";
const scope = {
  actorUserId: "alice", sessionEpoch: 4, restoreGeneration: GEN,
  areaId: "team-area", policyRevision: 6, access: "editor",
};
const bootstrap = { phase: "bootstrap", afterId: "note-7", snapshotRevision: "a".repeat(64) };
const changes = { phase: "changes", afterSeq: 287, contentRevision: 300 };
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
    // Deterministic envelope checks replace probabilistic substring searches
    // over random ciphertext; the authenticated roundtrip checks its contents.
    const raw = Buffer.from(a, "base64url");
    assert.equal(raw[0], 1);
    assert.equal(raw.length, 1 + 12 + NOTE_SYNC_CURSOR_PLAINTEXT_BYTES + 16);
  }
});

test("task-feed HKDF key cannot open a valid note-format cursor", () => {
  // Produce a structurally valid NOTE cursor (same version, nonce size,
  // authenticated NOTE AAD, padded payload and total token length), but encrypt
  // it with the TASK-feed domain's HKDF key. Rejection must be cryptographic;
  // the legacy feed decoder's different envelope length does not prove that.
  const noteAAD = Buffer.from("lumi:r2d:note-sync-cursor:v1");
  const taskFeedKey = Buffer.from(hkdfSync(
    "sha256", SECRET, Buffer.from("lumi:r2c:feed-cursor:salt"),
    "lumi:r2c:feed-cursor:v1", 32,
  ));
  const payload = Buffer.from(JSON.stringify({
    version: 1, issuedAt: NOW, scope, position: bootstrap,
  }), "utf8");
  assert.ok(payload.length < NOTE_SYNC_CURSOR_PLAINTEXT_BYTES);
  const padded = Buffer.concat([
    payload, Buffer.alloc(NOTE_SYNC_CURSOR_PLAINTEXT_BYTES - payload.length, 0x20),
  ]);
  const nonce = Buffer.alloc(12, 0x3f); // fixed nonce only in this isolated test
  const cipher = createCipheriv("aes-256-gcm", taskFeedKey, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(noteAAD);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  const forged = Buffer.concat([
    Buffer.from([1]), nonce, ciphertext, cipher.getAuthTag(),
  ]).toString("base64url");
  assert.equal(forged.length, NOTE_SYNC_CURSOR_LENGTH);
  assert.equal(Buffer.from(forged, "base64url")[0], 1);
  assert.deepEqual(open(SECRET, forged, scope, NOW), { ok: false },
    "same-format token encrypted under the task-feed key must not authenticate");
  assert.equal(open(SECRET, seal(SECRET, scope, bootstrap, NOW), scope, NOW).ok, true);
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
    { phase: "changes", afterSeq: -1, contentRevision: 0 },
    { phase: "changes", afterSeq: 0 },
    { phase: "changes", afterSeq: 0, contentRevision: -1 }, { phase: "changes", afterSeq: 3.5, contentRevision: 0 },
    { phase: "changes", afterSeq: Number.MAX_SAFE_INTEGER, contentRevision: 0 },
    { phase: "changes", afterSeq: 0, contentRevision: 0, injected: 1 },
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
