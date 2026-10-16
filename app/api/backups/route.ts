import { NextResponse } from "next/server";
import {
  createBackup,
  listBackups,
  restoreBackup,
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
    recordSecurityEvent(request, "backup.read", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const limited = enforceRateLimit(request, "backup-read", 120, 10 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "backup.read", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, {
      status: limited.status,
      headers: { "retry-after": String(limited.retryAfter) },
    });
  }
  recordSecurityEvent(request, "backup.read", "allowed");
  return NextResponse.json(
    { backups: listBackups() },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "backup.write", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const limited = enforceRateLimit(request, "backup-write", 12, 60 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "backup.write", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, {
      status: limited.status,
      headers: { "retry-after": String(limited.retryAfter) },
    });
  }
  let body: any;
  try {
    requireSameOrigin(request);
    body = await readJsonBody(request, 16 * 1024);
  } catch (error) {
    const inputError = error instanceof HttpInputError ? error : new HttpInputError("Invalid request");
    recordSecurityEvent(request, "backup.write", "rejected", { reason: inputError.message });
    return NextResponse.json({ error: inputError.message }, { status: inputError.status });
  }
  if (body.action === "create") {
    try {
      const backup = createBackup();
      recordSecurityEvent(request, "backup.create", "allowed");
      return NextResponse.json({ backup });
    } catch (error) {
      // The detail (it may name paths) stays in the server log.
      console.error("Backup failed:", error);
      recordSecurityEvent(request, "backup.create", "failed");
      return NextResponse.json({ error: error instanceof HttpInputError ? error.message : "Backup failed" }, { status: error instanceof HttpInputError ? error.status : 500 });
    }
  }
  if (body.action === "restore" && typeof body.name === "string") {
    try {
      const snapshot = restoreBackup(body.name);
      recordSecurityEvent(request, "backup.restore", "allowed", { name: body.name });
      return NextResponse.json({ snapshot });
    } catch (error) {
      recordSecurityEvent(request, "backup.restore", "failed", { name: body.name });
      // Only messages written for the owner are returned; anything else (a file system or database error that may name
      // paths) stays in the server log.
      if (!(error instanceof HttpInputError)) console.error("Restore failed:", error);
      const known = error instanceof HttpInputError || (error instanceof Error && error.message === "Invalid backup name");
      return NextResponse.json(
        { error: known ? (error as Error).message : "Restore failed" },
        { status: error instanceof HttpInputError ? error.status : known ? 400 : 500 },
      );
    }
  }
  return NextResponse.json({ error: "Invalid backup action" }, { status: 400 });
}
