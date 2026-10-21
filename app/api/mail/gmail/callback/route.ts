import { NextResponse } from "next/server";
import { authenticationBinding, isAuthenticated } from "../../../../../lib/auth";
import { enforceRateLimit } from "../../../../../lib/http-security";
import { finishGmailAuthorization } from "../../../../../lib/mail-gmail";
import { recordSecurityEvent } from "../../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Google redirects a browser with GET. No cross-origin POST and no OAuth code is ever echoed.
const errorResponse = () => new Response("Gmail connection failed. Return to Lumi and try again.", {
  status: 400, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
});

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return new Response("Authentication required", { status: 401, headers: { "cache-control": "no-store" } });
  const limited = enforceRateLimit(request, "gmail-oauth-callback", 20, 60 * 60_000);
  if (limited) return new Response("Too many attempts", { status: 429, headers: { "cache-control": "no-store" } });
  const params = new URL(request.url).searchParams;
  const state = params.get("state") || "";
  const code = params.get("code") || "";
  if (params.has("error") || !state || !code) return errorResponse();
  try {
    await finishGmailAuthorization(state, code, authenticationBinding(request));
    recordSecurityEvent(request, "mail.gmail.connect.finish", "allowed", { provider: "gmail" });
    const callbackUrl = process.env.AI_EXECUTIVE_GMAIL_REDIRECT_URI || "";
    const landing = new URL("/?view=Settings&gmail=connected", callbackUrl);
    return NextResponse.redirect(landing, { status: 303, headers: { "cache-control": "no-store", referrer: "no-referrer" } });
  } catch {
    recordSecurityEvent(request, "mail.gmail.connect.finish", "rejected", { provider: "gmail" });
    return errorResponse();
  }
}
