"use client";
import type { Entity } from "../../../lib/db";
import { entityConflicts, type SyncConflict } from "../../../lib/field-merge";
import type { LumiApp } from "../use-lumi-app";

const fieldKeys: Record<string, string> = {
  title: "conflictField_title",
  status: "conflictField_status",
  content: "conflictField_content",
  "properties.notes": "conflictField_notes",
  "properties.when": "conflictField_when",
  "properties.deadline": "conflictField_deadline",
  "properties.priority": "conflictField_priority",
  "properties.today": "conflictField_today",
  "properties.someday": "conflictField_someday",
  "properties.inbox": "conflictField_inbox",
  "properties.recurrence": "conflictField_repeat",
  "properties.repeat": "conflictField_repeat",
  "properties.reminderAt": "conflictField_reminder",
  "properties.estimatedMinutes": "conflictField_estimate",
  "properties.plannedStart": "conflictField_planned",
  "properties.plannedEnd": "conflictField_planned",
  "properties.checklist": "conflictField_checklist",
  "properties.waiting": "conflictField_waiting",
  "properties.blocked": "conflictField_blocked",
  "relation.belongs_to_project": "conflictField_project",
  "relation.belongs_to_area": "conflictField_area",
};

function shown(conflict: SyncConflict, items: Entity[], tr: (key: string) => string, language: string) {
  const value = conflict.lostValue;
  if (conflict.field.startsWith("relation.")) {
    if (!value) return tr("conflictNone");
    return items.find((item) => item.id === value)?.title || tr("conflictRemovedItem");
  }
  if (value === null || value === undefined || value === "") return tr("conflictNone");
  if (typeof value === "boolean") return tr(value ? "conflictYes" : "conflictNo");
  if (conflict.field === "status") {
    const label = tr(`conflictStatus_${value}`);
    return label.startsWith("conflictStatus_") ? String(value) : label;
  }
  if (conflict.field === "properties.priority") return tr(String(value));
  if (conflict.field === "properties.checklist" && Array.isArray(value)) {
    return value.map((item) => (item && typeof item === "object" ? String((item as { title?: unknown }).title ?? "") : String(item))).filter(Boolean).join(", ") || tr("conflictNone");
  }
  if ((conflict.field === "properties.plannedStart" || conflict.field === "properties.plannedEnd" || conflict.field === "properties.reminderAt") && typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB");
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

// Values replaced by a change from another device, with a way to restore each one
// (owner decision 2026-10-08: the newer change wins and the replaced value can be restored).
export function SyncConflicts({ app, entity }: { app: LumiApp; entity: Entity }) {
  const { items, language, resolveConflict, tr } = app;
  const conflicts = entityConflicts(entity);
  if (!conflicts.length) return null;
  return (
    <section className="syncConflicts" aria-label={tr("conflictTitle")}>
      <h3>{tr("conflictTitle")}</h3>
      <p>{tr("conflictExplanation")}</p>
      {conflicts.map((conflict) => {
        const key = fieldKeys[conflict.field];
        return (
          <div className="syncConflict" key={conflict.id}>
            <span>
              <b>{key ? tr(key) : tr("conflictField_other")}</b>
              <span className="syncConflictValue">{shown(conflict, items, tr, language)}</span>
            </span>
            <div className="notificationActions">
              <button onClick={() => resolveConflict(entity, conflict.id, true)}>{tr("conflictRestore")}</button>
              <button onClick={() => resolveConflict(entity, conflict.id, false)}>{tr("conflictKeep")}</button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
