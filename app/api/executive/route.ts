import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../lib/auth";
import {
  createExecutiveBriefing,
  listExecutiveBriefings,
  type BriefingKind,
} from "../../../lib/executive-briefings";
import { enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";
import { readSnapshot } from "../../../lib/server-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "executive-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "personal";
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(workspaceId) || workspaceId === "all") {
    return NextResponse.json({ error: "A concrete workspace is required" }, { status: 400 });
  }
  if (!readSnapshot().entities.some((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId)) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  return NextResponse.json({ briefings: listExecutiveBriefings(workspaceId, 7) });
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "executive-run", 12, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<{ kind?: BriefingKind; workspaceId?: string }>(request, 4096);
    if (!(["morning", "evening"] as unknown[]).includes(body.kind) ||
        typeof body.workspaceId !== "string" ||
        !/^[A-Za-z0-9:_-]{1,120}$/.test(body.workspaceId) || body.workspaceId === "all") {
      return NextResponse.json({ error: "Invalid briefing request" }, { status: 400 });
    }
    const result = await createExecutiveBriefing(body.kind!, body.workspaceId, Date.now(), true);
    recordSecurityEvent(request, "executive.briefing", "allowed", { kind: body.kind });
    return NextResponse.json(result);
  } catch (error) {
    recordSecurityEvent(request, "executive.briefing", "failed");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Briefing failed" }, { status: 400 });
  }
}
