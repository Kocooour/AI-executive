"use client";
import { useEffect, useState } from "react";
import { zonedDateTimeToIso } from "../../../lib/local-dates";
import type { NotificationState } from "../types";

// The app badge (the number on the installed app's icon): it shows the open tasks due by tomorrow,
// is refreshed after midnight and when the app comes back to the screen, and can be tested and
// restored from Settings → Notifications. Moved verbatim from use-lumi-app.tsx. The clock that
// moves at midnight (`badgeNow`) also decides the app's "today", so it stays in use-lumi-app.tsx
// and only its setter is passed in.
export function useAppBadge({ authState, notificationState, attentionTaskCount, calendarTomorrow, calendarTimezone,
  setBadgeNow, standalone, tr }: {
  authState: string;
  notificationState: NotificationState | null;
  attentionTaskCount: number;
  calendarTomorrow: string;
  calendarTimezone: string;
  setBadgeNow: (now: number) => void;
  standalone: boolean;
  tr: (key: string) => string;
}) {
  const [badgeStatus, setBadgeStatus] = useState("");

  useEffect(() => {
    if (authState !== "ready" || !notificationState) return;
    const nextMidnight = Date.parse(zonedDateTimeToIso(calendarTomorrow, "00:00", calendarTimezone));
    const timer = window.setTimeout(() => setBadgeNow(Date.now()), Math.max(1000, nextMidnight - Date.now() + 1000));
    const refresh = () => {
      if (document.visibilityState === "visible") setBadgeNow(Date.now());
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [authState, notificationState, calendarTomorrow, calendarTimezone]);
  useEffect(() => {
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof badgeNavigator.setAppBadge !== "function") return;
    if (authState === "ready" && !notificationState) return;
    const update = authState === "ready" && attentionTaskCount > 0
      ? badgeNavigator.setAppBadge(attentionTaskCount)
      : typeof badgeNavigator.clearAppBadge === "function"
        ? badgeNavigator.clearAppBadge()
        : badgeNavigator.setAppBadge(0);
    update.catch(() => undefined);
  }, [attentionTaskCount, authState, notificationState]);
  async function testAppBadge() {
    setBadgeStatus(tr("badgeTesting"));
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
    };
    if (!standalone) {
      setBadgeStatus(tr("badgeInstallRequired"));
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      setBadgeStatus(tr("badgePermissionRequired"));
      return;
    }
    if (typeof badgeNavigator.setAppBadge !== "function") {
      setBadgeStatus(tr("badgeUnavailable"));
      return;
    }
    try {
      await badgeNavigator.setAppBadge(1);
      setBadgeStatus(tr("badgeTestReady"));
    } catch (error) {
      console.warn("App badge test failed", error);
      setBadgeStatus(tr("badgeFailed"));
    }
  }
  async function restoreAppBadge() {
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (typeof badgeNavigator.setAppBadge !== "function") {
      setBadgeStatus(tr("badgeUnavailable"));
      return;
    }
    try {
      if (attentionTaskCount > 0) await badgeNavigator.setAppBadge(attentionTaskCount);
      else if (typeof badgeNavigator.clearAppBadge === "function") await badgeNavigator.clearAppBadge();
      else await badgeNavigator.setAppBadge(0);
      setBadgeStatus(tr("badgeRestored"));
    } catch (error) {
      console.warn("App badge restore failed", error);
      setBadgeStatus(tr("badgeFailed"));
    }
  }

  return { badgeStatus, testAppBadge, restoreAppBadge };
}
