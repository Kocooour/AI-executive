import { releaseOwnerRead } from "../../../lib/owner-session-read-release";
import { NextResponse } from "next/server";
import { fenceRestoredClient } from "../../../lib/restore-fence";
import { isAuthenticated } from "../../../lib/auth";
import {
  archiveOwnerContext,
  listOwnerPACTContext,
  saveOwnerContext,
  type ContextScope,
  type ContextSensitivity,
} from "../../../lib/pact";
import { enforceRateLimit, HttpInputError, readJsonBody, requireSameOrigin } from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const scopes = new Set<ContextScope>(["me", "work", "family", "rules", "project", "workspace"]);
const sensitivities = new Set<ContextSensitivity>(["normal", "sensitive"]);

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const limited = enforceRateLimit(request, "context-read", 300, 10 * 60_000);
  if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId") || "";
    const includeArchived = url.searchParams.get("includeArchived") === "true";
    return releaseOwnerRead(request, NextResponse.json({ items: listOwnerPACTContext(workspaceId, includeArchived) }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Context read failed" }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const fenced = fenceRestoredClient(request);
  if (fenced) return fenced;
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "context-write", 60, 60 * 60_000);
    if (limited) return NextResponse.json({ error: limited.error }, { status: limited.status });
    const body = await readJsonBody<Record<string, unknown>>(request, 32 * 1024);
    // Checked again now that the body has been read: a restore may have completed meanwhile, and nothing awaits between this
    // check and the synchronous write below, so a request made against replaced data cannot be applied to the restored data.
    const fencedAgain = fenceRestoredClient(request);
    if (fencedAgain) return fencedAgain;
    const action = String(body.action || "");
    const workspaceId = String(body.workspaceId || "");
    if (action === "create") {
      const scope = String(body.scope || "") as ContextScope;
      const sensitivity = String(body.sensitivity || "normal") as ContextSensitivity;
      const title = String(body.title || "").trim();
      const content = String(body.content || "").trim();
      const projectId = body.projectId == null ? undefined : String(body.projectId);
      if (!scopes.has(scope) || !sensitivities.has(sensitivity)) throw new HttpInputError("Context classification is invalid");
      if (!title || title.length > 200 || !content || content.length > 10000) throw new HttpInputError("Context title or content is invalid");
      if (scope === "project" && !projectId) throw new HttpInputError("Project context requires projectId");
      const item = saveOwnerContext({ workspaceId, scope, sensitivity, title, content, projectId });
      recordSecurityEvent(request, "context.create", "allowed", { scope, sensitivity });
      return NextResponse.json({ item }, { status: 201 });
    }
    if (action === "archive") {
      const id = String(body.id || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpInputError("Context identifier is invalid");
      const item = archiveOwnerContext(id, workspaceId);
      if (!item) return NextResponse.json({ error: "Context not found" }, { status: 404 });
      recordSecurityEvent(request, "context.archive", "allowed", { scope: item.scope });
      return NextResponse.json({ item });
    }
    throw new HttpInputError("Unknown context action");
  } catch (error) {
    const status = error instanceof HttpInputError ? error.status : 400;
    recordSecurityEvent(request, "context.write", "failed");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Context request failed" }, { status });
  }
}
