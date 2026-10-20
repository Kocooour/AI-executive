import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../lib/auth";
import { ContextCommandError } from "../../../../lib/context-commands";
import { explainOwnerClaim } from "../../../../lib/context-search";
import { enforceRateLimit } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  // Raw sources, review events and history are exclusively for the authenticated owner.
  if (request.headers.has("authorization") || !isAuthenticated(request)) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401, headers });
  }
  const limited = enforceRateLimit(request, "context-explain-v1", 120, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status, headers });
  try {
    const params = new URL(request.url).searchParams;
    const result = explainOwnerClaim(params.get("workspaceId") || "", params.get("claimId") || "");
    recordSecurityEvent(request, "context.explain", "allowed", { workspaceId: result.workspaceId, objectId: result.claim.id });
    return NextResponse.json(result, { headers });
  } catch (error) {
    recordSecurityEvent(request, "context.explain", "failed", { reason: error instanceof ContextCommandError ? error.code : "invalid_request" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Context history unavailable" },
      { status: error instanceof ContextCommandError ? error.status : 400, headers });
  }
}
