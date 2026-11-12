import { NextResponse } from "next/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createSessionToken, sessionCookieName, sessionMaxAgeSeconds } from "../../../../../../lib/auth";
import { OwnerSessionStateUnavailable } from "../../../../../../lib/owner-session-revocation";
import { boundedString, enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../../../lib/http-security";
import { finishAuthentication } from "../../../../../../lib/passkeys";
import { recordSecurityEvent } from "../../../../../../lib/security-audit";

export const runtime = "nodejs";

/** Pure error classification; also covers verified WebAuthn + failed session storage. */
export function passkeySignInError(error: unknown): HttpInputError {
  return error instanceof HttpInputError ? error
    : error instanceof OwnerSessionStateUnavailable
      ? new HttpInputError("Passkey sign-in is unavailable", 503)
      : new HttpInputError("Passkey sign-in failed", 401);
}

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "passkey-login-verify", 10, 15 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "auth.passkey.login", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, { status: 429, headers: { "retry-after": String(limited.retryAfter) } });
  }
  try {
    requireSameOrigin(request);
    const body = await readJsonBody<{ challenge?: unknown; response?: unknown }>(request, 64 * 1024);
    const challenge = boundedString(body.challenge, "challenge", 512);
    if (!body.response || typeof body.response !== "object") throw new HttpInputError("Passkey response is invalid");
    await finishAuthentication(request, challenge, body.response as AuthenticationResponseJSON);
    const result = NextResponse.json({ enabled: true, authenticated: true });
    result.cookies.set(sessionCookieName, createSessionToken(), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: sessionMaxAgeSeconds,
    });
    recordSecurityEvent(request, "auth.passkey.login", "allowed");
    return result;
  } catch (error) {
    const input = passkeySignInError(error);
    recordSecurityEvent(request, "auth.passkey.login", "failed", { reason: input.message });
    return NextResponse.json({ error: input.message }, { status: input.status });
  }
}
