import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../../lib/auth";
import { fenceRestoredClient } from "../../../../../lib/restore-fence";
import { HttpInputError, enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../../../lib/http-security";
import { disableMailSync, enableMailSync, listMailSyncStates, MailError, syncMailAccount } from "../../../../../lib/mail-gmail";
import { recordSecurityEvent } from "../../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => NextResponse.json(value, {
  status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

// No metadata or account identifiers in query strings; explicit owner session
// and same-origin request required for every operation, including status.
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
    action = typeof body.action === "string" ? body.action : "unknown";
    if (!["status", "enable", "disable", "sync"].includes(action))
      throw new MailError("Unknown mail sync action", 400);
    const limited = enforceRateLimit(request, "mail-sync-" + action,
      action === "sync" ? 12 : 60, 60 * 60_000);
    if (limited) return json({ error: limited.error }, limited.status);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (action === "status") return json({ accounts: listMailSyncStates(workspaceId) });
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new MailError("Mail account not found", 404);
    if (action === "enable") {
      if (typeof body.retentionDays !== "number" || !Number.isInteger(body.retentionDays))
        throw new MailError("Mail retention is invalid", 400);
      enableMailSync(workspaceId, accountId, body.retentionDays);
    } else if (action === "disable") {
      disableMailSync(workspaceId, accountId);
    } else {
      const result = await syncMailAccount(workspaceId, accountId);
      recordSecurityEvent(request, "mail.gmail.sync.run", "allowed", { provider: "gmail" });
      return json(result);
    }
    recordSecurityEvent(request, "mail.gmail.sync." + action, "allowed", { provider: "gmail" });
    return json({ accounts: listMailSyncStates(workspaceId) });
  } catch (error) {
    recordSecurityEvent(request, "mail.gmail.sync." + action, "rejected", { provider: "gmail" });
    return json({ error: error instanceof MailError || error instanceof HttpInputError ? error.message : "Mail sync failed" },
      error instanceof MailError || error instanceof HttpInputError ? error.status : 500);
  }
}
