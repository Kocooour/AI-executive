/**
 * R2c.2a change-feed cursor (staging only). MECHANISM PROPOSED FOR OWNER APPROVAL.
 *
 * Unlike the HMAC list cursors of R2-ID.1 this token is encrypted (AES-256-GCM,
 * fresh random 96-bit nonce per token), so neither the global change-log
 * position nor any claim can be read from it. The key is derived with
 * HKDF-SHA256 from the server session secret under its own domain string, which
 * is separate from every HMAC domain. It is bound to the identity (`uid`), its
 * revocation epoch, the restore generation (which is also the store-instance id,
 * a random UUID per bootstrap) and, deliberately, NOT to a session, so a new
 * login of the same identity continues with the same cursor. It is NOT an
 * authentication capability: every request still needs a live session.
 *
 * Token = base64url(version byte || nonce(12) || ciphertext || tag(16)). The
 * plaintext JSON is space-padded to a multiple of PAD bytes so the token length
 * does not reveal the number of digits of a sequence position.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const INFO = "lumi:r2c:feed-cursor:v1";
const SALT = Buffer.from("lumi:r2c:feed-cursor:salt");
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PAD = 128;
/** Query bound: longer values are rejected before any decryption. */
export const MAX_FEED_CURSOR_LENGTH = 2048;
const TOKEN = /^[A-Za-z0-9_-]+$/;
const USER_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ID_BYTES = 512;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Position state inside the encrypted claims. */
export type FeedPosition =
  /** Whole-actor bootstrap: watermark W and the last served (areaId, kind, id); kind "lost" = an access_lost slot. */
  | { ph: "b"; w: number; k: [string, string, string] | null }
  /** Feed: P is the seq of the last entry examined for THIS actor, never the log head. */
  | { ph: "f"; p: number }
  /** Single-Area bootstrap after a grant: Area, grant seq and last served (kind, id). */
  | { ph: "a"; a: string; w: number; k: [string, string] | null };

export type FeedClaims = { uid: string; epoch: number; gen: string; pos: FeedPosition };

export type OpenedFeedCursor =
  | { ok: true; claims: FeedClaims; iat: number }
  | { ok: false };

const validSecret = (secret: unknown): secret is string =>
  typeof secret === "string" && secret.length >= 32;
const key = (secret: string): Buffer =>
  Buffer.from(hkdfSync("sha256", secret, SALT, INFO, 32));
const safeInt = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value < MAX_SAFE;
const idOk = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES &&
  !/[\u0000-\u001f\u007f]/.test(value);

/** Strict position validation, shared by the cursor, the child request and its output. */
export function validFeedPosition(value: unknown): value is FeedPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pos = value as Record<string, unknown>;
  const keys = Object.keys(pos).sort().join(",");
  if (pos.ph === "f") return keys === "p,ph" && safeInt(pos.p, 0);
  if (pos.ph === "b") {
    return keys === "k,ph,w" && safeInt(pos.w, 0) && (pos.k === null || (Array.isArray(pos.k) &&
      pos.k.length === 3 && pos.k.every(idOk) &&
      (pos.k[1] === "project" || pos.k[1] === "task" || pos.k[1] === "lost")));
  }
  if (pos.ph === "a") {
    return keys === "a,k,ph,w" && idOk(pos.a) && safeInt(pos.w, 0) && (pos.k === null ||
      (Array.isArray(pos.k) && pos.k.length === 2 && pos.k.every(idOk) &&
        (pos.k[0] === "project" || pos.k[0] === "task")));
  }
  return false;
}

export function validFeedClaims(value: unknown): value is FeedClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return Object.keys(claims).sort().join(",") === "epoch,gen,pos,uid" &&
    typeof claims.uid === "string" && USER_ID.test(claims.uid) && safeInt(claims.epoch, 0) &&
    typeof claims.gen === "string" && UUID.test(claims.gen) && validFeedPosition(claims.pos);
}

/** Encrypt claims into a fresh token (new random nonce every call), or null on invalid input. */
export function sealStagingFeedCursor(
  secret: string, claims: FeedClaims, now = Math.floor(Date.now() / 1000),
): string | null {
  if (!validSecret(secret) || !validFeedClaims(claims) || !Number.isSafeInteger(now)) return null;
  try {
    const plain = JSON.stringify({
      v: 1, uid: claims.uid, epoch: claims.epoch, gen: claims.gen, iat: now, pos: claims.pos,
    });
    const padded = Buffer.from(plain.padEnd(Math.ceil(plain.length / PAD) * PAD, " "), "utf8");
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key(secret), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(INFO));
    const body = Buffer.concat([cipher.update(padded), cipher.final()]);
    const token = Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()])
      .toString("base64url");
    return token.length <= MAX_FEED_CURSOR_LENGTH ? token : null;
  } catch {
    return null;
  }
}

/** Decrypt and strictly validate. Every failure is the same `{ ok: false }`. */
export function openStagingFeedCursor(secret: string, token: unknown): OpenedFeedCursor {
  const fail: OpenedFeedCursor = { ok: false };
  if (!validSecret(secret) || typeof token !== "string" || token.length === 0 ||
      token.length > MAX_FEED_CURSOR_LENGTH || !TOKEN.test(token)) return fail;
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.toString("base64url") !== token ||
        raw.length < 1 + NONCE_BYTES + TAG_BYTES + 1 || raw[0] !== VERSION) return fail;
    const nonce = raw.subarray(1, 1 + NONCE_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const body = raw.subarray(1 + NONCE_BYTES, raw.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key(secret), nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(INFO));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(plain);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail;
    const { v, iat, ...claims } = parsed as Record<string, unknown>;
    if (v !== 1 || !safeInt(iat, 0) || !validFeedClaims(claims)) return fail;
    return { ok: true, claims, iat };
  } catch {
    return fail;
  }
}
