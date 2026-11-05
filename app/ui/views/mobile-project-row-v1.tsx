"use client";

import { useState } from "react";
import { entityConflicts } from "../../../lib/field-merge";
import type { Entity } from "../../../lib/db";
import type { ProjectSummary } from "../../../lib/project-summary";
import { projectPreviewCanToggle, projectPreviewSummary, projectPreviewTone } from "../../../lib/project-list-preview";
import type { LumiApp } from "../use-lumi-app";
import { RecordMarks } from "./held-back";
import { LumiCompletionControl } from "./lumi-completion-control";

/**
 * UI-05a is a gated presentation of the existing legacy-scoped Projects list.
 * It does not activate the R3 global All/Personal/Shared scope or grant write
 * permission. Target-model authorization still belongs to later R3 work.
 */
export function MobileProjectRowV1({ app, project, summary, dragScope, reorderEnabled = false }: {
  app: LumiApp;
  project: Entity;
  summary: ProjectSummary;
  dragScope: string;
  reorderEnabled?: boolean;
}) {
  const { activeWorkspaceId, askConfirm, dragHandle, draggingId, dragTarget, heldReasons, inspect, setProjectStatus,
    setActiveDragTarget, acceptNativeDrop, unsent, language, tr, workspaces } = app;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tone = projectPreviewTone(project, summary);
  const secondary = projectPreviewSummary(project, summary, language);
  const completed = project.status === "completed";
  const name = project.title || tr("untitledItem");
  const cs = language === "cs";
  // The current legacy store has no target Area role enforcement here.
  // Never silently mutate a project selected through the aggregated All view.
  const hasConflict = entityConflicts(project).length > 0;
  const canToggle = projectPreviewCanToggle(project, activeWorkspaceId,
    unsent.has(project.id) || heldReasons.has(project.id) || hasConflict || busy);
  const changeLabel = `${completed ? tr("reopen") : tr("complete")} ${name}`;
  const writeHint = hasConflict
    ? cs ? "Nejdříve vyřešte konflikt projektu." : "Resolve the project conflict before changing status."
    : cs ? "Pro změnu zvolte konkrétní prostor a vyčkejte na synchronizaci." :
      "Select a specific workspace and finish pending synchronization before changing status.";

  const toggle = async () => {
    if (!canToggle) return;
    const target = completed ? "active" : "completed";
    const count = summary.open;
    const openNote = !completed && count > 0
      ? cs
        ? `Projekt obsahuje ${count} ${count === 1 ? "nedokončený úkol" : count < 5 ? "nedokončené úkoly" : "nedokončených úkolů"}. Dokončení projektu stav podřízených úkolů nezmění.`
        : `This project has ${count} open ${count === 1 ? "task" : "tasks"}. Completing the project will not change the status of its tasks.`
      : "";
    const confirmed = await askConfirm({
      title: completed ? (cs ? "Znovu otevřít projekt?" : "Reopen project?")
        : (cs ? "Dokončit projekt?" : "Complete project?"),
      message: `${name}${openNote ? `\n\n${openNote}` : ""}`,
      confirmLabel: completed ? tr("reopen") : tr("complete"),
    });
    if (!confirmed) return;
    setBusy(true); setError("");
    try {
      await setProjectStatus(project, target);
    } catch {
      // Do not claim success when local save/server synchronization failed.
      setError(cs ? "Změnu projektu se nepodařilo uložit. Zkontrolujte synchronizaci." :
        "Could not save the project change. Check synchronization.");
    } finally {
      setBusy(false);
    }
  };

  const workspaceLabel = workspaces.find((w) => w.workspaceId === project.workspaceId)?.title || project.workspaceId;
  const state = completed ? (cs ? "Dokončený projekt" : "Completed project")
    : tone === "danger" ? (cs ? "Projekt vyžaduje pozornost" : "Project needs attention")
    : tone === "warning" ? (cs ? "Projekt bez dalšího kroku" : "Project needs a next step")
    : (cs ? "Aktivní projekt" : "Active project");
  return (
    <article className={`taskRow v1ProjectRow ${draggingId === project.id ? "isDragging" : ""} ${dragTarget === `entity:${project.id}` ? "dropActive" : ""}`}
      data-entity-type="project" data-project-preview-row={project.id} data-project-tone={tone}
      data-drop-entity={project.id}
      onDragEnter={() => setActiveDragTarget(`entity:${project.id}`)}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={(event) => acceptNativeDrop(event, `entity:${project.id}`)}
      onClick={() => { void inspect(project); }}>
      <LumiCompletionControl kind="project" tone={tone} complete={completed}
        actionLabel={changeLabel} stateLabel={state} blockedReason={writeHint}
        className="v1ProjectStatusButton" shapeClassName="v1ProjectCircle"
        data-project-status-control={project.id} disabled={!canToggle}
        onClick={(event) => { event.stopPropagation(); void toggle(); }} />
      <div className="taskRowMain v1ProjectMain">
        <strong className="v1ProjectName">
          <button type="button" className="taskRowOpen" onClick={(event) => { event.stopPropagation(); void inspect(project); }}>
            {name}
          </button>
        </strong>
        {secondary && <span className="v1ProjectSecondary" data-project-summary={project.id}>{secondary}</span>}
        <span className="v1ProjectA11yOnly">{state}. {cs ? "Prostor" : "Workspace"}: {workspaceLabel}.</span>
        <RecordMarks app={app} entity={project} />
        {error && <span className="v1ProjectError" role="alert">{error}</span>}
      </div>
      {reorderEnabled && <span className="v1ProjectDrag">{dragHandle(project, dragScope)}</span>}
    </article>
  );
}
