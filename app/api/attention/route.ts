import { NextResponse } from "next/server";
import { fenceRestoredClient } from "../../../lib/restore-fence";
import { isAuthenticated } from "../../../lib/auth";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../lib/http-security";
import { readSnapshot } from "../../../lib/server-store";
import { getNotificationPreferences } from "../../../lib/notifications";
import { activeWorkspaces, reconcileWorkspace, withAttentionTransaction } from "../../../lib/attention-service";
import { setAttentionState } from "../../../lib/attention-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "attention-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status, headers: { "retry-after": String(limited.retryAfter) } });
  const requested = new URL(request.url).searchParams.get("workspaceId") || "";
  if (!requested || requested.length > 120) return NextResponse.json({ error: "Valid workspaceId required" }, { status: 400 });
  try {
    const result = withAttentionTransaction(() => {
      const snapshot = readSnapshot();
      const workspaces = activeWorkspaces(snapshot);
      if (requested !== "all" && !workspaces.includes(requested)) return null;
      const timezone = getNotificationPreferences().timezone;
      const evaluatedAt = Date.now();
      const selected = requested === "all" ? workspaces : [requested];
      const evaluated = selected.map((workspaceId) => reconcileWorkspace(snapshot, workspaceId, timezone, evaluatedAt));
      const items = evaluated.flatMap((result) => result.items);
      const entityById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
      const priority = (subjectId: string) => ({ high: 0, medium: 1, low: 2, none: 3 } as Record<string, number>)[String(entityById.get(subjectId)?.properties.priority || "none")] ?? 3;
      items.sort((a, b) => a.severity - b.severity || a.relevantAt - b.relevantAt || priority(a.subjectId) - priority(b.subjectId) || (a.attentionKey < b.attentionKey ? -1 : a.attentionKey > b.attentionKey ? 1 : 0));
      return { items, hidden: { snoozed: evaluated.reduce((sum, result) => sum + result.hidden.snoozed, 0), dismissed: evaluated.reduce((sum, result) => sum + result.hidden.dismissed, 0) },
        workspaceId: requested, timezone, evaluatedAt, dataRevision: snapshot.revision, source: "server canonical snapshot", sourceUpdatedAt: snapshot.updatedAt,
        coverage: { rules: ["deadline_overdue", "deadline_soon", "waiting_follow_up", "planned_date_passed", "project_no_next_action", "project_idle"],
          excluded: ["calendar_conflict", "capacity_risk"],
          projectActivity: "stored_project_task_confirmed_context", deletedTaskHistory: false, externalActivity: false } };
    });
    if (!result) return NextResponse.json({ error: "Workspace unavailable" }, { status: 404 });
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Attention evaluation failed" }, { status: 500, headers: { "cache-control": "private, no-store" } });
  }
}

interface LifecycleCommand {
  workspaceId?: unknown;
  attentionKey?: unknown;
  sourceFingerprint?: unknown;
  expectedDataRevision?: unknown;
  action?: unknown;
  snoozeUntil?: unknown;
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  const limited = enforceRateLimit(request, "attention-write", 60, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status, headers: { "retry-after": String(limited.retryAfter) } });
  let body: LifecycleCommand;
  try {
    requireSameOrigin(request);
    body = await readJsonBody<LifecycleCommand>(request, 2048);
    if (!body || typeof body !== "object" || typeof body.workspaceId !== "string" || body.workspaceId.length > 120 ||
      body.workspaceId === "all" || typeof body.attentionKey !== "string" || body.attentionKey.length > 600 ||
      typeof body.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.sourceFingerprint) ||
      !Number.isSafeInteger(body.expectedDataRevision) || (body.action !== "snooze" && body.action !== "dismiss") ||
      (body.action === "snooze" && !Number.isSafeInteger(body.snoozeUntil))) throw new HttpInputError("Invalid attention action");
  } catch (error) {
    const inputError = error instanceof HttpInputError ? error : new HttpInputError("Invalid request");
    return NextResponse.json({ error: inputError.message }, { status: inputError.status });
  }
  const command = body;
  try {
    const outcome = withAttentionTransaction(() => {
      const snapshot = readSnapshot();
      if (!activeWorkspaces(snapshot).includes(command.workspaceId as string)) return { error: "Workspace unavailable", status: 404 };
      if (snapshot.revision !== command.expectedDataRevision) return { error: "Source data changed; refresh and try again", status: 409 };
      const now = Date.now();
      const { candidates } = reconcileWorkspace(snapshot, command.workspaceId as string, getNotificationPreferences().timezone, now);
      const item = candidates.find((candidate) => candidate.attentionKey === command.attentionKey);
      if (!item) return { error: "Attention item is no longer active; refresh and try again", status: 409 };
      try {
        setAttentionState(item, command.action as "snooze" | "dismiss", command.sourceFingerprint as string,
          command.action === "snooze" ? Number(command.snoozeUntil) : null, now);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Attention item changed", status: 409 };
      }
      return { ok: true, status: 200 };
    });
    return NextResponse.json(outcome.ok ? { ok: true } : { error: outcome.error }, { status: outcome.status, headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Attention action failed" }, { status: 500, headers: { "cache-control": "private, no-store" } });
  }
}
