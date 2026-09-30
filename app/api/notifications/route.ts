import { NextResponse } from "next/server";
import {
  getNotificationState,
  removeSubscription,
  saveNotificationPreferences,
  saveSubscription,
  sendTestNotification,
} from "../../../lib/notifications";
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
    recordSecurityEvent(request, "notification.read", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const limited = enforceRateLimit(request, "notification-read", 300, 10 * 60_000);
  if (limited) {
    recordSecurityEvent(request, "notification.read", "rejected", { reason: "rate-limit" });
    return NextResponse.json({ error: limited.error }, {
      status: limited.status,
      headers: { "retry-after": String(limited.retryAfter) },
    });
  }
  return NextResponse.json(getNotificationState());
}

export async function POST(request: Request) {
  if (!isAuthenticated(request)) {
    recordSecurityEvent(request, "notification.write", "rejected", { reason: "unauthenticated" });
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  try {
    requireSameOrigin(request);
    const limited = enforceRateLimit(request, "notification-write", 120, 60 * 60_000);
    if (limited) {
      recordSecurityEvent(request, "notification.write", "rejected", { reason: "rate-limit" });
      return NextResponse.json({ error: limited.error }, {
        status: limited.status,
        headers: { "retry-after": String(limited.retryAfter) },
      });
    }
    const body = await readJsonBody<any>(request, 64 * 1024);
    if (body.action === "subscribe") {
      saveSubscription(body.subscription);
      recordSecurityEvent(request, "notification.subscribe", "allowed");
      return NextResponse.json(getNotificationState());
    }
    if (body.action === "unsubscribe") {
      removeSubscription(String(body.endpoint || ""));
      recordSecurityEvent(request, "notification.unsubscribe", "allowed");
      return NextResponse.json(getNotificationState());
    }
    if (body.action === "preferences") {
      const preferences = saveNotificationPreferences(body.preferences || {});
      recordSecurityEvent(request, "notification.preferences", "allowed");
      return NextResponse.json({ ...getNotificationState(), preferences });
    }
    if (body.action === "test") {
      const testLimited = enforceRateLimit(request, "notification-test", 10, 60 * 60_000);
      if (testLimited) {
        recordSecurityEvent(request, "notification.test", "rejected", { reason: "rate-limit" });
        return NextResponse.json({ error: testLimited.error }, {
          status: testLimited.status,
          headers: { "retry-after": String(testLimited.retryAfter) },
        });
      }
      const result = await sendTestNotification();
      recordSecurityEvent(request, "notification.test", "allowed", result);
      return NextResponse.json(result);
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const status = error instanceof HttpInputError ? error.status : 400;
    recordSecurityEvent(request, "notification.write", "failed", {
      reason: error instanceof HttpInputError ? error.message : "invalid-request",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Notification request failed" },
      { status },
    );
  }
}
