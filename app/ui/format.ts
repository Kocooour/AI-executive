import { type AttentionItem } from "../../lib/attention";
import { addLocalDays, ymd } from "../../lib/local-dates";
import { type Entity } from "../../lib/db";
import { type Language } from "./types";
import { copy } from "./copy";

export function attentionReason(item: AttentionItem, language: Language): string {
  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const last = item.reasonFacts.lastActivityAt
    ? new Date(item.reasonFacts.lastActivityAt).toLocaleString(locale, { timeZone: item.timezone }) : "";
  const date = item.reasonFacts.deadlineAllDay ? inSentenceDate(item.relevantDate, language, item.timezone)
    : new Date(item.relevantAt).toLocaleString(locale, { timeZone: item.timezone });
  const zone = item.reasonFacts.deadlineAllDay ? "" : ` (${item.timezone})`;
  if (language === "cs") {
    switch (item.reasonCode) {
      case "deadline_overdue": return `Termín ${date}${zone} již uplynul${item.reasonFacts.deadlineAllDay ? " po konci místního dne" : ""}.`;
      case "deadline_soon": return `Termín ${date}${zone} je v příštích 48 hodinách.`;
      case "waiting_follow_up": return item.reasonFacts.followUpDate
        ? `Nastal den připomenutí ${inSentenceDate(item.reasonFacts.followUpDate, language, item.timezone)}${item.reasonFacts.waitingFor ? ` (čeká na: ${item.reasonFacts.waitingFor})` : ""}.`
        : `Čeká alespoň 7 dní bez data připomenutí${item.reasonFacts.waitingFor ? ` (čeká na: ${item.reasonFacts.waitingFor})` : ""}.`;
      case "planned_date_passed": return `Naplánovaný den ${inSentenceDate(item.reasonFacts.plannedDate || item.relevantDate, language, item.timezone)} uplynul a úkol není hotový.`;
      case "project_no_next_action": return `Projekt nemá otevřený proveditelný úkol alespoň 24 hodin. Poslední zaznamenaná změna: ${last}.`;
      case "project_idle": return `Bez zaznamenané aktivity projektu, propojených úkolů nebo potvrzeného kontextu alespoň 14 dní. Poslední změna: ${last}.`;
    }
  }
  switch (item.reasonCode) {
    case "deadline_overdue": return `Deadline ${date}${zone} has passed${item.reasonFacts.deadlineAllDay ? " after the end of its local day" : ""}.`;
    case "deadline_soon": return `Deadline ${date}${zone} is within 48 hours.`;
    case "waiting_follow_up": return item.reasonFacts.followUpDate
      ? `The follow-up date ${inSentenceDate(item.reasonFacts.followUpDate, language, item.timezone)} has come${item.reasonFacts.waitingFor ? ` (waiting for: ${item.reasonFacts.waitingFor})` : ""}.`
      : `Waiting for at least 7 days without a follow-up date${item.reasonFacts.waitingFor ? ` (waiting for: ${item.reasonFacts.waitingFor})` : ""}.`;
    case "planned_date_passed": return `The planned day ${inSentenceDate(item.reasonFacts.plannedDate || item.relevantDate, language, item.timezone)} has passed and the task is not done.`;
    case "project_no_next_action": return `No open actionable task for at least 24 hours. Last recorded change: ${last}.`;
    case "project_idle": return `No recorded project, linked task, or confirmed context activity for at least 14 days. Last change: ${last}.`;
  }
}
export const friendlyDate = (value: unknown, language: Language, timezone?: string) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return typeof value === "string" ? value : "";
  }
  const referenceDay = timezone
    ? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date()).reduce<Record<string, string>>((parts, part) => ({ ...parts, [part.type]: part.value }), {})
    : null;
  const todayValue = referenceDay ? `${referenceDay.year}-${referenceDay.month}-${referenceDay.day}` : ymd();
  const relativeDate = (days: number) => {
    const date = new Date(`${todayValue}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  if (value === relativeDate(-1)) return copy[language].yesterday;
  if (value === todayValue) return copy[language].Today;
  if (value === relativeDate(1)) return copy[language].tomorrow;
  return new Date(`${value}T12:00:00`).toLocaleDateString(language === "cs" ? "cs-CZ" : "en-GB", {
    day: "numeric",
    month: "short",
    year: new Date(`${value}T12:00:00`).getFullYear() === new Date().getFullYear()
      ? undefined
      : "numeric",
  });
};
// The deadline and the planned day are different facts: only a deadline is "overdue" or "due soon".
export const taskDueSummary = (entity: Entity, todayValue: string, language: Language, now = new Date()) => {
  const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  const deadline = day(entity.properties.deadline);
  const when = day(entity.properties.when);
  if (deadline && deadline < todayValue) return `${copy[language].Overdue} · ${friendlyDate(deadline, language)}`;
  if (deadline && deadline <= ymd(addLocalDays(now, 1))) return `${copy[language].dueSoon} · ${friendlyDate(deadline, language)}`;
  if (when && when < todayValue) return copy[language].plannedEarlier.replace("{date}", friendlyDate(when, language));
  return "";
};
export const urlBase64ToUint8Array = (base64: string) => {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
};

// A date inside a sentence: "today", "yesterday" and "tomorrow" are not capitalised there.
export function inSentenceDate(value: string, language: Language, timezone?: string) {
  const text = friendlyDate(value, language, timezone);
  return [copy[language].Today, copy[language].yesterday, copy[language].tomorrow].includes(text) ? text.toLocaleLowerCase(language) : text;
}
