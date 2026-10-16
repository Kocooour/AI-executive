import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../lib/auth";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";
import { getWorkSession, transitionWorkSession, WorkSessionError, type WorkSessionAction, type WorkSessionState } from "../../../lib/work-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "work-session-read", 600, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
    return NextResponse.json(getWorkSession(workspaceId), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof WorkSessionError ? error.status : error instanceof HttpInputError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Work session unavailable" }, { status });
  }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "work-session-write", 240, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<Record<string, unknown>>(request, 8192);
    const action = String(body.action || "") as WorkSessionAction;
    if (!["start", "pause", "resume", "finish"].includes(action)) throw new WorkSessionError("Unknown work session action");
    const result = transitionWorkSession({
      workspaceId: String(body.workspaceId || ""), action,
      idempotencyKey: String(body.idempotencyKey || ""),
      taskId: body.taskId == null ? undefined : String(body.taskId),
      expectedTaskUpdatedAt: body.expectedTaskUpdatedAt == null ? undefined : Number(body.expectedTaskUpdatedAt),
      expectedRevision: Number(body.expectedRevision), expectedState: String(body.expectedState || "") as "idle" | WorkSessionState,
    });
    recordSecurityEvent(request, `work-session.${action}`, "allowed", { workspaceScope: "single" });
    return NextResponse.json(result, { status: action === "start" ? 201 : 200 });
  } catch (error) {
    const status = error instanceof WorkSessionError ? error.status : error instanceof HttpInputError ? error.status : 400;
    recordSecurityEvent(request, "work-session.write", "failed", { reason: error instanceof WorkSessionError ? error.code : "invalid_request" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Work session failed", code: error instanceof WorkSessionError ? error.code : "invalid_request" }, { status });
  }
}
