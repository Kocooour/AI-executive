export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const scheduler = globalThis as typeof globalThis & {
    __aiExecutiveReminderScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveSecurityScheduler?: ReturnType<typeof setInterval>;
  };
  if (scheduler.__aiExecutiveReminderScheduler && scheduler.__aiExecutiveSecurityScheduler) return;
  const { processDueReminders } = await import("./lib/notifications");
  const { processSecurityAlerts } = await import("./lib/security-monitor");
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
}
