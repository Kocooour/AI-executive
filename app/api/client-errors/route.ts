import { NextResponse } from "next/server";
import {
  boundedString,
  enforceRateLimit,
  HttpInputError,
  readJsonBody,
  requireSameOrigin,
} from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";

export const runtime = "nodejs";

interface ClientErrorBody {
  kind?: unknown;
  message?: unknown;
  source?: unknown;
  line?: unknown;
  column?: unknown;
  stack?: unknown;
  userAgent?: unknown;
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "client-errors", 20, 15 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<ClientErrorBody>(request, 24 * 1024);
    const details = {
      kind: boundedString(body.kind ?? "error", "kind", 40),
      message: boundedString(body.message ?? "Unknown client error", "message", 1000),
      source: boundedString(body.source ?? "", "source", 500),
      line: typeof body.line === "number" ? body.line : null,
      column: typeof body.column === "number" ? body.column : null,
      stack: boundedString(body.stack ?? "", "stack", 6000),
      userAgent: boundedString(body.userAgent ?? "", "userAgent", 500),
    };
    console.error("Client runtime error", JSON.stringify(details));
    recordSecurityEvent(request, "client.runtime", "failed", details);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const status = error instanceof HttpInputError ? error.status : 400;
    return NextResponse.json({ error: "Invalid client error report" }, { status });
  }
}
