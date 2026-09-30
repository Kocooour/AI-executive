import { NextResponse } from "next/server";
import {
  aiAuditDetails,
  cancelAIProposal,
  confirmAIProposal,
  undoAIAction,
} from "../../../../lib/ai-actions";
import { authenticationBinding, isAuthenticated } from "../../../../lib/auth";
import {
  enforceRateLimit,
  HttpInputError,
  readJsonBody,
  requireSameOrigin,
} from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "ai.action", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  let identifier = "";
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "ai-actions", 120, 60 * 60_000);
    if (limited) {
      recordSecurityEvent(request, "ai.action", "rejected", { reason: "rate-limit" });
      return NextResponse.json(
        { error: limited.error },
        { status: limited.status, headers: { "retry-after": String(limited.retryAfter) } },
      );
    }
    const body = await readJsonBody<{
      action?: unknown;
      proposalId?: unknown;
      actionId?: unknown;
    }>(request, 16 * 1024);
    const action = String(body.action || "");
    identifier = String(action === "undo" ? body.actionId || "" : body.proposalId || "");
    if (!/^[0-9a-f-]{36}$/i.test(identifier)) throw new HttpInputError("Action identifier is invalid");
    const binding = authenticationBinding(request);
    if (action === "confirm") {
      const result = confirmAIProposal(identifier, binding);
      recordSecurityEvent(request, "ai.action.confirm", "allowed", aiAuditDetails(identifier, result?.actionId));
      return NextResponse.json(result);
    }
    if (action === "cancel") {
      const cancelled = cancelAIProposal(identifier, binding);
      recordSecurityEvent(request, "ai.action.cancel", cancelled ? "allowed" : "rejected", aiAuditDetails(identifier));
      return NextResponse.json({ cancelled }, { status: cancelled ? 200 : 409 });
    }
    if (action === "undo") {
      const result = undoAIAction(identifier, binding);
      recordSecurityEvent(request, "ai.action.undo", "allowed", aiAuditDetails(identifier, identifier));
      return NextResponse.json(result);
    }
    throw new HttpInputError("Unknown AI action");
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI action failed";
    const conflict = /changed|expired|pending|no longer|not found/i.test(message);
    recordSecurityEvent(request, "ai.action", "failed", {
      reason: conflict ? "state-conflict" : "invalid-request",
      ...(identifier ? aiAuditDetails(identifier) : {}),
    });
    return NextResponse.json(
      { error: message },
      { status: error instanceof HttpInputError ? error.status : conflict ? 409 : 400 },
    );
  }
}
