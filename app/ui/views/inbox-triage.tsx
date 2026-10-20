"use client";

import { useState } from "react";
import type { Entity } from "../../../lib/db";
import type { LumiApp } from "../use-lumi-app";

// A task is triaged through the existing local-first persistence paths.
// The All workspace is read-only: the owner must pick an explicit write workspace.
export function InboxTriage({ app, task }: { app: LumiApp; task: Entity }) {
  const {
    activeWorkspaceId, writeWorkspaceId, projects, scheduleTask, patch, relate,
    askConfirm, remove, tr,
  } = app;
  const [projectId, setProjectId] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inScope = activeWorkspaceId !== "all" &&
    activeWorkspaceId === task.workspaceId && writeWorkspaceId === task.workspaceId;
  const projectChoices = projects.filter((project) =>
    project.workspaceId === task.workspaceId && project.status === "active");

  async function act(operation: () => Promise<unknown> | void) {
    if (busy || !inScope) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      console.error("Inbox triage failed", failure);
      setError(tr("triageFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <section className="inboxTriage" aria-label={tr("triageTitle")}>
    <h3>{tr("triageTitle")}</h3>
    <p className="inboxOriginal">
      <b>{tr("triageOriginal")}</b>
      <span>{typeof task.properties.originalCaptureText === "string"
        ? task.properties.originalCaptureText : task.title}</span>
    </p>
    {!inScope && <p role="status">{tr("triageChooseWorkspace")}</p>}
    <div className="inboxTriageActions">
      <button type="button" disabled={busy || !inScope}
        onClick={() => void act(() => scheduleTask(task, "today"))}>{tr("triageToday")}</button>
      <button type="button" disabled={busy || !inScope}
        onClick={() => document.querySelector<HTMLInputElement>(".detail .titleEdit")?.focus()}>
        {tr("triageClarify")}
      </button>
      <button type="button" disabled={busy || !inScope}
        onClick={() => void act(() => patch(task, {
          waiting: true, waitingSince: Date.now(), waitingFor: "", followUpDate: "", inbox: false,
        }, "waiting started", true))}>{tr("triageWaiting")}</button>
      <button type="button" disabled={busy || !inScope}
        onClick={() => void act(() => scheduleTask(task, "someday"))}>{tr("triageSomeday")}</button>
    </div>
    <label>
      {tr("triagePlan")}
      <span className="inboxTriageField">
        <input aria-label={tr("triagePlan")} type="date" value={date}
          onChange={(event) => setDate(event.target.value)} disabled={busy || !inScope}/>
        <button type="button" disabled={busy || !inScope || !/^20\d{2}-\d{2}-\d{2}$/.test(date)}
          onClick={() => void act(() => scheduleTask(task, date))}>{tr("triageApply")}</button>
      </span>
    </label>
    <label>
      {tr("triageProject")}
      <span className="inboxTriageField">
        <select aria-label={tr("triageProject")} value={projectId}
          disabled={busy || !inScope || projectChoices.length === 0}
          onChange={(event) => setProjectId(event.target.value)}>
          <option value="">{tr("triageChooseProject")}</option>
          {projectChoices.map((project) =>
            <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
        <button type="button" disabled={busy || !inScope || !projectId}
          onClick={() => void act(() => relate(task.id, projectId, "belongs_to_project", true))}>{tr("triageApply")}</button>
      </span>
    </label>
    <button type="button" className="inboxDiscard" disabled={busy || !inScope}
      onClick={() => void act(async () => {
        const accepted = await askConfirm({
          title: tr("triageDiscard"), message: tr("triageDiscardConfirm"),
          confirmLabel: tr("triageDiscard"), danger: true,
        });
        if (accepted) await remove(task);
      })}>{tr("triageDiscard")}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
