import { NextResponse } from "next/server";
import { integrationBinding, isIntegrationAuthenticated } from "../../../../lib/auth";
import { planAIRequest } from "../../../../lib/ai-actions";
import { enforceRateLimit, HttpInputError, readJsonBody } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isIntegrationAuthenticated(request)) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    const limited = enforceRateLimit(request, "integration-plan", 60, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<{ workspaceId?: unknown; message?: unknown; focusEntityId?: unknown }>(request, 32 * 1024);
    const workspaceId = String(body.workspaceId || "");
    const message = String(body.message || "").trim();
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(workspaceId) || workspaceId === "all") throw new HttpInputError("Explicit workspace is required");
    if (!message || message.length > 20_000) throw new HttpInputError("Message is invalid");
    const focusEntityId = body.focusEntityId == null ? undefined : String(body.focusEntityId);
    const result = await planAIRequest({
      message,
      readWorkspaceId: workspaceId,
      writeWorkspaceId: workspaceId,
      focusEntityId,
      sessionBinding: integrationBinding(request),
    });
    recordSecurityEvent(request, "integration.plan", "allowed", { proposedWrite: Boolean(result.proposal) });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Integration request failed" }, { status: 400 });
  }
}
