import { NextResponse } from "next/server";
import { authenticationBinding, isAuthenticated } from "../../../../lib/auth";
import { fenceRestoredClient } from "../../../../lib/restore-fence";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { disconnectMailAccount, listMailAccounts, MailError, startGmailAuthorization } from "../../../../lib/mail-gmail";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (error: unknown) => json(
  { error: error instanceof MailError || error instanceof HttpInputError ? error.message : "Mail request failed" },
  error instanceof MailError || error instanceof HttpInputError ? error.status : 500,
);

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return json({ error: "Authentication required" }, 401);
  const limited = enforceRateLimit(request, "gmail-accounts-read", 120, 10 * 60_000);
  if (limited) return json({ error: limited.error }, limited.status);
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
    return json({ accounts: listMailAccounts(workspaceId) });
  } catch (error) { return fail(error); }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return json({ error: "Authentication required" }, 401);
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  let action = "unknown";
  try {
    requireSameOrigin(request);
    const body = await readJsonBody<Record<string, unknown>>(request, 4096);
    const fencedAgain = fenceRestoredClient(request);
    if (fencedAgain) return fencedAgain;
    action = body.action === "start" || body.action === "disconnect" ? body.action : "unknown";
    if (action === "unknown") throw new MailError("Unknown mail action");
    const limited = enforceRateLimit(request, "gmail-" + action, action === "start" ? 10 : 30, 60 * 60_000);
    if (limited) return json({ error: limited.error }, limited.status);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (action === "start") {
      const url = startGmailAuthorization(workspaceId, authenticationBinding(request));
      recordSecurityEvent(request, "mail.gmail.connect.start", "allowed", { provider: "gmail" });
      return json({ url });
    }
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new MailError("Mail account not found", 404);
    disconnectMailAccount(workspaceId, accountId);
    recordSecurityEvent(request, "mail.gmail.disconnect", "allowed", { provider: "gmail" });
    return json({ removed: true });
  } catch (error) {
    recordSecurityEvent(request, "mail.gmail." + action, "rejected", { provider: "gmail" });
    return fail(error);
  }
}
