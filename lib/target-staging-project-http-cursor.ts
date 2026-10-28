/**
 * R2b project HTTP continuation is NOT an authentication capability. Every request
 * must first validate the real owner cookie; this cursor only fixes the
 * authorized read position and immutable SQLite snapshot across processes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { MAX_STAGING_PAGE_OFFSET } from "./target-task-read-model";

const DOMAIN = "lumi:r2b:private-project-http-cursor:v1\0";
const PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BINDING = /^[A-Za-z0-9_-]{43}$/;
const MAX_LENGTH = 4096;
const MAX_AGE_SECONDS = 15 * 60;

export interface StagingProjectHttpCursorContext {
  readonly actorUserId: string;
  readonly restoreGeneration: string;
  readonly stagingDirectory: string;
  readonly authenticationBinding: string;
  readonly sessionSecret: string;
}

type Claims = {
  v: 1;
  scope: "private-projects";
  binding: string;
  rev: string;
  offset: number;
  iat: number;
  exp: number;
};

export type VerifiedStagingProjectHttpCursor =
  | { ok: true; offset: number; revision: string; expiresAt: number }
  | { ok: false; reason: "invalid" | "expired" };

function safeContext(context: StagingProjectHttpCursorContext): boolean {
  return !!context && typeof context.actorUserId === "string" &&
    typeof context.restoreGeneration === "string" &&
    typeof context.stagingDirectory === "string" &&
    BINDING.test(context.authenticationBinding) &&
    typeof context.sessionSecret === "string" && context.sessionSecret.length >= 32;
}

function derivedKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(DOMAIN + "key").digest();
}

function bindingDigest(context: StagingProjectHttpCursorContext): string {
  const binding = JSON.stringify({
    actor: context.actorUserId,
    generation: context.restoreGeneration,
    directory: context.stagingDirectory,
    authentication: context.authenticationBinding,
  });
  return createHmac("sha256", derivedKey(context.sessionSecret))
    .update(DOMAIN + "binding\0" + binding).digest("hex");
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", derivedKey(secret)).update(DOMAIN + payload).digest();
}

/** Return a signed position without revealing actor, paths or the cookie. */
export function signStagingProjectHttpCursor(
  context: StagingProjectHttpCursorContext, revision: string, offset: number,
  expiresAt?: number, now = Math.floor(Date.now() / 1000),
): string | null {
  if (!safeContext(context) || !SHA256.test(revision) ||
      !Number.isSafeInteger(offset) || offset < 1 ||
      offset > MAX_STAGING_PAGE_OFFSET || !Number.isSafeInteger(now)) return null;
  const exp = expiresAt ?? now + MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + MAX_AGE_SECONDS) return null;
  const claims: Claims = {
    v: 1, scope: "private-projects", binding: bindingDigest(context),
    rev: revision, offset, iat: now, exp,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const token = payload + "." + sign(payload, context.sessionSecret).toString("base64url");
  return token.length <= MAX_LENGTH ? token : null;
}

export function verifyStagingProjectHttpCursor(
  context: StagingProjectHttpCursorContext, cursor: string,
  now = Math.floor(Date.now() / 1000),
): VerifiedStagingProjectHttpCursor {
  const invalid = (): VerifiedStagingProjectHttpCursor => ({ ok: false, reason: "invalid" });
  if (!safeContext(context) || typeof cursor !== "string" ||
      cursor.length === 0 || cursor.length > MAX_LENGTH ||
      !PATTERN.test(cursor) || !Number.isSafeInteger(now)) return invalid();
  try {
    const [encoded, signature] = cursor.split(".");
    const payload = Buffer.from(encoded, "base64url");
    const actual = Buffer.from(signature, "base64url");
    if (encoded !== payload.toString("base64url") ||
        signature !== actual.toString("base64url")) return invalid();
    const expected = sign(encoded, context.sessionSecret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid();
    const claims: Claims = JSON.parse(payload.toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims) ||
        Object.keys(claims).sort().join(",") !== "binding,exp,iat,offset,rev,scope,v" ||
        claims.v !== 1 || claims.scope !== "private-projects" ||
        claims.binding !== bindingDigest(context) ||
        typeof claims.rev !== "string" || !SHA256.test(claims.rev) ||
        !Number.isSafeInteger(claims.offset) || claims.offset < 1 ||
        claims.offset > MAX_STAGING_PAGE_OFFSET ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
        claims.iat > now || claims.exp <= claims.iat ||
        claims.exp - claims.iat > MAX_AGE_SECONDS) return invalid();
    if (claims.exp <= now) return { ok: false, reason: "expired" };
    return { ok: true, offset: claims.offset, revision: claims.rev, expiresAt: claims.exp };
  } catch {
    return invalid();
  }
}
