import { NextResponse } from "next/server";
import { fenceRestoredClient } from "../../../../lib/restore-fence";
import { isAuthenticated } from "../../../../lib/auth";
import { archiveStandaloneSubject, createStandaloneSubject,
  listStandaloneSubjectHistory, listStandaloneSubjects, matchingStandaloneSubjects,
  renameStandaloneSubject, type StandaloneSubjectType } from "../../../../lib/context-subjects";
import { ContextCommandError } from "../../../../lib/context-commands";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const status = error instanceof ContextCommandError ? error.status : error instanceof HttpInputError ? error.status : 400;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Context subjects unavailable",
    code: error instanceof ContextCommandError ? error.code : "invalid_request" }, { status });
}

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "context-subjects-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId") || "";
    const historyId = url.searchParams.get("historyId");
    if (historyId) return NextResponse.json({ history: listStandaloneSubjectHistory(workspaceId, historyId) });
    const type = url.searchParams.get("type");
    const query = url.searchParams.get("query") || "";
    const subjects = type && (type === "person" || type === "organization") && query
      ? matchingStandaloneSubjects(workspaceId, type, query)
      : listStandaloneSubjects(workspaceId, { query, includeArchived: url.searchParams.get("includeArchived") === "true" });
    return NextResponse.json({ subjects }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "context-subjects-write", 120, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<Record<string, unknown>>(request, 8 * 1024);
    const action = String(body.action || "");
    const common = { commandId: String(body.idempotencyKey || ""), workspaceId: String(body.workspaceId || ""),
      id: String(body.id || ""), expectedRevision: Number(body.expectedRevision) };
    const result = action === "create" ? createStandaloneSubject({ ...common, expectedRevision: common.expectedRevision as 0,
      type: String(body.type || "") as StandaloneSubjectType, title: String(body.title || "") })
      : action === "rename" ? renameStandaloneSubject({ ...common, title: String(body.title || "") })
      : action === "archive" ? archiveStandaloneSubject(common)
      : (() => { throw new HttpInputError("Unknown context subject action"); })();
    recordSecurityEvent(request, `context.subject.${action}`, "allowed", { objectId: common.id });
    return NextResponse.json(result, { status: action === "create" ? 201 : 200 });
  } catch (error) {
    recordSecurityEvent(request, "context.subject.write", "failed", { reason: error instanceof ContextCommandError ? error.code : "invalid_request" });
    return errorResponse(error);
  }
}
