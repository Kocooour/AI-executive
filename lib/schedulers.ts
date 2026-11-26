// Background schedulers of the single always-on Node.js process: reminders, security alerts,
// attention notifications and calendar refreshes. Node-only; loaded from instrumentation.ts.
export async function startSchedulers() {
  const scheduler = globalThis as typeof globalThis & {
    __aiExecutiveReminderScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveSecurityScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveCalendarScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveAttentionScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveMailRetentionScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveTargetPushScheduler?: ReturnType<typeof setInterval>;
  };
  if (
    scheduler.__aiExecutiveReminderScheduler &&
    scheduler.__aiExecutiveSecurityScheduler &&
    scheduler.__aiExecutiveCalendarScheduler &&
    scheduler.__aiExecutiveAttentionScheduler &&
    scheduler.__aiExecutiveMailRetentionScheduler &&
    scheduler.__aiExecutiveTargetPushScheduler
  ) return;
  const { processDueReminders } = await import("./notifications");
  const { processSecurityAlerts } = await import("./security-monitor");
  const { processCalendarRefreshes } = await import("./calendar");
  const { processAttentionNotifications } = await import("./attention-notifications");
  const { getDatabase } = await import("./server-store");
  const { MAIL_RETENTION_SWEEP_MS, pruneExpiredMailMetadata } = await import("./mail-sync-retention");
  const { TARGET_PUSH_SCHEDULER_INTERVAL_MS, runTargetPushSchedulerTick } = await import("./target-push-scheduler");
  if (!scheduler.__aiExecutiveReminderScheduler) {
    const reminderTick = () => processDueReminders().catch((error) => console.error("Reminder scheduler failed", error));
    setTimeout(reminderTick, 5_000);
    scheduler.__aiExecutiveReminderScheduler = setInterval(reminderTick, 60_000);
  }
  if (!scheduler.__aiExecutiveSecurityScheduler) {
    const securityTick = () => processSecurityAlerts().catch((error) => console.error("Security alert scheduler failed", error));
    setTimeout(securityTick, 7_500);
    scheduler.__aiExecutiveSecurityScheduler = setInterval(securityTick, 60_000);
  }
  if (!scheduler.__aiExecutiveCalendarScheduler) {
    const calendarTick = () => processCalendarRefreshes().catch(() => undefined);
    setTimeout(calendarTick, 15_000);
    scheduler.__aiExecutiveCalendarScheduler = setInterval(calendarTick, 5 * 60_000);
  }
  if (!scheduler.__aiExecutiveAttentionScheduler) {
    const attentionTick = () => processAttentionNotifications().catch((error) => console.error("Attention notification scheduler failed", error instanceof Error ? error.name : "unknown"));
    setTimeout(attentionTick, 20_000);
    scheduler.__aiExecutiveAttentionScheduler = setInterval(attentionTick, 5 * 60_000);
  }
  if (!scheduler.__aiExecutiveTargetPushScheduler) {
    // E-2: target attention push (identity-bound pass in a bounded child). Off unless the notification
    // flags and the target store are configured; without VAPID keys it only prunes secrets of devices that
    // are no longer live. Never logs device data.
    const targetPushTick = () => runTargetPushSchedulerTick()
      .then((tick) => { if (tick.state === "failed") console.error("Target push scheduler failed"); })
      .catch(() => console.error("Target push scheduler failed"));
    setTimeout(targetPushTick, 30_000);
    scheduler.__aiExecutiveTargetPushScheduler = setInterval(targetPushTick, TARGET_PUSH_SCHEDULER_INTERVAL_MS);
  }
  if (!scheduler.__aiExecutiveMailRetentionScheduler) {
    // Local SQLite maintenance only; never contacts Gmail or starts mail sync.
    // Runs even when nobody opens the mail settings, because instrumentation
    // starts the schedulers with the Node.js application server.
    const retentionTick = () => {
      try { pruneExpiredMailMetadata(getDatabase()); }
      catch (error) { console.error("Mail retention scheduler failed", error instanceof Error ? error.name : "unknown"); }
    };
    setTimeout(retentionTick, 25_000);
    scheduler.__aiExecutiveMailRetentionScheduler = setInterval(retentionTick, MAIL_RETENTION_SWEEP_MS);
  }
}
