export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const scheduler = globalThis as typeof globalThis & {
    __aiExecutiveReminderScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveSecurityScheduler?: ReturnType<typeof setInterval>;
    __aiExecutiveBriefingScheduler?: ReturnType<typeof setInterval>;
  };
  if (
    scheduler.__aiExecutiveReminderScheduler &&
    scheduler.__aiExecutiveSecurityScheduler &&
    scheduler.__aiExecutiveBriefingScheduler
  ) return;
  const { processDueReminders } = await import("./lib/notifications");
  const { processSecurityAlerts } = await import("./lib/security-monitor");
  const { processExecutiveBriefings } = await import("./lib/executive-briefings");
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
  if (!scheduler.__aiExecutiveBriefingScheduler) {
    const briefingTick = () => processExecutiveBriefings().catch((error) => console.error("Executive briefing scheduler failed", error));
    setTimeout(briefingTick, 10_000);
    scheduler.__aiExecutiveBriefingScheduler = setInterval(briefingTick, 60_000);
  }
}
