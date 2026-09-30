import { NextResponse } from "next/server";
import { authenticationBinding, isAuthenticated } from "../../../lib/auth";
import { planAIRequest } from "../../../lib/ai-actions";
import {
  enforceRateLimit,
  HttpInputError,
  readJsonBody,
  requireSameOrigin,
} from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ClientMessage {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "ai.request", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "ai", 60, 60 * 60_000);
    if (limited) {
      recordSecurityEvent(request, "ai.request", "rejected", { reason: "rate-limit" });
      return NextResponse.json(
        { error: limited.error },
        { status: limited.status, headers: { "retry-after": String(limited.retryAfter) } },
      );
    }
    const body = await readJsonBody<{
      messages?: unknown;
      workspaceId?: unknown;
      writeWorkspaceId?: unknown;
      focusEntityId?: unknown;
    }>(request, 128 * 1024);
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 50) {
      throw new HttpInputError("Messages are invalid");
    }
    const messages: ClientMessage[] = body.messages.map((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        !["user", "assistant"].includes(String((message as ClientMessage).role)) ||
        typeof (message as ClientMessage).content !== "string" ||
        (message as ClientMessage).content.length > 20_000
      ) {
        throw new HttpInputError("A message is invalid");
      }
      return message as ClientMessage;
    });
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUserMessage?.content.trim()) throw new HttpInputError("A user message is required");
    const workspaceId = String(body.workspaceId || "personal");
    const writeWorkspaceId = String(body.writeWorkspaceId || "");
    if (
      !/^(?:all|[A-Za-z0-9:_-]{1,120})$/.test(workspaceId) ||
      !/^[A-Za-z0-9:_-]{1,120}$/.test(writeWorkspaceId) ||
      writeWorkspaceId === "all"
    ) {
      throw new HttpInputError("Workspace scope is invalid");
    }
    const focusEntityId = body.focusEntityId === undefined
      ? undefined
      : String(body.focusEntityId);
    if (focusEntityId && (focusEntityId.length > 240 || !/^[A-Za-z0-9:_-]+$/.test(focusEntityId))) {
      throw new HttpInputError("Focus entity is invalid");
    }
    const result = await planAIRequest({
      message: lastUserMessage.content.trim(),
      readWorkspaceId: workspaceId,
      writeWorkspaceId,
      focusEntityId,
      sessionBinding: authenticationBinding(request),
    });
    recordSecurityEvent(request, "ai.request", "allowed", {
      provider: result.provider,
      proposedWrite: Boolean(result.proposal),
      workspaceScope: workspaceId === "all" ? "aggregate" : "single",
    });
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof HttpInputError ? error.status : 500;
    recordSecurityEvent(request, "ai.request", "failed", {
      reason: error instanceof HttpInputError ? error.message : "internal-error",
    });
    return NextResponse.json(
      { error: error instanceof HttpInputError ? error.message : "AI request failed" },
      { status },
    );
  }
}
