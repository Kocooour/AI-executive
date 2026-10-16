import { NextResponse } from "next/server";
import { closeSync, openSync, writeSync } from "node:fs";
import { restoreDatabaseFile, temporaryFile } from "../../../../lib/server-store";
import { removeIfExists } from "../../../../lib/backup-engine";
import { verifyPackage } from "../../../../lib/backup-package";
import { enforceRateLimit, HttpInputError, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";
import { isAuthenticated } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxUploadBytes = 200 * 1024 * 1024;

// Owner only. The body is the ZIP itself. It is streamed to a temporary file, checked completely (names, sizes,
// manifest, checksums, schema), and only then restored like a backup: safety backup first, one transaction.
export async function POST(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "backup.import", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const limited = enforceRateLimit(request, "backup-import", 6, 60 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "backup.import", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, {
      status: limited.status,
      headers: { "retry-after": String(limited.retryAfter) },
    });
  }
  const zipPath = temporaryFile("import", ".zip");
  const databasePath = temporaryFile("import-db", ".sqlite");
  try {
    requireSameOrigin(request);
    const mediaType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(mediaType)) {
      throw new HttpInputError("Content-Type must be application/zip", 415);
    }
    if (Number(request.headers.get("content-length") || 0) > maxUploadBytes) throw new HttpInputError("Request body is too large", 413);
    if (!request.body) throw new HttpInputError("Request body is required");
    const reader = request.body.getReader();
    const fd = openSync(zipPath, "w", 0o600);
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxUploadBytes) {
          await reader.cancel();
          throw new HttpInputError("Request body is too large", 413);
        }
        writeSync(fd, value);
      }
    } finally {
      closeSync(fd);
    }
    if (received === 0) throw new HttpInputError("Request body is required");
    verifyPackage(zipPath, databasePath);
    const snapshot = restoreDatabaseFile(databasePath);
    recordSecurityEvent(request, "backup.import", "allowed");
    return NextResponse.json({ snapshot }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (!(error instanceof HttpInputError)) console.error("Import failed:", error);
    const inputError = error instanceof HttpInputError ? error : new HttpInputError("Import failed", 500);
    recordSecurityEvent(request, "backup.import", inputError.status >= 500 ? "failed" : "rejected", { reason: inputError.message });
    return NextResponse.json({ error: inputError.message }, { status: inputError.status, headers: { "cache-control": "no-store" } });
  } finally {
    removeIfExists(zipPath);
    removeIfExists(databasePath);
  }
}
