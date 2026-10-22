// One visible metadata value per working-list row (B4). The data store and relationships do not change.
import type { Entity } from "../../lib/db";
import { ymd } from "../../lib/local-dates";
import { copy } from "./copy";
import { friendlyDate } from "./format";
import type { Language } from "./types";

export type TaskRowValue = {
  text: string;
  kind: "date" | "estimate" | "count" | "state" | "sync" | "none";
  tone: "default" | "danger" | "warning";
};

const empty: TaskRowValue = { text: "", kind: "none", tone: "default" };
const validYmd = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export function taskRowValue(
  entity: Entity,
  language: Language,
  today: string,
  status: { held: boolean; unsent: boolean; openTaskCount: number },
): TaskRowValue {
  // A failed or pending save outranks ordinary metadata, so no local-only data is hidden.
  if (status.held) return { text: copy[language].heldBackBadge, kind: "sync", tone: "warning" };
  if (status.unsent) return { text: copy[language].taskRowPending, kind: "sync", tone: "warning" };

  if (entity.type === "project") {
    const count = status.openTaskCount;
    const text = language === "cs"
      ? `${count} ${count === 1 ? "úkol" : count >= 2 && count <= 4 ? "úkoly" : "úkolů"}`
      : `${count} ${count === 1 ? "task" : "tasks"}`;
    return { text, kind: "count", tone: "default" };
  }

  if (entity.type === "note" && entity.updatedAt > 0 && Number.isFinite(entity.updatedAt)) {
    return { text: friendlyDate(ymd(new Date(entity.updatedAt)), language), kind: "date", tone: "default" };
  }
  if (entity.type !== "task") return empty;

  // A passed deadline is shown in red and wins, and a deadline due today or tomorrow is shown rather
  // than an earlier planned day; otherwise the earliest real date, without alarm: a planned day that
  // has passed is not overdue.
  const deadline = validYmd(entity.properties.deadline) ? entity.properties.deadline : "";
  if (entity.status === "open" && deadline && deadline < today) return { text: friendlyDate(deadline, language), kind: "date", tone: "danger" };
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (entity.status === "open" && deadline && deadline <= tomorrow.toISOString().slice(0, 10)) return { text: friendlyDate(deadline, language), kind: "date", tone: "default" };
  const due = [entity.properties.when, entity.properties.deadline].filter(validYmd).sort()[0];
  if (due) return { text: friendlyDate(due, language), kind: "date", tone: "default" };
  if (entity.properties.waiting === true) return { text: copy[language].waitingShort, kind: "state", tone: "default" };
  const estimate = entity.properties.estimatedMinutes;
  if (typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0) {
    return { text: `${estimate} min`, kind: "estimate", tone: "default" };
  }
  return empty;
}
