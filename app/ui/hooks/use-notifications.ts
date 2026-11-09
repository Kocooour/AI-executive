"use client";
import { useEffect, useRef, useState } from "react";
import type { NotificationPreferences, NotificationState } from "../types";
import { urlBase64ToUint8Array } from "../format";
import { localizeServerError } from "../../../lib/server-errors";

// Push notifications on this device and the reminder settings: the server's notification state
// (loaded on start), enabling, disabling and testing push, and saving the preferences one after
// another. Moved verbatim from use-lumi-app.tsx. The Settings view also refreshes the state
// together with the backups; that effect stays in use-lumi-app.tsx, so the setter is returned.
export function useNotifications({ tr, language, writesBlocked = () => false }: { tr: (key: string) => string; language: string; writesBlocked?: () => boolean }) {
  const [notificationState, setNotificationState] = useState<NotificationState | null>(null),
    [notificationStatus, setNotificationStatus] = useState("");
  // A status shown in one language is not kept after the language changes.
  useEffect(() => setNotificationStatus(""), [language]);
  const notificationSettingsQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    fetch("/api/notifications", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((state) => setNotificationState(state as NotificationState))
      .catch(() => undefined);
  }, []);

  async function enableNotifications() {
    if (writesBlocked()) return;
    setNotificationStatus(tr("notifRequesting"));
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error(tr("notifUnsupported"));
      }
      if (!window.isSecureContext) {
        throw new Error(tr("notifNeedsHttps"));
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error(tr("notifPermissionDenied"));
      const stateResponse = await fetch("/api/notifications", { cache: "no-store" });
      if (!stateResponse.ok) throw new Error(tr("notifServiceUnavailable"));
      const state = (await stateResponse.json()) as NotificationState;
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(state.publicKey),
        });
      }
      const response = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "subscribe", subscription: subscription.toJSON() }),
      });
      if (!response.ok) throw new Error(tr("notifRegisterFailed"));
      setNotificationState((await response.json()) as NotificationState);
      setNotificationStatus(tr("notifEnabled"));
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : tr("notifEnableFailed"));
    }
  }
  async function disableNotifications() {
    if (writesBlocked()) return;
    setNotificationStatus(tr("notifDisabling"));
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "unsubscribe", endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      const state = await fetch("/api/notifications", { cache: "no-store" }).then((response) => response.json());
      setNotificationState(state as NotificationState);
      setNotificationStatus(tr("notifDisabled"));
    } catch {
      setNotificationStatus(tr("notifDisableFailed"));
    }
  }
  async function testNotification() {
    if (writesBlocked()) return;
    setNotificationStatus(tr("notifTestSending"));
    try {
      const response = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(localizeServerError(result.error, tr) || tr("notifTestFailed"));
      if (result.sent) {
        setNotificationStatus(
          result.failed
            ? tr("notifTestPartly").replace("{sent}", String(result.sent)).replace("{failed}", String(result.failed))
            : tr("notifTestSent").replace("{sent}", String(result.sent)),
        );
      } else if (result.total) {
        setNotificationStatus(tr("notifTestAllFailed").replace("{total}", String(result.total)));
      } else {
        setNotificationStatus(tr("notifNoDevice"));
      }
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : tr("notifTestFailed"));
    }
  }
  async function saveNotificationSettings(preferences: NotificationPreferences) {
    if (writesBlocked()) return;
    setNotificationState((current) => current ? { ...current, preferences } : current);
    notificationSettingsQueue.current = notificationSettingsQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch("/api/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "preferences", preferences }),
        });
        if (!response.ok) throw new Error();
        setNotificationStatus(tr("reminderSaved"));
      })
      .catch(() => setNotificationStatus(tr("reminderSaveFailed")));
    await notificationSettingsQueue.current;
  }

  return {
    notificationState,
    setNotificationState,
    notificationStatus,
    enableNotifications,
    disableNotifications,
    testNotification,
    saveNotificationSettings,
  };
}
