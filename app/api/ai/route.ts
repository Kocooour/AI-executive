import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  HttpInputError,
  readJsonBody,
  requireSameOrigin,
} from "../../../lib/http-security";
import { recordSecurityEvent } from "../../../lib/security-audit";
import { isAuthenticated } from "../../../lib/auth";

export const runtime = "nodejs";

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
    const limited = enforceRateLimit(request, "ai", 30, 60 * 60_000);
    if (limited) {
      recordSecurityEvent(request, "ai.request", "rejected", { reason: "rate-limit" });
      return NextResponse.json(
        { error: limited.error },
        {
          status: limited.status,
          headers: { "retry-after": String(limited.retryAfter) },
        },
      );
    }
    const body = await readJsonBody<{ messages?: unknown; context?: unknown }>(
      request,
      256 * 1024,
    );
    if (!Array.isArray(body.messages) || body.messages.length > 50) {
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
    const contextText = body.context ? JSON.stringify(body.context) : "";
    if (contextText.length > 100_000) throw new HttpInputError("Context is too large", 413);

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      recordSecurityEvent(request, "ai.request", "failed", { reason: "provider-unconfigured" });
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not configured" },
        { status: 503 },
      );
    }
    const input = [
      {
        role: "system",
        content:
          "You are the assistant inside a personal AI OS. Use only the supplied context. Be concise. Never claim an action was performed unless a tool result confirms it.",
      },
      ...(contextText
        ? [{ role: "system", content: `Current context: ${contextText}` }]
        : []),
      ...messages,
    ];
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        input,
        max_output_tokens: 1200,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      console.error("AI provider request failed", response.status);
      recordSecurityEvent(request, "ai.request", "failed", { providerStatus: response.status });
      return NextResponse.json({ error: "AI provider error" }, { status: 502 });
    }
    const data = await response.json();
    const text = (data.output || [])
      .flatMap((output: any) => output.content || [])
      .filter((content: any) => content.type === "output_text")
      .map((content: any) => content.text)
      .join("\n");
    recordSecurityEvent(request, "ai.request", "allowed", { messageCount: messages.length });
    return NextResponse.json({ message: text || "No response." });
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
