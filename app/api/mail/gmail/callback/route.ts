import { NextResponse } from "next/server";
import { authenticationBinding, isAuthenticated } from "../../../../../lib/auth";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../../lib/http-security";
import { finishGmailAuthorization } from "../../../../../lib/mail-gmail";
import { recordSecurityEvent } from "../../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char] || ""));

// Owner session cookies are SameSite=Strict. A cross-site Google redirect cannot carry them.
// Serve a first-party, no-referrer completion page, then submit a same-origin POST with the
// owner session from that page. Never weaken the existing session cookie policy.
export async function GET(request: Request) {
  const limited = enforceRateLimit(request, "gmail-oauth-landing", 30, 60 * 60_000);
  if (limited) return new Response("Too many attempts", { status: 429, headers: noStore });
  const params = new URL(request.url).searchParams;
  const state = params.get("state") || "";
  const code = params.get("code") || "";
  if (params.has("error") || !/^[A-Za-z0-9_-]{40,60}$/.test(state) || !code || code.length > 4096)
    return new Response("Gmail authorization was not completed. Return to Lumi.", { status: 400, headers: noStore });
  const html = '<!doctype html><html lang="cs"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer"><title>Propojení Gmailu · Lumi</title></head>' +
    '<body><main><h1>Dokončení propojení Gmailu</h1><p id="status">Ověřuji připojení…</p>' +
    '<form id="gmail-complete" method="post" action="/api/mail/gmail/callback">' +
    '<input type="hidden" name="state" value="' + escapeHtml(state) + '">' +
    '<input type="hidden" name="code" value="' + escapeHtml(code) + '">' +
    '<button type="submit">Dokončit připojení</button></form>' +
    '<p><a href="/?view=Settings">Zpět do Lumi</a></p></main>' +
    '<script src="/mail-oauth-finish.js" defer></script></body></html>';
  return new Response(html, { headers: {
    ...noStore, "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  } });
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: noStore });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "gmail-oauth-finish", 20, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status, headers: noStore });
    const input = await readJsonBody<Record<string, unknown>>(request, 8192);
    const state = typeof input.state === "string" ? input.state : "";
    const code = typeof input.code === "string" ? input.code : "";
    await finishGmailAuthorization(state, code, authenticationBinding(request));
    recordSecurityEvent(request, "mail.gmail.connect.finish", "allowed", { provider: "gmail" });
    return NextResponse.json({ connected: true }, { headers: noStore });
  } catch (error) {
    recordSecurityEvent(request, "mail.gmail.connect.finish", "rejected", { provider: "gmail" });
    return NextResponse.json({ error: error instanceof HttpInputError ? error.message : "Gmail connection failed" },
      { status: error instanceof HttpInputError ? error.status : 400, headers: noStore });
  }
}
