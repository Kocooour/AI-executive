import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../lib/auth";
import { approveContextInboxClaim, previewContextInbox } from "../../../../lib/context-inbox";
import { ContextCommandError } from "../../../../lib/context-commands";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "context-inbox", 30, 10 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status, headers: { "retry-after": String(limited.retryAfter) } });
    const body = await readJsonBody<Record<string, unknown>>(request, 24 * 1024);
    const action = String(body.action || "preview");
    const workspaceId = String(body.workspaceId || "");
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(workspaceId) || workspaceId === "all") throw new HttpInputError("Invalid workspace");
    if (action === "preview") {
      const text = String(body.text || "");
      if (!text.trim() || text.length > 20_000) throw new HttpInputError("Context text is invalid", text.length > 20_000 ? 413 : 400);
      const result = previewContextInbox(workspaceId, text);
      recordSecurityEvent(request, "context.inbox.preview", "allowed", { workspaceScope: "single", proposalCount: result.proposals.length });
      return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
    }
    if (action === "approve") {
      const literal = body.literal && typeof body.literal === "object" && !Array.isArray(body.literal)
        ? body.literal as { type: "string" | "number" | "boolean" | "date"; value: string | number | boolean } : null;
      const targetSubjectId = body.targetSubjectId == null ? undefined : String(body.targetSubjectId);
      if (Boolean(literal) === Boolean(targetSubjectId)) throw new HttpInputError("Exactly one literal or target is required");
      const result = approveContextInboxClaim({ commandId: String(body.idempotencyKey || ""), workspaceId,
        id: String(body.id || ""), subjectId: String(body.subjectId || ""), predicate: String(body.predicate || ""), literal: literal || undefined,
        targetSubjectId,
        freshness: String(body.freshness || "needs_review") as "current" | "needs_review" | "stale",
        validFrom: body.validFrom == null ? null : String(body.validFrom), validTo: body.validTo == null ? null : String(body.validTo),
        evidenceExcerpt: body.evidenceExcerpt == null ? undefined : String(body.evidenceExcerpt) });
      recordSecurityEvent(request, "context.inbox.approve", "allowed", { objectId: String(body.id || "") });
      return NextResponse.json(result, { status: 201 });
    }
    throw new HttpInputError("Unknown context inbox action");
  } catch (error) {
    const status = error instanceof ContextCommandError ? error.status : error instanceof HttpInputError ? error.status : 400;
    recordSecurityEvent(request, "context.inbox", "failed");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Context inbox failed" }, { status });
  }
}
