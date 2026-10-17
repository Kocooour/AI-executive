import { NextResponse } from "next/server";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { createExportCopy, releaseTemporaryFile, temporaryFile } from "../../../../lib/server-store";
import { verifyExportOutput, writeExportZip } from "../../../../lib/backup-package";
import { enforceRateLimit, HttpInputError, requireSameOrigin } from "../../../../lib/http-security";
import { recordSecurityEvent } from "../../../../lib/security-audit";
import { isAuthenticated } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Owner only: the session cookie, never the integration token. The package holds all data of the owner, in all
// workspaces (there is one owner), so it is built only from a fresh backup copy and is never stored on the server.
export async function GET(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "backup.export", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    // A navigation to the file carries no Origin; a request from another site does.
    if (request.headers.get("origin")) requireSameOrigin(request);
  } catch (error) {
    const inputError = error instanceof HttpInputError ? error : new HttpInputError("Invalid request");
    recordSecurityEvent(request, "backup.export", "rejected", { reason: inputError.message });
    return NextResponse.json({ error: inputError.message }, { status: inputError.status });
  }
  const limited = enforceRateLimit(request, "backup-export", 6, 60 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "backup.export", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, {
      status: limited.status,
      headers: { "retry-after": String(limited.retryAfter) },
    });
  }
  const copy = (() => {
    try { return createExportCopy(); } catch (error) { console.error("Export copy failed:", error); return null; }
  })();
  if (!copy) {
    recordSecurityEvent(request, "backup.export", "failed");
    return NextResponse.json({ error: "Export failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  const zipPath = temporaryFile("export-zip", ".zip");
  const scratchPath = temporaryFile("export-check", ".sqlite");
  let handedOver = false;
  try {
    // The ZIP is written to a file with bounded memory, then checked by the importer's own verification (upload limit,
    // entry and size limits, inflate ratio, checksums), and only then sent. A package the importer would refuse is
    // never offered.
    writeExportZip(copy.path, zipPath, { counts: copy.counts, migrations: copy.migrations });
    copy.dispose();
    verifyExportOutput(zipPath, scratchPath);
    releaseTemporaryFile(scratchPath);
    const size = statSync(zipPath).size;
    const source = createReadStream(zipPath);
    // Deleted when the download ends, fails or is abandoned by the browser.
    source.on("close", () => releaseTemporaryFile(zipPath));
    handedOver = true;
    recordSecurityEvent(request, "backup.export", "allowed");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new Response(Readable.toWeb(source) as ReadableStream, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(size),
        "content-disposition": `attachment; filename="lumi-export-${stamp}.zip"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    copy.dispose();
    if (error instanceof HttpInputError) {
      recordSecurityEvent(request, "backup.export", "rejected", { reason: "too-large" });
      return NextResponse.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    }
    console.error("Export failed:", error);
    recordSecurityEvent(request, "backup.export", "failed");
    return NextResponse.json({ error: "Export failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  } finally {
    releaseTemporaryFile(scratchPath);
    if (!handedOver) releaseTemporaryFile(zipPath);
  }
}
