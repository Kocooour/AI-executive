import { NextResponse } from "next/server";
import { releaseOwnerRead } from "../../../../lib/owner-session-read-release";
import { isAuthenticated } from "../../../../lib/auth";
import { ContextCommandError } from "../../../../lib/context-commands";
import { searchContext } from "../../../../lib/context-search";
import { enforceRateLimit } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  // A bearer token, even combined with a cookie, is not an owner UI credential here.
  if (request.headers.has("authorization") || !isAuthenticated(request)) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401, headers });
  }
  const limited = enforceRateLimit(request, "context-search-v1", 120, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status, headers });
  try {
    const params = new URL(request.url).searchParams;
    const limitText = params.get("limit");
    const result = searchContext({
      actor: "owner", workspaceId: params.get("workspaceId") || "", query: params.get("q") || "",
      kinds: params.has("kinds") ? (params.get("kinds") || "").split(",") : undefined,
      limit: limitText === null ? undefined : /^\d+$/.test(limitText) ? Number(limitText) : -1,
      cursor: params.get("cursor") || undefined,
    });
    recordSecurityEvent(request, "context.search", "allowed", { workspaceId: result.workspaceId });
    return releaseOwnerRead(request, NextResponse.json(result, { headers }));
  } catch (error) {
    recordSecurityEvent(request, "context.search", "failed", { reason: error instanceof ContextCommandError ? error.code : "invalid_request" });
    return releaseOwnerRead(request, NextResponse.json({ error: error instanceof Error ? error.message : "Context read failed" },
      { status: error instanceof ContextCommandError ? error.status : 400, headers }));
  }
}
