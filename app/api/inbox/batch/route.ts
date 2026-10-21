import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../lib/auth";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";
import { fenceRestoredClient } from "../../../../lib/restore-fence";
import { commitInboxBatch, InboxBatchStale, validateInboxBatch } from "../../../../lib/inbox-batch-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "inbox.batch", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  const limited = enforceRateLimit(request, "inbox-batch", 120, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  let body: unknown;
  try {
    requireSameOrigin(request);
    body = await readJsonBody(request, 32 * 1024);
    // A restore may complete during body streaming; refuse stale client intent
    // before the synchronous authoritative SQLite commit.
    const fencedAgain = fenceRestoredClient(request);
    if (fencedAgain) return fencedAgain;
    validateInboxBatch(body);
  } catch (error) {
    const problem = error instanceof HttpInputError ? error : new HttpInputError("Invalid Inbox batch");
    recordSecurityEvent(request, "inbox.batch", "rejected", { reason: problem.message });
    return NextResponse.json({ error: problem.message }, { status: problem.status });
  }
  try {
    const result = commitInboxBatch(body);
    recordSecurityEvent(request, "inbox.batch", "allowed", { affected: result.affected, workspaceScope: "single" });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const stale = error instanceof InboxBatchStale;
    recordSecurityEvent(request, "inbox.batch", "rejected", { reason: stale ? "stale-selection" : "write-failed" });
    return NextResponse.json({ error: stale ? "Inbox batch changed; review again" : "Inbox batch failed" },
      { status: stale ? 409 : 500, headers: { "cache-control": "no-store" } });
  }
}
