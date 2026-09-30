import { NextResponse } from "next/server";
import { sessionCookieName } from "../../../../lib/auth";
import { requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
  } catch {
    recordSecurityEvent(request, "auth.logout", "rejected", { reason: "cross-origin" });
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(sessionCookieName, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  recordSecurityEvent(request, "auth.logout", "allowed");
  return response;
}
