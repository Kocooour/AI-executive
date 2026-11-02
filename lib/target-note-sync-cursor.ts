/**
 * R2d.2c.2g.2a — encrypted cursor primitive for isolated note synchronization.
 *
 * Not an authentication capability, HTTP endpoint or change journal. The
 * caller must independently validate a live durable session, current Area ACL,
 * canonical pinned store, note/parent guards and revocation before release.
 * First bootstrap pages have NO cursor; only continuation pages are sealed.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const DOMAIN = "lumi:r2d:note-sync-cursor:v1";
const SALT = Buffer.from("lumi:r2d:note-sync-cursor:salt:v1");
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const USER = /^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]+$/;
const MAX_ID_BYTES = 512;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const CLOCK_SKEW_SECONDS = 60;
/** Cursor cannot be resumed indefinitely; a stale client must rebootstrap. */
export const NOTE_SYNC_CURSOR_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Includes the two 512-byte IDs, scope, revisions and optional digest. */
export const NOTE_SYNC_CURSOR_PLAINTEXT_BYTES = 3072;
/** Constant length prevents leaking the actor, Area, position or note ID size. */
export const NOTE_SYNC_CURSOR_LENGTH = Math.ceil(
  (1 + NONCE_BYTES + NOTE_SYNC_CURSOR_PLAINTEXT_BYTES + TAG_BYTES) * 4 / 3,
);

export type NoteSyncCursorScope = {
  actorUserId: string;
  sessionEpoch: number;
  restoreGeneration: string;
  areaId: string;
  policyRevision: number;
  access: "private-owner" | "viewer" | "editor" | "admin";
};
export type NoteSyncCursorPosition =
  | { phase: "bootstrap"; afterId: string; snapshotRevision: string }
  | { phase: "changes"; afterSeq: number; contentRevision: number };
export type OpenedNoteSyncCursor =
  | { ok: true; position: NoteSyncCursorPosition; issuedAt: number }
  | { ok: false };

const validInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x < MAX_INT;
const validId = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.isWellFormed() &&
  x.trim() === x && x !== "." && x !== ".." &&
  Buffer.byteLength(x, "utf8") <= MAX_ID_BYTES &&
  !/[\u0000-\u001f\u007f]/u.test(x);
const exactKeys = (x: Record<string, unknown>, sorted: string) =>
  Object.keys(x).sort().join(",") === sorted;
const secretOk = (x: unknown): x is string => typeof x === "string" && x.length >= 32;

export function validNoteSyncCursorScope(value: unknown): value is NoteSyncCursorScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return exactKeys(s, "access,actorUserId,areaId,policyRevision,restoreGeneration,sessionEpoch") &&
    typeof s.actorUserId === "string" && USER.test(s.actorUserId) &&
    validId(s.areaId) && validInt(s.sessionEpoch) && validInt(s.policyRevision) &&
    typeof s.restoreGeneration === "string" && UUID.test(s.restoreGeneration) &&
    (s.access === "private-owner" || s.access === "viewer" ||
      s.access === "editor" || s.access === "admin");
}
export function validNoteSyncCursorPosition(value: unknown): value is NoteSyncCursorPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (p.phase === "bootstrap") {
    return exactKeys(p, "afterId,phase,snapshotRevision") && validId(p.afterId) &&
      typeof p.snapshotRevision === "string" && SHA256.test(p.snapshotRevision);
  }
  if (p.phase === "changes") {
    return exactKeys(p, "afterSeq,contentRevision,phase") &&
      validInt(p.afterSeq) && validInt(p.contentRevision);
  }
  return false;
}

function encryptionKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, SALT, DOMAIN, 32));
}
/** Seal *only* a server-authorized position, never a raw client claim. */
export function sealTargetNoteSyncCursor(
  secret: string, scope: NoteSyncCursorScope, position: NoteSyncCursorPosition,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  if (!secretOk(secret) || !validNoteSyncCursorScope(scope) ||
      !validNoteSyncCursorPosition(position) || !validInt(nowSeconds)) return null;
  try {
    const plaintext = Buffer.from(JSON.stringify({
      version: VERSION, issuedAt: nowSeconds, scope, position,
    }), "utf8");
    if (plaintext.length > NOTE_SYNC_CURSOR_PLAINTEXT_BYTES) return null;
    const padded = Buffer.concat([
      plaintext, Buffer.alloc(NOTE_SYNC_CURSOR_PLAINTEXT_BYTES - plaintext.length, 0x20),
    ]);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(DOMAIN));
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    const token = Buffer.concat([Buffer.from([VERSION]), nonce, encrypted, cipher.getAuthTag()])
      .toString("base64url");
    return token.length === NOTE_SYNC_CURSOR_LENGTH ? token : null;
  } catch {
    return null;
  }
}

/**
 * Compare to server-derived scope (never client-supplied identity, epoch or
 * Area). No distinction between expired, tampered, stale or foreign cursors.
 */
export function openTargetNoteSyncCursor(
  secret: string, token: unknown, current: NoteSyncCursorScope,
  nowSeconds = Math.floor(Date.now() / 1000),
): OpenedNoteSyncCursor {
  const denied: OpenedNoteSyncCursor = { ok: false };
  if (!secretOk(secret) || !validNoteSyncCursorScope(current) || !validInt(nowSeconds) ||
      typeof token !== "string" || token.length !== NOTE_SYNC_CURSOR_LENGTH ||
      !TOKEN.test(token)) return denied;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.toString("base64url") !== token ||
        raw.length !== 1 + NONCE_BYTES + NOTE_SYNC_CURSOR_PLAINTEXT_BYTES + TAG_BYTES ||
        raw[0] !== VERSION) return denied;
    const nonce = raw.subarray(1, 1 + NONCE_BYTES);
    const ciphertext = raw.subarray(1 + NONCE_BYTES, raw.length - TAG_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const cipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(DOMAIN));
    cipher.setAuthTag(tag);
    const decoded = JSON.parse(Buffer.concat([cipher.update(ciphertext), cipher.final()])
      .toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return denied;
    const c = decoded as Record<string, unknown>;
    if (!exactKeys(c, "issuedAt,position,scope,version") ||
        c.version !== VERSION || !validInt(c.issuedAt) ||
        c.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS ||
        nowSeconds - c.issuedAt > NOTE_SYNC_CURSOR_MAX_AGE_SECONDS ||
        !validNoteSyncCursorScope(c.scope) || !validNoteSyncCursorPosition(c.position)) return denied;
    const s = c.scope;
    if (s.actorUserId !== current.actorUserId || s.sessionEpoch !== current.sessionEpoch ||
        s.areaId !== current.areaId || s.policyRevision !== current.policyRevision ||
        s.restoreGeneration.toLowerCase() !== current.restoreGeneration.toLowerCase() ||
        s.access !== current.access) return denied;
    return { ok: true, position: c.position, issuedAt: c.issuedAt };
  } catch {
    return denied;
  }
}
