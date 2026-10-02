import { NextResponse } from "next/server";
import { authenticationBinding, isAuthenticated } from "../../../lib/auth";
import { buildDayPlan } from "../../../lib/day-plan";
import { proposeDayPlanBlock } from "../../../lib/ai-actions";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "day-plan-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get("workspaceId") || "";
  const date = params.get("date") || "";
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^[A-Za-z0-9:_-]{1,120}$/.test(workspaceId) || workspaceId === "all" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return NextResponse.json({ error: "Invalid workspace or date" }, { status: 400 });
  }
  try {
    return NextResponse.json(buildDayPlan(workspaceId, date), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Day plan failed" }, { status: 404 });
  }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "day-plan-propose", 120, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<Record<string, unknown>>(request, 4096);
    const workspaceId = String(body.workspaceId || "");
    const date = String(body.date || "");
    const taskId = String(body.taskId || "");
    const start = String(body.start || "");
    const end = String(body.end || "");
    const revision = Number(body.revision);
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(workspaceId) || workspaceId === "all" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date ||
        !/^[A-Za-z0-9:_-]{1,240}$/.test(taskId) || !Number.isSafeInteger(revision) || revision < 0 ||
        !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || end.length > 40 || start.length > 40) {
      throw new HttpInputError("Invalid day plan request");
    }
    const proposal = proposeDayPlanBlock({ sessionBinding: authenticationBinding(request), workspaceId, date, taskId, start, end, revision });
    recordSecurityEvent(request, "day-plan.propose", "allowed", { workspaceScope: "single" });
    return NextResponse.json({ proposal });
  } catch (error) {
    recordSecurityEvent(request, "day-plan.propose", "failed");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Day plan request failed" }, { status: error instanceof HttpInputError ? error.status : 400 });
  }
}
