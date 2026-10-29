/**
 * R2b HTTP continuation is NOT an authentication capability. Every request
 * must first validate the real owner cookie; this cursor only fixes the
 * authorized read position and immutable SQLite snapshot across processes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { MAX_STAGING_PAGE_OFFSET } from "./target-task-read-model";

const DOMAIN = "lumi:r2b:personal-http-cursor:v1\0";
const PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BINDING = /^[A-Za-z0-9_-]{43}$/;
const MAX_LENGTH = 4096;
const MAX_AGE_SECONDS = 15 * 60;

export interface StagingHttpCursorContext {
  readonly actorUserId: string;
  readonly restoreGeneration: string;
  readonly stagingDirectory: string;
  readonly authenticationBinding: string;
  readonly sessionSecret: string;
  /**
   * R2-ID.2b read scope. Absent means "personal" with the exact historical
   * binding; "shared" / "my-plan" extend the binding, so a cursor never moves
   * between scopes (a personal cursor is invalid for shared and vice versa).
   */
  readonly scope?: "personal" | "shared" | "my-plan";
}

type Claims = {
  v: 1;
  scope: "personal" | "shared" | "my-plan";
  binding: string;
  rev: string;
  offset: number;
  iat: number;
  exp: number;
};

export type VerifiedStagingHttpCursor =
  | { ok: true; offset: number; revision: string; expiresAt: number }
  | { ok: false; reason: "invalid" | "expired" };

function safeContext(context: StagingHttpCursorContext): boolean {
  return !!context && typeof context.actorUserId === "string" &&
    typeof context.restoreGeneration === "string" &&
    typeof context.stagingDirectory === "string" &&
    BINDING.test(context.authenticationBinding) &&
    typeof context.sessionSecret === "string" && context.sessionSecret.length >= 32 &&
    (context.scope === undefined || SCOPES.includes(context.scope));
}

function derivedKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(DOMAIN + "key").digest();
}

const SCOPES = ["personal", "shared", "my-plan"];
const scopeOf = (context: StagingHttpCursorContext): Claims["scope"] => context.scope ?? "personal";

function bindingDigest(context: StagingHttpCursorContext): string {
  const binding = JSON.stringify({
    actor: context.actorUserId,
    generation: context.restoreGeneration,
    directory: context.stagingDirectory,
    authentication: context.authenticationBinding,
    ...(scopeOf(context) === "personal" ? {} : { scope: scopeOf(context) }),
  });
  return createHmac("sha256", derivedKey(context.sessionSecret))
    .update(DOMAIN + "binding\0" + binding).digest("hex");
}

function sign(payload: string, secret: string): Buffer {
  return createHmac("sha256", derivedKey(secret)).update(DOMAIN + payload).digest();
}

/** Return a signed position without revealing actor, paths or the cookie. */
export function signStagingHttpCursor(
  context: StagingHttpCursorContext, revision: string, offset: number,
  expiresAt?: number, now = Math.floor(Date.now() / 1000),
): string | null {
  if (!safeContext(context) || !SHA256.test(revision) ||
      !Number.isSafeInteger(offset) || offset < 1 ||
      offset > MAX_STAGING_PAGE_OFFSET || !Number.isSafeInteger(now)) return null;
  const exp = expiresAt ?? now + MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + MAX_AGE_SECONDS) return null;
  const claims: Claims = {
    v: 1, scope: scopeOf(context), binding: bindingDigest(context),
    rev: revision, offset, iat: now, exp,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const token = payload + "." + sign(payload, context.sessionSecret).toString("base64url");
  return token.length <= MAX_LENGTH ? token : null;
}

export function verifyStagingHttpCursor(
  context: StagingHttpCursorContext, cursor: string,
  now = Math.floor(Date.now() / 1000),
): VerifiedStagingHttpCursor {
  const invalid = (): VerifiedStagingHttpCursor => ({ ok: false, reason: "invalid" });
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
        claims.v !== 1 || claims.scope !== scopeOf(context) ||
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
