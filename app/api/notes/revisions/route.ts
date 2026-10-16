import { NextResponse } from "next/server";
import { isAuthenticated } from "../../../../lib/auth";
import { enforceRateLimit } from "../../../../lib/http-security";
import { answerRevisionQuery } from "../../../../lib/note-revisions";
import { recordSecurityEvent } from "../../../../lib/security-audit";
import { getDatabase } from "../../../../lib/server-store";

// The version history of a note. Only the signed-in owner session may read it: this route accepts no
// bearer token, and nothing under /api/integrations reaches it. Security events never carry note text.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

export async function GET(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "note.revisions.read", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401, headers });
  }
  const limited = enforceRateLimit(request, "note-revisions-read", 600, 10 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "note.revisions.read", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, {
      status: limited.status,
      headers: { ...headers, "retry-after": String(limited.retryAfter) },
    });
  }
  const params = new URL(request.url).searchParams;
  const answer = answerRevisionQuery(getDatabase(), params.get("noteId") || "", params.get("revision"));
  recordSecurityEvent(request, "note.revisions.read", answer.status === 200 ? "allowed" : "rejected",
    answer.status === 200 ? { count: answer.count ?? null } : { reason: answer.status === 404 ? "not-found" : "invalid-request" });
  return NextResponse.json(answer.body, { status: answer.status, headers });
}
