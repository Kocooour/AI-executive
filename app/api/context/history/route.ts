import { NextResponse } from "next/server";
import { fenceRestoredClient } from "../../../../lib/restore-fence";
import { isAuthenticated } from "../../../../lib/auth";
import { ContextCommandError } from "../../../../lib/context-commands";
import { getContextHistory, runHistoryCommand, type HistoryAction, type HistoryCommandAction } from "../../../../lib/context-history";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

// Undo/Redo of the Context Graph. Only the signed-in owner session may use it: this route accepts
// no bearer token, and nothing under /api/integrations reaches it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const status = error instanceof ContextCommandError ? error.status : error instanceof HttpInputError ? error.status : 400;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Context history unavailable",
    code: error instanceof ContextCommandError ? error.code : "invalid_request" }, { status });
}

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "context-history-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  try {
    const workspaceId = new URL(request.url).searchParams.get("workspaceId") || "";
    return NextResponse.json(getContextHistory(workspaceId), { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "context-history-write", 120, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<Record<string, unknown>>(request, 4 * 1024);
    const action = String(body.action || "");
    if (action !== "undo" && action !== "redo" && action !== "skip") throw new HttpInputError("Unknown context history action");
    const result = runHistoryCommand({ action: action as HistoryCommandAction, stack: body.stack === "redo" ? "redo" : body.stack === "undo" ? "undo" : undefined, commandId: String(body.idempotencyKey || ""),
      workspaceId: String(body.workspaceId || ""), expectedEventId: String(body.expectedEventId || "") });
    recordSecurityEvent(request, `context.history.${action}`, "allowed", { objectId: result.step.objectId });
    return NextResponse.json(result);
  } catch (error) {
    recordSecurityEvent(request, "context.history.write", "failed", { reason: error instanceof ContextCommandError ? error.code : "invalid_request" });
    return errorResponse(error);
  }
}
