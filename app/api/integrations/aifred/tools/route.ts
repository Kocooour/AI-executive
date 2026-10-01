import { NextResponse } from "next/server";
import { isIntegrationAuthenticated } from "../../../../../lib/auth";
import { executePACTReadTool, type PACTToolName } from "../../../../../lib/pact-tools";
import { enforceRateLimit, HttpInputError, readJsonBody } from "../../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const readTools = new Set<PACTToolName>([
  "task.read",
  "project.read",
  "note.read",
  "calendar.read",
  "calendar.free_time",
  "context.read",
]);

export async function POST(request: Request) {
  if (!isIntegrationAuthenticated(request)) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    const limited = enforceRateLimit(request, "integration-tools", 120, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<{ workspaceId?: unknown; tool?: unknown; input?: unknown }>(request, 32 * 1024);
    const workspaceId = String(body.workspaceId || "");
    const tool = String(body.tool || "") as PACTToolName;
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(workspaceId) || workspaceId === "all") throw new HttpInputError("Explicit workspace is required");
    if (!readTools.has(tool)) throw new HttpInputError("Read tool is invalid");
    const data = executePACTReadTool(tool as Exclude<PACTToolName, "task.propose">, workspaceId,
      body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : {});
    recordSecurityEvent(request, "integration.tool.read", "allowed", { tool });
    return NextResponse.json({ data });
  } catch (error) {
    const status = error instanceof HttpInputError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Tool request failed" }, { status });
  }
}
