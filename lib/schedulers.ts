// Background schedulers of the single always-on Node.js process: reminders, security alerts
// and calendar refreshes. Node-only; loaded from instrumentation.ts.
export async function startSchedulers() {
  const scheduler = globalThis as typeof globalThis & {
    __aiExecutiveReminderScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveSecurityScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveCalendarScheduler?: ReturnType<typeof setInterval>;
  };
  if (
    scheduler.__aiExecutiveReminderScheduler &&
    scheduler.__aiExecutiveSecurityScheduler &&
    scheduler.__aiExecutiveCalendarScheduler
  ) return;
  const { processDueReminders } = await import("./notifications");
  const { processSecurityAlerts } = await import("./security-monitor");
  const { processCalendarRefreshes } = await import("./calendar");
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
}
