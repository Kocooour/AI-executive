import { NextResponse } from "next/server";
import { authenticationBinding, isAuthenticated, verifyPassword } from "../../../../../../lib/auth";
import { boundedString, enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../../../lib/http-security";
import { registrationOptions } from "../../../../../../lib/passkeys";
import { recordSecurityEvent } from "../../../../../../lib/security-audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "passkey-register-options", 10, 15 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: 429, headers: { "retry-after": String(limited.retryAfter) } });
  try {
    requireSameOrigin(request);
    const body = await readJsonBody<{ password?: unknown }>(request, 4096);
    const password = boundedString(body.password, "password", 1024);
    if (!(await verifyPassword(password))) throw new HttpInputError("Current password is incorrect", 401);
    const options = await registrationOptions(request, authenticationBinding(request));
    recordSecurityEvent(request, "auth.passkey.registration-options", "allowed");
    return NextResponse.json(options, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const input = error instanceof HttpInputError ? error : new HttpInputError("Passkey registration is unavailable", 500);
    recordSecurityEvent(request, "auth.passkey.registration-options", "failed", { reason: input.message });
    return NextResponse.json({ error: input.message }, { status: input.status });
  }
}
