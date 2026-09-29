import { NextResponse } from "next/server";
import {
  getNotificationState,
  removeSubscription,
  saveNotificationPreferences,
  saveSubscription,
  sendTestNotification,
} from "../../../lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getNotificationState());
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.action === "subscribe") {
      saveSubscription(body.subscription);
      return NextResponse.json(getNotificationState());
    }
    if (body.action === "unsubscribe") {
      removeSubscription(String(body.endpoint || ""));
      return NextResponse.json(getNotificationState());
    }
    if (body.action === "preferences") {
      const preferences = saveNotificationPreferences(body.preferences || {});
      return NextResponse.json({ ...getNotificationState(), preferences });
    }
    if (body.action === "test") {
      return NextResponse.json({ sent: await sendTestNotification() });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Notification request failed" },
      { status: 400 },
    );
  }
}
