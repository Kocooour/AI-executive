import { NextResponse } from "next/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { authenticationBinding, isAuthenticated } from "../../../../../../lib/auth";
import { boundedString, enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../../../lib/http-security";
import { finishRegistration } from "../../../../../../lib/passkeys";
import { recordSecurityEvent } from "../../../../../../lib/security-audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "passkey-register-verify", 10, 15 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: 429, headers: { "retry-after": String(limited.retryAfter) } });
  try {
    requireSameOrigin(request);
    const body = await readJsonBody<{ challenge?: unknown; response?: unknown; label?: unknown }>(request, 96 * 1024);
    const challenge = boundedString(body.challenge, "challenge", 512);
    const label = boundedString(body.label ?? "Passkey", "label", 80).trim();
    if (!body.response || typeof body.response !== "object") throw new HttpInputError("Passkey response is invalid");
    await finishRegistration(request, authenticationBinding(request), challenge, body.response as RegistrationResponseJSON, label);
    recordSecurityEvent(request, "auth.passkey.register", "allowed");
    return NextResponse.json({ registered: true });
  } catch (error) {
    const input = error instanceof HttpInputError ? error : new HttpInputError("Passkey registration failed", 400);
    recordSecurityEvent(request, "auth.passkey.register", "failed", { reason: input.message });
    return NextResponse.json({ error: input.message }, { status: input.status });
  }
}
