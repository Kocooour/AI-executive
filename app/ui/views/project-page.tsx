"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { byManualOrder } from "../../../lib/task-views";
import { projectTasks, summarizeProject } from "../../../lib/project-summary";
import type { Entity } from "../../../lib/db";
import { labelsFor } from "../project-labels";
import type { LumiApp } from "../use-lumi-app";
import { ProjectContext } from "./project-context";
import { RecordMarks, heldBackReason } from "./held-back";
import { SyncConflicts } from "./sync-conflicts";

type RenderRow = (entity: Entity, index: number, rows: Entity[], dragScope?: string) => ReactNode;

// A project opened as the main view of Projects (B1, proposal §4.4, owner decision 2026-10-22): header with the context,
// the tasks and the notes of the project, and the collapsed details. A task or note opened from here uses the inspector
// on the right. Rows are the ordinary list rows of the app (`renderRow` of the entity list), so every row action works here.
export function ProjectPage({ app, project, renderRow }: { app: LumiApp; project: Entity; renderRow: RenderRow }) {
  const { areas, askConfirm, closeProjectPage, contextClaims, contextPredicateLabel, heldBack, items, language,
    openCapture, patch, relate, remove, rename, scopedRelations, setProjectStatus, targets, today, tr, unsent } = app;
  const t = labelsFor(language);
  const { tasks, notes } = projectTasks(project, items, scopedRelations);
  const summary = summarizeProject(project, items, scopedRelations, today);
  const openTasks = tasks.filter((task) => task.status === "open").sort(byManualOrder(`task:project:${project.id}`));
  const orderedNotes = [...notes].sort(byManualOrder(`note:project:${project.id}`));
  const percent = summary.total === 0 ? 0 : Math.round((summary.done / summary.total) * 100);

  // The name is typed into a draft and saved when the field is left (as in the inspector).
  const [title, setTitle] = useState(project.title);
  const titleFocused = useRef(false);
  useEffect(() => { if (!titleFocused.current) setTitle(project.title); }, [project.title]);

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [project.id]);

  const projectClaims = contextClaims.filter((claim) =>
    (claim.subject.canonicalEntityId === project.id || claim.target?.canonicalEntityId === project.id) && !claim.archivedAt);
  const activity = Array.isArray(project.properties.activity) ? project.properties.activity : [];
  const lastChangedText = summary.lastActivityAt > 0
    ? new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.lastActivityAt))
    : "—";
  const deadline = typeof project.properties.deadline === "string" ? project.properties.deadline : "";
  const isHeld = heldBack.some((entity) => entity.id === project.id);
  const statusText = project.status === "active" ? t.statusActive : project.status === "completed" ? t.statusCompleted : project.status;

  return (
    <article className="projectPage" aria-label={`${t.page}: ${project.title}`} data-project-page={project.id}>
      <button type="button" className="projectBack" aria-label={t.backAria} onClick={closeProjectPage}>{t.back}</button>

      <header className="projectHeader">
        <h1 className="projectHeading" ref={headingRef} tabIndex={-1}>
          <input
            className="projectTitleInput"
            aria-label={t.title}
            maxLength={1000}
            readOnly={false}
            value={title}
            onFocus={() => { titleFocused.current = true; }}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={(event) => {
              titleFocused.current = false;
              const next = event.target.value;
              if (!next.trim()) { setTitle(project.title); return; }
              void rename(project, next);
            }}
          />
        </h1>
        <div className="projectStatusLine">
          <span className={`projectStatus ${project.status}`} data-testid="project-status">{statusText}</span>
          <span className="projectProgress" data-testid="project-progress">
            <span className="projectProgressBar" role="progressbar" aria-label={t.progress} aria-valuemin={0} aria-valuemax={Math.max(summary.total, 1)}
              aria-valuenow={summary.done} aria-valuetext={t.progressAria(summary.done, summary.total)}>
              <span style={{ width: `${percent}%` }} />
            </span>
            <span>{t.progressText(summary.done, summary.total)}</span>
          </span>
          {summary.attention?.kind === "overdue" && <span className="projectAttention danger">{t.overdue(summary.attention.count)}</span>}
          {summary.attention?.kind === "noNext" && <span className="projectAttention">{t.noNextStep}</span>}
          <RecordMarks app={app} entity={project} />
        </div>
        {isHeld && <p className="recordState recordHeldBack" role="status">{tr("heldBackDetail").replace("{reason}", () => heldBackReason(app, project))}</p>}
        {!isHeld && unsent.has(project.id) && <p className="recordState" role="status">{tr("unsentDetail")}</p>}
        <SyncConflicts app={app} entity={project} />
        <ProjectContext key={project.id} app={app} project={project} />
        <div className="projectActions">
          <button type="button" onClick={() => void setProjectStatus(project, project.status === "completed" ? "active" : "completed")}>
            {tr(project.status === "completed" ? "reopen" : "complete")}
          </button>
          <button type="button" className="danger" onClick={async () => {
            if (await askConfirm({ title: tr("projectDeleteTitle"), message: tr("projectDeleteConfirm").replace("{title}", () => project.title), confirmLabel: tr("delete"), danger: true })) void remove(project);
          }}>{tr("delete")}</button>
        </div>
      </header>

      <section className="projectSection" aria-labelledby="project-tasks-heading">
        <h2 id="project-tasks-heading" className="projectSectionHeading">{t.tasks}</h2>
        <div className="list taskRowList projectTaskList">
          {openTasks.map((task, index) => renderRow(task, index, openTasks, `task:project:${project.id}`))}
          {openTasks.length === 0 && <p className="projectEmpty">{t.noTasks}</p>}
        </div>
        <button type="button" className="projectAdd" onClick={() => openCapture("task", project.id)}>＋ {tr("addTask")}</button>
      </section>

      <section className="projectSection" aria-labelledby="project-notes-heading">
        <h2 id="project-notes-heading" className="projectSectionHeading">{t.notes}</h2>
        <div className="list taskRowList projectNoteList">
          {orderedNotes.map((note, index) => renderRow(note, index, orderedNotes, `note:project:${project.id}`))}
          {orderedNotes.length === 0 && <p className="projectEmpty">{t.noNotes}</p>}
        </div>
        <button type="button" className="projectAdd" onClick={() => openCapture("note", project.id)}>＋ {tr("addNote")}</button>
      </section>

      <details className="projectDetails" data-project-details>
        <summary>{t.details}</summary>
        <div className="projectDetailsBody">
          <label className="projectDetailsField">
            <span>{t.area}</span>
            <select
              aria-label={tr("area")}
              value={String(targets(project.id, "belongs_to_area")[0] || "")}
              onChange={async (event) => { await relate(project.id, event.target.value, "belongs_to_area"); }}
            >
              <option value="">{tr("none")}</option>
              {areas.filter((area) => area.workspaceId === project.workspaceId).map((area) => (
                <option value={area.id} key={area.id}>{area.title}</option>
              ))}
            </select>
            <small>{t.areaHelp}</small>
          </label>
          <label className="projectDetailsField">
            <span>{t.deadline}</span>
            <input type="date" aria-label={t.deadline} value={deadline}
              onChange={(event) => void patch(project, { deadline: event.target.value }, "deadline changed")} />
          </label>
          <div className="projectOverview" aria-label={t.lastActivity}>
            <div className="projectOverviewFacts">
              <div className="projectOverviewFact">
                <span>{t.lastActivity}</span>
                <time dateTime={new Date(summary.lastActivityAt || project.createdAt).toISOString()}>{lastChangedText}</time>
                <small>{summary.lastActivityFromLinked ? t.linkedChange : t.projectChange}</small>
              </div>
              <div className="projectOverviewFact">
                <span>{t.risks}</span>
                {summary.projectOverdue && <strong className="projectRiskSignal">{t.projectOverdue}: {deadline}</strong>}
                {summary.overdue > 0 && <strong className="projectRiskSignal">{t.taskOverdue}: {summary.overdue}</strong>}
                {!summary.projectOverdue && summary.overdue === 0 && <small>{t.riskNone}</small>}
                <small>{t.riskHelp}</small>
              </div>
              <div className="projectOverviewFact">
                <span>{t.nextStep}</span>
                {summary.next
                  ? <button type="button" className="projectNextAction" onClick={() => { void app.inspect(summary.next as Entity); }}>{summary.next.title}</button>
                  : <strong>{t.noNextStep}</strong>}
              </div>
            </div>
          </div>
          <section className="detailKnowledge" aria-label={tr("whatLumiKnows")}>
            <h3>{tr("whatLumiKnows2")}</h3>
            {projectClaims.map((claim) => (
              <article key={claim.id}>
                <strong>{claim.subject.title} · {contextPredicateLabel(claim.predicate)}: {String(claim.literal?.value ?? claim.target?.title ?? "—")}</strong>
                <small>{claim.reviewStatus === "confirmed" ? tr("confirmed2") : claim.reviewStatus === "proposed" ? tr("toReview2") : tr("rejected")} · {claim.freshness === "current" ? tr("current2") : claim.freshness === "needs_review" ? tr("needsReview2") : tr("stale2")}{claim.validTo ? ` · ${tr("validTo2")} ${claim.validTo}` : ""}</small>
              </article>
            ))}
            {projectClaims.length === 0 && <p>{tr("noClaimsForThis")}</p>}
          </section>
          <div className="activityLog">
            <h3>{t.history}</h3>
            {activity.length === 0 && <p className="projectEmpty">{t.noHistory}</p>}
            {[...activity].reverse().slice(0, 12).map((entry: { at?: unknown; action?: unknown }, index: number) => (
              <div key={`${String(entry.at)}-${index}`}>
                <span>{String(entry.action || "updated")}</span>
                <time>{new Date(Number(entry.at)).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}</time>
              </div>
            ))}
          </div>
        </div>
      </details>
    </article>
  );
}
