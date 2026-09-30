import { NextResponse } from "next/server";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../../../lib/http-security";
import { authenticationOptions } from "../../../../../../lib/passkeys";
import { recordSecurityEvent } from "../../../../../../lib/security-audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "passkey-login-options", 20, 15 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "auth.passkey.login-options", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, { status: 429, headers: { "retry-after": String(limited.retryAfter) } });
  }
  try {
    requireSameOrigin(request);
    await readJsonBody(request, 1024);
    const options = await authenticationOptions(request);
    return NextResponse.json(options, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const input = error instanceof HttpInputError ? error : new HttpInputError("Passkey sign-in is unavailable", 400);
    recordSecurityEvent(request, "auth.passkey.login-options", "failed", { reason: input.message });
    return NextResponse.json({ error: input.message }, { status: input.status });
  }
}
