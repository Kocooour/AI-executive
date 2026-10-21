import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../../lib/auth";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../lib/http-security";
import { MailError, readGmailMessages } from "../../../../../lib/mail-gmail";
import { recordSecurityEvent } from "../../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

// Read-only POST keeps search strings and mailbox IDs out of URLs/access logs.
export async function POST(request: Request) {
  if (!isAuthenticated(request)) return json({ error: "Authentication required" }, 401);
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "gmail-messages-read", 40, 10 * 60_000);
    if (limited) return json({ error: limited.error }, limited.status);
    const body = await readJsonBody<Record<string, unknown>>(request, 4096);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const folder = body.folder;
    if (!/^[0-9a-f-]{36}$/i.test(accountId) || (folder !== "inbox" && folder !== "sent"))
      throw new MailError("Mail query is invalid", 400);
    if (body.q !== undefined && typeof body.q !== "string") throw new MailError("Mail query is invalid", 400);
    const result = await readGmailMessages({ workspaceId, accountId, folder, q: body.q as string | undefined });
    recordSecurityEvent(request, "mail.gmail.messages.read", "allowed", { provider: "gmail" });
    return json(result);
  } catch (error) {
    recordSecurityEvent(request, "mail.gmail.messages.read", "rejected", { provider: "gmail" });
    return json({ error: error instanceof MailError || error instanceof HttpInputError ? error.message : "Gmail request failed" },
      error instanceof MailError || error instanceof HttpInputError ? error.status : 502);
  }
}
