import { NextResponse } from "next/server";
import {
  readSnapshot,
  replaceSnapshot,
  validateSnapshot,
} from "../../../lib/server-store";
import {
  enforceRateLimit,
  HttpInputError,
  readJsonBody,
  requireSameOrigin,
} from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";
import { isAuthenticated } from "../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "store.read", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const limited = enforceRateLimit(request, "store-read", 600, 10 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "store.read", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, {
      status: limited.status,
      headers: { "retry-after": String(limited.retryAfter) },
    });
  }
  recordSecurityEvent(request, "store.read", "allowed");
  return NextResponse.json(readSnapshot(), {
    headers: { "cache-control": "no-store" },
  });
}

export async function PUT(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "store.write", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const limited = enforceRateLimit(request, "store-write", 3000, 10 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "store.write", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, {
      status: limited.status,
      headers: { "retry-after": String(limited.retryAfter) },
    });
  }
  let body: any;
  try {
    requireSameOrigin(request);
    body = await readJsonBody(request, 5 * 1024 * 1024);
  } catch (error) {
    const inputError = error instanceof HttpInputError ? error : new HttpInputError("Invalid request");
    recordSecurityEvent(request, "store.write", "rejected", { reason: inputError.message });
    return NextResponse.json({ error: inputError.message }, { status: inputError.status });
  }
  if (!Array.isArray(body.entities) || !Array.isArray(body.relations)) {
    recordSecurityEvent(request, "store.write", "rejected", { reason: "invalid-snapshot" });
    return NextResponse.json({ error: "Invalid snapshot" }, { status: 400 });
  }
  if (body.entities.length > 20000 || body.relations.length > 50000) {
    recordSecurityEvent(request, "store.write", "rejected", { reason: "snapshot-count-limit" });
    return NextResponse.json({ error: "Snapshot is too large" }, { status: 413 });
  }
  const baseRevision = Number(body.baseRevision);
  const deletedIds = Array.isArray(body.deletedIds) ? body.deletedIds : [];
  const revivedIds = Array.isArray(body.revivedIds) ? body.revivedIds : [];
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    recordSecurityEvent(request, "store.write", "rejected", { reason: "invalid-revision" });
    return NextResponse.json({ error: "Invalid base revision" }, { status: 400 });
  }
  if (
    deletedIds.length > 20000 ||
    revivedIds.length > 20000 ||
    [...deletedIds, ...revivedIds].some(
      (id) => typeof id !== "string" || id.length === 0 || id.length > 240,
    )
  ) {
    recordSecurityEvent(request, "store.write", "rejected", { reason: "invalid-change-ids" });
    return NextResponse.json({ error: "Invalid deletion or revival IDs" }, { status: 400 });
  }
  try {
    validateSnapshot(body);
  } catch (error) {
    recordSecurityEvent(request, "store.write", "rejected", { reason: "snapshot-validation" });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid snapshot" },
      { status: 400 },
    );
  }
  const result = replaceSnapshot(
    baseRevision,
    body.entities,
    body.relations,
    deletedIds,
    revivedIds,
  );
  recordSecurityEvent(request, "store.write", "allowed", {
    conflict: result.conflict,
    entityCount: body.entities.length,
    relationCount: body.relations.length,
    deletedCount: deletedIds.length,
    revivedCount: revivedIds.length,
  });
  return NextResponse.json(result.snapshot, {
    status: result.conflict ? 409 : 200,
    headers: { "cache-control": "no-store" },
  });
}
