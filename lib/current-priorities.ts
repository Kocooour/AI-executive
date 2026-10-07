import type { Entity } from "./db";
import { calendarAvailability } from "./calendar";
import { getNotificationPreferences } from "./notifications";
import { readSnapshot } from "./server-store";

// What matters right now in one workspace, computed on demand from canonical data.
// Nothing here is stored, scheduled or delivered; the chat uses it to answer "what matters today".
export interface CurrentPriorities {
  workspaceId: string;
  workspaceName: string;
  localDate: string;
  timezone: string;
  summary: string;
  topTasks: Array<{ id: string; title: string; reason: string }>;
  overdueCount: number;
  riskCount: number;
  suggestions: string[];
}

function localDate(now: number, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(now)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function taskDate(task: Entity) {
  const when = typeof task.properties.when === "string" ? task.properties.when.slice(0, 10) : "";
  const deadline = typeof task.properties.deadline === "string" ? task.properties.deadline.slice(0, 10) : "";
  return { when, deadline, earliest: [when, deadline].filter(Boolean).sort()[0] || "" };
}

const priorityScore = (value: unknown) => ({ high: 30, medium: 20, low: 10 }[String(value)] || 0);

export function buildCurrentPriorities(workspaceId: string, now = Date.now()): CurrentPriorities {
  const preferences = getNotificationPreferences();
  const today = localDate(now, preferences.timezone);
  const snapshot = readSnapshot();
  const workspace = snapshot.entities.find(
    (entity) => entity.type === "workspace" && entity.workspaceId === workspaceId,
  );
  if (!workspace || workspaceId === "all") throw new Error("Workspace does not exist");
  const open = snapshot.entities.filter(
    (entity) => entity.type === "task" && entity.workspaceId === workspaceId && entity.status === "open",
  );
  const ranked = open.map((task) => {
    const dates = taskDate(task);
    const overdue = Boolean(
      (dates.deadline && dates.deadline < today) ||
      (dates.when && dates.when < today),
    );
    const dueToday = dates.when === today || dates.deadline === today;
    const stickyToday = task.properties.today === true && !dates.when;
    const nearDeadline = Boolean(dates.deadline && dates.deadline > today && dates.deadline <= addDays(today, 2));
    const score = (overdue ? 100 : 0) + (dueToday ? 70 : 0) + (stickyToday ? 40 : 0) +
      (nearDeadline ? 25 : 0) + priorityScore(task.properties.priority);
    const reason = overdue
      ? "po termínu"
      : dueToday
        ? "naplánováno na dnes"
        : nearDeadline
          ? "blíží se termín"
          : priorityScore(task.properties.priority) >= 30
            ? "vysoká priorita"
            : stickyToday
              ? "označeno na dnes"
              : "další otevřený úkol";
    return { task, dates, overdue, nearDeadline, today: dueToday || stickyToday, score, reason };
  }).sort((a, b) => b.score - a.score || a.dates.earliest.localeCompare(b.dates.earliest) || a.task.createdAt - b.task.createdAt);
  const workload = ranked.filter((item) => item.today || item.overdue).length;
  const overdueCount = ranked.filter((item) => item.overdue).length;
  const riskCount = ranked.filter((item) => item.overdue || item.nearDeadline).length;
  const availability = calendarAvailability(workspaceId, today, preferences.timezone, preferences.workdayStart, preferences.workdayEnd);
  const calendarFresh = availability.configured && availability.fresh;
  const topTasks = ranked.slice(0, 3).map(({ task, reason }) => ({ id: task.id, title: task.title, reason }));
  const suggestions: string[] = [];
  if (overdueCount) suggestions.push(`Prověř ${overdueCount} úkolů po termínu a potvrď nový realistický termín.`);
  // Capacity is stated only from a fresh connected calendar; without one no load conclusion is drawn.
  if (calendarFresh && workload > Math.max(1, Math.floor(availability.freeHours))) {
    suggestions.push(`Dnešní zátěž (${workload} úkolů) je pravděpodobně vyšší než ${availability.freeHours.toFixed(1)} h volného času; navrhni přesun méně důležitých úkolů.`);
  }
  if (availability.configured && !availability.fresh) suggestions.push("Kalendář není čerstvý, proto nyní netvrdím, které bloky jsou volné. Nejprve ho obnov.");
  if (calendarFresh && availability.windows[0]) {
    const window = availability.windows[0];
    const time = new Intl.DateTimeFormat("cs-CZ", { timeZone: preferences.timezone, hour: "2-digit", minute: "2-digit" });
    suggestions.push(`První volný blok je ${time.format(new Date(window.start))}–${time.format(new Date(window.end))} (${window.hours.toFixed(1)} h).`);
  }
  if (!suggestions.length) suggestions.push("Začni prvním doporučeným úkolem.");
  return {
    workspaceId, workspaceName: workspace.title, localDate: today, timezone: preferences.timezone,
    summary: `${topTasks.length ? `Vybral jsem ${topTasks.length} hlavní úkoly.` : "Na dnešek nemáš žádný otevřený úkol."} ${overdueCount ? `${overdueCount} je po termínu.` : "Nic není po termínu."}`,
    topTasks, overdueCount, riskCount, suggestions,
  };
}
