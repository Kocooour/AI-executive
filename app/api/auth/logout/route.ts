import { NextResponse } from "next/server";
import { getAuthState, sessionCookieName } from "../../../../lib/auth";
import { revokeAllOwnerSessions } from "../../../../lib/owner-session-revocation";
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
  // An anonymous request may clear its own cookie, but must not remotely
  // invalidate the real owner's sessions. Every successful authenticated
  // logout commits the global server-side revocation before clearing cookies.
  const state = getAuthState(request);
  if (state.enabled && state.authenticated) {
    try {
      revokeAllOwnerSessions();
    } catch {
      recordSecurityEvent(request, "auth.logout", "failed", { reason: "revocation-unavailable" });
      return NextResponse.json({ error: "Logout unavailable" }, {
        status: 503, headers: { "cache-control": "no-store" },
      });
    }
  }
  const response = NextResponse.json({ authenticated: false }, {
    headers: { "cache-control": "no-store" },
  });
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
