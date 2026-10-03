import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../lib/auth";
import {
  archiveOwnerClaim,
  ContextClaimError,
  createOwnerClaim,
  currentContextDate,
  isEligibleClaim,
  listClaimHistory,
  listOwnerClaims,
  reviewOwnerClaim,
  updateOwnerClaim,
  type ClaimEvidenceMetadata,
  type ClaimFreshness,
  type ClaimLiteralType,
  type ClaimReviewStatus,
  type ClaimSensitivity,
  type ClaimSourceMetadata,
} from "../../../../lib/context-claims";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = Record<string, unknown>;

function literal(body: Body) {
  if (!body.literal || typeof body.literal !== "object" || Array.isArray(body.literal)) return undefined;
  const value = body.literal as Record<string, unknown>;
  return { type: String(value.type || "") as ClaimLiteralType, value: value.value as string | number | boolean };
}

function ref(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return { entityId: String((value as Record<string, unknown>).entityId || "") };
}

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "context-claims-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId") || "";
    const claimId = url.searchParams.get("claimId") || "";
    if (claimId) return NextResponse.json({ history: listClaimHistory(workspaceId, claimId) });
    const projectId = url.searchParams.get("projectId") || undefined;
    const claims = listOwnerClaims(workspaceId, {
      includeArchived: url.searchParams.get("includeArchived") === "true",
      projectId,
    });
    const today = currentContextDate();
    return NextResponse.json({
      schemaVersion: 1,
      claims: claims.map((claim) => ({ ...claim, eligibleForAI: isEligibleClaim(claim, projectId, today) })),
    });
  } catch (error) {
    const status = error instanceof ContextClaimError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Context claims are unavailable" }, { status });
  }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "context-claims-write", 120, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<Body>(request, 40 * 1024);
    const action = String(body.action || "");
    const common = {
      commandId: String(body.idempotencyKey || ""),
      workspaceId: String(body.workspaceId || ""),
      id: String(body.id || ""),
      expectedRevision: Number(body.expectedRevision),
    };
    let result;
    if (action === "create" || action === "update") {
      const value = {
        ...common,
        predicate: String(body.predicate || ""),
        literal: literal(body),
        target: ref(body.target),
        freshness: String(body.freshness || "") as ClaimFreshness,
        sensitivity: String(body.sensitivity || "") as ClaimSensitivity,
        validFrom: body.validFrom == null ? null : String(body.validFrom),
        validTo: body.validTo == null ? null : String(body.validTo),
        source: body.source as ClaimSourceMetadata | null | undefined,
        evidence: body.evidence as ClaimEvidenceMetadata | null | undefined,
      };
      result = action === "create"
        ? createOwnerClaim({ ...value, expectedRevision: common.expectedRevision as 0, subject: ref(body.subject)! })
        : updateOwnerClaim(value);
    } else if (action === "review") {
      result = reviewOwnerClaim({ ...common, decision: String(body.decision || "") as ClaimReviewStatus,
        reason: body.reason == null ? undefined : String(body.reason) });
    } else if (action === "archive") {
      result = archiveOwnerClaim(common);
    } else {
      throw new HttpInputError("Unknown context claim action");
    }
    recordSecurityEvent(request, `context.claim.${action}`, "allowed", { objectId: common.id });
    return NextResponse.json(result, { status: action === "create" ? 201 : 200 });
  } catch (error) {
    const status = error instanceof ContextClaimError ? error.status : error instanceof HttpInputError ? error.status : 400;
    recordSecurityEvent(request, "context.claim.write", "failed", {
      reason: error instanceof ContextClaimError ? error.code : "invalid_request",
    });
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Context claim request failed",
      code: error instanceof ContextClaimError ? error.code : "invalid_request",
    }, { status });
  }
}
