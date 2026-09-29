import { NextResponse } from "next/server";
import {
  createSessionToken,
  getAuthState,
  sessionCookieName,
  sessionMaxAgeSeconds,
  verifyPassword,
} from "../../../../lib/auth";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const state = getAuthState(request);
    if (!state.enabled) return NextResponse.json({ enabled: false, authenticated: true });
    if (!state.configured) {
      recordSecurityEvent(request, "auth.login", "failed", { reason: "not-configured" });
      return NextResponse.json(
        { error: "Authentication is not configured" },
        { status: 503 },
      );
    }
    const limited = enforceRateLimit(request, "auth-login", 10, 15 * 60_000);
    if (limited) {
      recordSecurityEvent(request, "auth.login", "rejected", { reason: "rate-limit" });
      return NextResponse.json(
        { error: "Too many login attempts" },
        { status: 429, headers: { "retry-after": String(limited.retryAfter) } },
      );
    }
    const body = await readJsonBody<{ password?: unknown }>(request, 8 * 1024);
    if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 1024) {
      throw new HttpInputError("Invalid credentials", 401);
    }
    if (!(await verifyPassword(body.password))) {
      recordSecurityEvent(request, "auth.login", "rejected", { reason: "credentials" });
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }
    const response = NextResponse.json({ enabled: true, authenticated: true });
    response.cookies.set(sessionCookieName, createSessionToken(), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: sessionMaxAgeSeconds,
    });
    recordSecurityEvent(request, "auth.login", "allowed");
    return response;
  } catch (error) {
    recordSecurityEvent(request, "auth.login", "failed", { reason: "invalid-request" });
    const status = error instanceof HttpInputError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof HttpInputError ? error.message : "Login failed" },
      { status },
    );
  }
}
