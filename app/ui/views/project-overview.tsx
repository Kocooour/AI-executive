"use client";

import { useEffect, useRef, useState } from "react";
import { byManualOrder } from "../../../lib/task-views";
import type { Entity } from "../../../lib/db";
import type { LumiApp } from "../use-lumi-app";

const labels = {
  cs: {
    overview: "Přehled projektu",
    goal: "Cíl / výsledek",
    goalPlaceholder: "Jak poznáme, že je projekt hotový?",
    goalHelp: "Výsledek zadáváte vy. Lumi ho bez schválení nedoplňuje.",
    status: "Stav",
    active: "Aktivní",
    completed: "Dokončený",
    next: "Další akce",
    noNext: "Není určená",
    nextHelp: "První dostupný úkol podle pořadí projektu; nejde o potvrzený AI návrh.",
    noNextHelp: "V projektu zatím není dostupný otevřený úkol. Samo o sobě to neznamená problém.",
    last: "Poslední aktivita",
    projectChange: "Změna projektu",
    linkedChange: "Změna navázaného úkolu",
    risks: "Signály rizika",
    projectOverdue: "Termín projektu uplynul",
    taskOverdue: "Úkoly po termínu",
    riskNone: "Z evidovaných termínů žádné upozornění.",
    riskHelp: "Jen ověřitelné termíny, nikoli úplné posouzení rizik.",
    saving: "Ukládání…",
    saveError: "Zápis vyžaduje kontrolu. Zadaný text zůstává v poli.",
  },
  en: {
    overview: "Project overview",
    goal: "Goal / outcome",
    goalPlaceholder: "What result will mean the project is complete?",
    goalHelp: "You define the outcome; Lumi does not invent one.",
    status: "Status",
    active: "Active",
    completed: "Completed",
    next: "Next action",
    noNext: "Not identified",
    nextHelp: "First available task in project order, not a confirmed AI suggestion.",
    noNextHelp: "No available open task is linked. This is not automatically a problem.",
    last: "Last activity",
    projectChange: "Project changed",
    linkedChange: "Linked task changed",
    risks: "Risk signals",
    projectOverdue: "Project deadline has passed",
    taskOverdue: "Overdue tasks",
    riskNone: "No alerts based on recorded deadlines.",
    riskHelp: "Based on recorded dates only; not a complete risk assessment.",
    saving: "Saving…",
    saveError: "Save needs attention. Your entered text is still in the field.",
  },
};

export function ProjectOverview({ app, project }: { app: LumiApp; project: Entity }) {
  const t = labels[app.language === "cs" ? "cs" : "en"];
  const storedGoal = typeof project.properties.goal === "string" ? project.properties.goal : "";
  const [goalDraft, setGoalDraft] = useState(storedGoal);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setGoalDraft(storedGoal);
  }, [storedGoal]);

  const projectTaskIds = new Set(app.sources(project.id, "belongs_to_project"));
  const linkedTasks = app.tasks.filter((task) =>
    task.workspaceId === project.workspaceId && projectTaskIds.has(task.id));
  const openTasks = linkedTasks.filter((task) => task.status === "open");
  const nextAction = [...openTasks]
    .filter((task) => task.properties.waiting !== true && task.properties.someday !== true)
    .sort(byManualOrder(`task:project:${project.id}`))[0] ?? null;
  const lastLinked = linkedTasks.reduce<Entity | null>(
    (latest, task) => !latest || task.updatedAt > latest.updatedAt ? task : latest, null);
  const activityFromTask = Boolean(lastLinked && lastLinked.updatedAt > project.updatedAt);
  const lastChanged = activityFromTask ? lastLinked!.updatedAt : project.updatedAt;
  const lastChangedText = Number.isFinite(lastChanged) && lastChanged > 0
    ? new Intl.DateTimeFormat(app.language === "cs" ? "cs-CZ" : "en-US",
      { dateStyle: "medium", timeStyle: "short" }).format(new Date(lastChanged))
    : "—";

  const deadline = typeof project.properties.deadline === "string" ? project.properties.deadline : "";
  const overdueProject = project.status !== "completed" && /^\d{4}-\d{2}-\d{2}$/.test(deadline) && deadline < app.today;
  const overdueTasks = openTasks.filter((task) =>
    typeof task.properties.deadline === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(task.properties.deadline) &&
    task.properties.deadline < app.today);

  async function saveGoal() {
    const next = goalDraft.trim();
    if (next === storedGoal) { focused.current = false; return; }
    setSaving(true);
    setSaveError(false);
    try {
      await app.patch(project, { goal: next }, "project goal changed", true);
      focused.current = false;
    } catch {
      setSaveError(true);
      // Do not replace the unsent text with the old value.
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="projectOverview" aria-label={t.overview}>
      <label className="projectGoalField">
        <span>{t.goal}</span>
        <textarea
          aria-label={t.goal}
          value={goalDraft}
          placeholder={t.goalPlaceholder}
          rows={3}
          maxLength={1000}
          onFocus={() => { focused.current = true; }}
          onChange={(event) => { setGoalDraft(event.target.value); setSaveError(false); }}
          onBlur={() => { void saveGoal(); }}
        />
      </label>
      <small className="projectOverviewHint">{t.goalHelp}</small>
      {saving && <small role="status">{t.saving}</small>}
      {saveError && <small role="alert">{t.saveError}</small>}

      <div className="projectOverviewFacts">
        <div className="projectOverviewFact">
          <span>{t.status}</span>
          <strong data-testid="project-overview-status">
            {project.status === "active" ? t.active : project.status === "completed" ? t.completed : project.status}
          </strong>
        </div>
        <div className="projectOverviewFact">
          <span>{t.next}</span>
          {nextAction
            ? <button type="button" className="projectNextAction" onClick={() => { void app.inspect(nextAction); }}>{nextAction.title}</button>
            : <strong>{t.noNext}</strong>}
          <small>{nextAction ? t.nextHelp : t.noNextHelp}</small>
        </div>
        <div className="projectOverviewFact">
          <span>{t.last}</span>
          <time dateTime={new Date(lastChanged || project.createdAt).toISOString()}>{lastChangedText}</time>
          <small>{activityFromTask ? t.linkedChange : t.projectChange}</small>
        </div>
        <div className="projectOverviewFact">
          <span>{t.risks}</span>
          {overdueProject && <strong className="projectRiskSignal">{t.projectOverdue}: {deadline}</strong>}
          {overdueTasks.length > 0 && <strong className="projectRiskSignal">{t.taskOverdue}: {overdueTasks.length}</strong>}
          {!overdueProject && overdueTasks.length === 0 && <small>{t.riskNone}</small>}
          <small>{t.riskHelp}</small>
        </div>
      </div>
    </section>
  );
}
