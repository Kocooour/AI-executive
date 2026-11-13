import { NextResponse } from "next/server";
import { releaseOwnerRead } from "../../../../lib/owner-session-read-release";
import { isAuthenticated } from "../../../../lib/auth";
import { boundedString, enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { passkeySummaries } from "../../../../lib/passkeys";
import { deletePasskey } from "../../../../lib/server-store";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "auth.passkey.read", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  return releaseOwnerRead(request, NextResponse.json({ passkeys: passkeySummaries() }, { headers: { "cache-control": "no-store" } }));
}

export async function DELETE(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "auth.passkey.delete", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const limited = enforceRateLimit(request, "passkey-delete", 10, 15 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "auth.passkey.delete", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, { status: 429 });
  }
  try {
    requireSameOrigin(request);
    const body = await readJsonBody<{ id?: unknown }>(request, 4096);
    const id = boundedString(body.id, "id", 1024);
    if (!deletePasskey(id)) throw new HttpInputError("Passkey not found", 404);
    recordSecurityEvent(request, "auth.passkey.delete", "allowed");
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const input = error instanceof HttpInputError ? error : new HttpInputError("Passkey could not be removed", 400);
    recordSecurityEvent(request, "auth.passkey.delete", "failed", { reason: input.message });
    return NextResponse.json({ error: input.message }, { status: input.status });
  }
}
