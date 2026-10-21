import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../../lib/auth";
import { fenceRestoredClient } from "../../../../../lib/restore-fence";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../lib/http-security";
import { MailError, readGmailThread } from "../../../../../lib/mail-gmail";
import { recordSecurityEvent } from "../../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

// Account and thread identifiers are omitted from access-log URLs. No Gmail write.
export async function POST(request: Request) {
  if (!isAuthenticated(request)) return json({ error: "Authentication required" }, 401);
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "gmail-thread-read", 30, 10 * 60_000);
    if (limited) return json({ error: limited.error }, limited.status);
    const input = await readJsonBody<Record<string, unknown>>(request, 2048);
    const fencedAgain = fenceRestoredClient(request);
    if (fencedAgain) return fencedAgain;
    const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : "";
    const accountId = typeof input.accountId === "string" ? input.accountId : "";
    const threadId = typeof input.threadId === "string" ? input.threadId : "";
    if (!/^[0-9a-f-]{36}$/i.test(accountId) || !/^[0-9a-f]{5,64}$/i.test(threadId))
      throw new MailError("Mail query is invalid", 400);
    const thread = await readGmailThread({ workspaceId, accountId, threadId });
    recordSecurityEvent(request, "mail.gmail.thread.read", "allowed", { provider: "gmail" });
    return json({ thread });
  } catch (error) {
    recordSecurityEvent(request, "mail.gmail.thread.read", "rejected", { provider: "gmail" });
    return json({ error: error instanceof MailError || error instanceof HttpInputError ? error.message : "Gmail request failed" },
      error instanceof MailError || error instanceof HttpInputError ? error.status : 502);
  }
}
