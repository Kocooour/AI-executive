import { NextResponse } from "next/server";
import { fenceRestoredClient } from "../../../../lib/restore-fence";
import { isAuthenticated } from "../../../../lib/auth";
import { ContextCommandError } from "../../../../lib/context-commands";
import { archiveContextSource, createContextSource, listContextSources, updateContextSource, type SourceCoverage, type SourceSensitivity } from "../../../../lib/context-sources";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

// Sources of the Context Graph. Owner session only: no bearer token reaches this route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = Record<string, unknown>;
const optional = (value: unknown) => value == null ? null : String(value);

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "context-sources-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  try {
    const url = new URL(request.url);
    const sources = listContextSources(url.searchParams.get("workspaceId") || "", { includeArchived: url.searchParams.get("includeArchived") === "true" });
    return NextResponse.json({ schemaVersion: 1, sources }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof ContextCommandError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Context sources are unavailable" }, { status });
  }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "context-sources-write", 120, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<Body>(request, 16 * 1024);
    const action = String(body.action || "");
    const common = { commandId: String(body.idempotencyKey || ""), workspaceId: String(body.workspaceId || ""), id: String(body.id || ""),
      expectedRevision: Number(body.expectedRevision) };
    const fields = { provider: optional(body.provider), account: optional(body.account), externalId: optional(body.externalId), locator: optional(body.locator),
      author: optional(body.author), authorRole: optional(body.authorRole), sourceAt: optional(body.sourceAt), ingestedAt: optional(body.ingestedAt),
      coverage: optional(body.coverage) as SourceCoverage | null, sensitivity: optional(body.sensitivity) as SourceSensitivity | null };
    let result;
    if (action === "create") result = createContextSource({ ...common, ...fields, expectedRevision: common.expectedRevision as 0 });
    else if (action === "update") result = updateContextSource({ ...common, ...fields, reason: optional(body.reason) });
    else if (action === "archive") result = archiveContextSource(common);
    else throw new HttpInputError("Unknown context source action");
    recordSecurityEvent(request, `context.source.${action}`, "allowed", { objectId: common.id });
    return NextResponse.json(result, { status: action === "create" && !result.deduplicated ? 201 : 200 });
  } catch (error) {
    const status = error instanceof ContextCommandError ? error.status : error instanceof HttpInputError ? error.status : 400;
    recordSecurityEvent(request, "context.source.write", "failed", { reason: error instanceof ContextCommandError ? error.code : "invalid_request" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Context source request failed",
      code: error instanceof ContextCommandError ? error.code : "invalid_request" }, { status });
  }
}
