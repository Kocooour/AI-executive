export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const scheduler = globalThis as typeof globalThis & {
    __aiExecutiveReminderScheduler?: ReturnType<typeof setInterval>;
  };
  if (scheduler.__aiExecutiveReminderScheduler) return;
  const { processDueReminders } = await import("./lib/notifications");
  const tick = () => processDueReminders().catch((error) => console.error("Reminder scheduler failed", error));
  setTimeout(tick, 5_000);
  scheduler.__aiExecutiveReminderScheduler = setInterval(tick, 60_000);
}
