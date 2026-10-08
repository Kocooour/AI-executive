"use client";
import { useEffect, useRef, useState } from "react";
import type { NotificationPreferences, NotificationState } from "../types";
import { urlBase64ToUint8Array } from "../format";

// Push notifications on this device and the reminder settings: the server's notification state
// (loaded on start), enabling, disabling and testing push, and saving the preferences one after
// another. Moved verbatim from use-lumi-app.tsx. The Settings view also refreshes the state
// together with the backups; that effect stays in use-lumi-app.tsx, so the setter is returned.
export function useNotifications() {
  const [notificationState, setNotificationState] = useState<NotificationState | null>(null),
    [notificationStatus, setNotificationStatus] = useState("");
  const notificationSettingsQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    fetch("/api/notifications", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((state) => setNotificationState(state as NotificationState))
      .catch(() => undefined);
  }, []);

  async function enableNotifications() {
    setNotificationStatus("Requesting permission…");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Push notifications are not supported in this browser.");
      }
      if (!window.isSecureContext) {
        throw new Error("Open the HTTPS address to enable notifications.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notification permission was not granted.");
      const stateResponse = await fetch("/api/notifications", { cache: "no-store" });
      if (!stateResponse.ok) throw new Error("Notification service is unavailable.");
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
      if (!response.ok) throw new Error("The device could not be registered.");
      setNotificationState((await response.json()) as NotificationState);
      setNotificationStatus("Notifications enabled on this device.");
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "Notifications could not be enabled.");
    }
  }
  async function disableNotifications() {
    setNotificationStatus("Disabling notifications…");
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
      setNotificationStatus("Notifications disabled on this device.");
    } catch {
      setNotificationStatus("Notifications could not be disabled.");
    }
  }
  async function testNotification() {
    setNotificationStatus("Sending test notification…");
    try {
      const response = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The test could not be sent.");
      if (result.sent) {
        setNotificationStatus(
          result.failed
            ? `Test sent to ${result.sent} device(s); ${result.failed} delivery failed.`
            : `Test sent to ${result.sent} device(s).`,
        );
      } else if (result.total) {
        setNotificationStatus(`Delivery failed for all ${result.total} registered device(s).`);
      } else {
        setNotificationStatus("No device is registered for notifications.");
      }
    } catch (error) {
      setNotificationStatus(error instanceof Error ? error.message : "The test could not be sent.");
    }
  }
  async function saveNotificationSettings(preferences: NotificationPreferences) {
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
        setNotificationStatus("Reminder settings saved.");
      })
      .catch(() => setNotificationStatus("Reminder settings could not be saved."));
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
