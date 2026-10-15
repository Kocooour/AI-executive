import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../lib/auth";
import { ContextCommandError } from "../../../../lib/context-commands";
import { addClaimEvidence, archiveClaimEvidence, updateClaimEvidence } from "../../../../lib/context-evidence";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

// Evidence of a claim. Owner session only: no bearer token reaches this route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = Record<string, unknown>;
const optional = (value: unknown) => value == null ? null : String(value);

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "context-evidence-write", 120, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<Body>(request, 16 * 1024);
    const action = String(body.action || "");
    const common = { commandId: String(body.idempotencyKey || ""), workspaceId: String(body.workspaceId || ""), id: String(body.id || ""),
      expectedRevision: Number(body.expectedRevision) };
    const fields = { sourceId: String(body.sourceId || ""), locator: optional(body.locator), excerpt: optional(body.excerpt), stance: optional(body.stance) };
    let result;
    if (action === "add") {
      result = addClaimEvidence({ ...common, ...fields, expectedRevision: common.expectedRevision as 0, claimId: String(body.claimId || ""),
        expectedClaimRevision: Number(body.expectedClaimRevision) });
    } else if (action === "update") result = updateClaimEvidence({ ...common, ...fields });
    else if (action === "archive") result = archiveClaimEvidence(common);
    else throw new HttpInputError("Unknown context evidence action");
    recordSecurityEvent(request, `context.evidence.${action}`, "allowed", { objectId: common.id });
    return NextResponse.json(result, { status: action === "add" ? 201 : 200 });
  } catch (error) {
    const status = error instanceof ContextCommandError ? error.status : error instanceof HttpInputError ? error.status : 400;
    recordSecurityEvent(request, "context.evidence.write", "failed", { reason: error instanceof ContextCommandError ? error.code : "invalid_request" });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Context evidence request failed",
      code: error instanceof ContextCommandError ? error.code : "invalid_request" }, { status });
  }
}
