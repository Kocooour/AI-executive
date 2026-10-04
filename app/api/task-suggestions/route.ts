import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../lib/auth";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";
import { suggestTask } from "../../../lib/task-suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "task-suggestions", 120, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<{
      title?: unknown;
      workspaceId?: unknown;
      requestedDate?: unknown;
      explicitPriority?: unknown;
      language?: unknown;
    }>(request, 8192);
    const title = String(body.title || "").trim();
    const workspaceId = String(body.workspaceId || "");
    const requestedDate = body.requestedDate == null ? undefined : String(body.requestedDate);
    const explicitPriority = body.explicitPriority == null ? undefined : String(body.explicitPriority);
    const language = body.language === "en" ? "en" : "cs";
    if (!title || title.length > 1000) throw new HttpInputError("Task title is invalid");
    if (!/^[A-Za-z0-9:_-]{1,120}$/.test(workspaceId) || workspaceId === "all") throw new HttpInputError("Explicit workspace is required");
    if (requestedDate) {
      const parsedDate = new Date(`${requestedDate}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || Number.isNaN(parsedDate.getTime()) ||
          parsedDate.toISOString().slice(0, 10) !== requestedDate) {
        throw new HttpInputError("Requested date is invalid");
      }
    }
    if (explicitPriority && !["none", "low", "medium", "high"].includes(explicitPriority)) throw new HttpInputError("Priority is invalid");
    const suggestion = suggestTask({ title, workspaceId, requestedDate, explicitPriority, language });
    recordSecurityEvent(request, "task.suggest", "allowed", {
      workspaceScope: "single",
      projectSuggested: Boolean(suggestion.projectId),
      newProjectSuggested: Boolean(suggestion.newProjectSuggestion),
      scheduled: Boolean(suggestion.scheduledStart),
    });
    return NextResponse.json({ suggestion });
  } catch (error) {
    const status = error instanceof HttpInputError ? error.status : 400;
    recordSecurityEvent(request, "task.suggest", "failed", { reason: error instanceof HttpInputError ? error.message : "invalid-request" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Suggestion failed" }, { status });
  }
}
