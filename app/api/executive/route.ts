import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../lib/auth";
import { enforceRateLimit, readJsonBody, requireSameOrigin } from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";
import { readSnapshot } from "../../../lib/server-store";
import { listPACTAgents, listPACTRuns } from "../../../lib/pact";
import { runManualPACTAgent, type ManualPACTAgentId } from "../../../lib/pact-agent-runs";

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
  return NextResponse.json({
    // Morning and evening briefings were removed; clients cached before that still read this field.
    briefings: [],
    agents: listPACTAgents().filter((agent) => agent.id !== "aifred"),
    agentRuns: listPACTRuns(workspaceId, 40),
  });
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "executive-run", 12, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<{
      agentId?: ManualPACTAgentId;
      workspaceId?: string;
      language?: "cs" | "en";
    }>(request, 4096);
    if (typeof body.workspaceId !== "string" ||
        !/^[A-Za-z0-9:_-]{1,120}$/.test(body.workspaceId) || body.workspaceId === "all") {
      return NextResponse.json({ error: "Invalid agent request" }, { status: 400 });
    }
    if (!(["project-manager", "meeting-prep"] as unknown[]).includes(body.agentId)) {
      return NextResponse.json({ error: "Unknown or non-runnable agent" }, { status: 400 });
    }
    const result = { agentResult: runManualPACTAgent(body.agentId!, body.workspaceId, body.language === "en" ? "en" : "cs") };
    recordSecurityEvent(request, "executive.agent-run", "allowed", { kind: body.agentId });
    return NextResponse.json(result);
  } catch (error) {
    recordSecurityEvent(request, "executive.agent-run", "failed");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Agent run failed" }, { status: 400 });
  }
}
