import { NextResponse } from "next/server";
import { fenceRestoredClient } from "../../../lib/restore-fence";
import { isAuthenticated } from "../../../lib/auth";
import {
  deleteCalendarSource,
  listCalendarEvents,
  listCalendarSources,
  refreshCalendarSource,
  saveCalendarSource,
} from "../../../lib/calendar";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";
import { readSnapshot } from "../../../lib/server-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function workspaceExists(workspaceId: string) {
  return workspaceId !== "all" && readSnapshot().entities.some(
    (entity) => entity.type === "workspace" && entity.workspaceId === workspaceId,
  );
}

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "calendar-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId") || "personal";
    if (!workspaceExists(workspaceId)) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    const from = Number(url.searchParams.get("from") || Date.now() - 24 * 60 * 60_000);
    const to = Number(url.searchParams.get("to") || Date.now() + 14 * 24 * 60 * 60_000);
    return NextResponse.json({
      sources: listCalendarSources().filter((source) => source.workspaceId === workspaceId),
      events: listCalendarEvents(workspaceId, from, to),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Calendar read failed" }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  try {
    requireSameOrigin(request);
    const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1024);
    // Checked again now that the body has been read: a restore may have completed meanwhile, and nothing awaits between this
    // check and the synchronous write below, so a request made against replaced data cannot be applied to the restored data.
    const fencedAgain = fenceRestoredClient(request);
    if (fencedAgain) return fencedAgain;
    const action = String(body.action || "");
    const limited = enforceRateLimit(request, `calendar-${action}`, action === "refresh" ? 12 : 30, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    if (action === "connect") {
      const workspaceId = String(body.workspaceId || "");
      if (!workspaceExists(workspaceId)) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
      const source = saveCalendarSource({ label: String(body.label || ""), url: String(body.url || ""), workspaceId });
      try {
        const refreshed = await refreshCalendarSource(source.id);
        recordSecurityEvent(request, "calendar.connect", "allowed", { provider: "ics" });
        return NextResponse.json(refreshed);
      } catch (error) {
        // The encrypted source remains available for a later retry. Never log
        // or return its bearer URL.
        recordSecurityEvent(request, "calendar.connect", "failed", { provider: "ics" });
        return NextResponse.json({ source: listCalendarSources().find((item) => item.id === source.id), error: error instanceof Error ? error.message : "Refresh failed" }, { status: 502 });
      }
    }
    const sourceId = String(body.sourceId || "");
    const source = listCalendarSources().find((item) => item.id === sourceId);
    if (!source) return NextResponse.json({ error: "Calendar source not found" }, { status: 404 });
    if (action === "refresh") {
      const result = await refreshCalendarSource(sourceId);
      recordSecurityEvent(request, "calendar.refresh", "allowed", { provider: "ics" });
      return NextResponse.json(result);
    }
    if (action === "disconnect") {
      deleteCalendarSource(sourceId);
      recordSecurityEvent(request, "calendar.disconnect", "allowed", { provider: "ics" });
      return NextResponse.json({ removed: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    recordSecurityEvent(request, "calendar.write", "failed");
    const status = error instanceof HttpInputError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Calendar request failed" }, { status });
  }
}
