"use client";

import { useRef, useState } from "react";
import { addLocalDays, ymd } from "../../../lib/local-dates";
import type { Entity } from "../../../lib/db";
import type { LumiApp } from "../use-lumi-app";
import { RecordMarks, recordMarkState } from "./held-back";

// B4 keeps every decision on the existing local-first, single-use triage path.
// The inspector is already a full-width mobile sheet: no competing modal is opened.
export function InboxTriage({ app, task }: { app: LumiApp; task: Entity }) {
  const {
    activeWorkspaceId, writeWorkspaceId, projects, areas, workspaces,
    triageInbox, askConfirm, syncStatus, tr,
  } = app;
  const [projectId, setProjectId] = useState("");
  const [areaId, setAreaId] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const acting = useRef(false);
  const inScope = activeWorkspaceId !== "all" &&
    activeWorkspaceId === task.workspaceId && writeWorkspaceId === task.workspaceId &&
    task.status === "open" && task.properties.inbox === true;
  const projectChoices = projects.filter((project) =>
    project.workspaceId === task.workspaceId && project.status === "active");
  const areaChoices = areas.filter((area) =>
    area.workspaceId === task.workspaceId && area.status === "active");
  const selectedProject = projectChoices.find((project) => project.id === projectId);
  const selectedArea = areaChoices.find((area) => area.id === areaId);
  const canOrganize = Boolean(selectedProject || selectedArea);
  const marks = recordMarkState(app, task);
  const pendingStatus = marks.heldBack ? tr("heldBackBadge")
    : marks.unsent ? tr("unsentBadge")
    : syncStatus === "offline" ? tr("offline")
    : syncStatus === "syncing" ? tr("syncing")
    : tr("synced");
  const workspace = workspaces.find((item) => item.workspaceId === task.workspaceId);
  const workspaceLabel = workspace?.workspaceId === "personal" && workspace.title === "Personal"
    ? tr("personalWorkspace") : workspace?.title || task.workspaceId;
  const original = typeof task.properties.originalCaptureText === "string"
    ? task.properties.originalCaptureText : task.title;

  async function act(operation: () => Promise<unknown> | void) {
    // A double click must never send two decisions; the DB transaction is the
    // final authority when another tab decides on the same Inbox item.
    if (acting.current || !inScope) return;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      console.error("Inbox triage failed", failure);
      setError(tr("triageFailed"));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  const blocked = busy || !inScope;
  const organize = () => void act(() => triageInbox(task, "organize", {
    projectId: selectedProject?.id, areaId: selectedArea?.id,
  }));

  return <section className="inboxTriage" aria-label={tr("triageTitle")}>
    <header className="inboxTriageHeader">
      <h3>{tr("triageTitle")}</h3>
      <p className="inboxTriageWorkspace">
        {tr("workspace")}: {workspaceLabel}
      </p>
    </header>
    <p className="inboxOriginal">
      <b>{tr("triageOriginal")}</b>
      <span>{original}</span>
    </p>
    <div className="inboxTriageSync" role="status" aria-live="polite">
      <RecordMarks app={app} entity={task}/>
      <span>{pendingStatus}</span>
      {marks.conflict && <span>{tr("conflictBadge")}</span>}
    </div>
    {!inScope && <p className="inboxTriageScope" role="status">{tr("triageChooseWorkspace")}</p>}
    <div className="inboxTriageGroup">
      <h4>{tr("triageQuickActions")}</h4>
      <div className="inboxTriageActions">
        <button type="button" disabled={blocked}
          onClick={() => void act(() => triageInbox(task, "today"))}>{tr("triageToday")}</button>
        <button type="button" disabled={blocked}
          onClick={() => void act(() => triageInbox(task, "plan", ymd(addLocalDays(new Date(), 1))))}>{tr("triageTomorrow")}</button>
        <button type="button" disabled={blocked}
          onClick={() => document.querySelector<HTMLInputElement>(".detail .titleEdit")?.focus()}>
          {tr("triageClarify")}
        </button>
        <button type="button" disabled={blocked}
          onClick={() => void act(() => triageInbox(task, "waiting"))}>{tr("triageWaiting")}</button>
        <button type="button" disabled={blocked}
          onClick={() => void act(() => triageInbox(task, "someday"))}>{tr("triageSomeday")}</button>
      </div>
    </div>
    <div className="inboxTriageGroup">
      <h4>{tr("triagePlanTitle")}</h4>
      <label>
        {tr("triagePlan")}
        <span className="inboxTriageField">
          <input aria-label={tr("triagePlan")} type="date" value={date}
            onChange={(event) => setDate(event.target.value)} disabled={blocked}/>
          <button type="button" disabled={blocked || !/^20\d{2}-\d{2}-\d{2}$/.test(date)}
            onClick={() => void act(() => triageInbox(task, "plan", date))}>{tr("triageApply")}</button>
        </span>
      </label>
    </div>
    <div className="inboxTriageGroup">
      <h4>{tr("triageOrganizeTitle")}</h4>
      <p className="inboxTriageHint">{tr("triageOrganizeHint")}</p>
      <label>
        {tr("triageProject")}
        <span className="inboxTriageField">
          <select aria-label={tr("triageProject")} value={projectId}
            disabled={blocked || projectChoices.length === 0}
            onChange={(event) => setProjectId(event.target.value)}>
            <option value="">{tr("triageChooseProject")}</option>
            {projectChoices.map((project) =>
              <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
          <button type="button" disabled={blocked || !canOrganize}
            onClick={organize}>{tr("triageApply")}</button>
        </span>
      </label>
      <label>
        {tr("triageArea")}
        <span className="inboxTriageField">
          <select aria-label={tr("triageArea")} value={areaId}
            disabled={blocked || areaChoices.length === 0}
            onChange={(event) => setAreaId(event.target.value)}>
            <option value="">{tr("triageChooseArea")}</option>
            {areaChoices.map((area) =>
              <option key={area.id} value={area.id}>{area.title}</option>)}
          </select>
          <button type="button" disabled={blocked || !canOrganize}
            onClick={organize}>{tr("triageApply")}</button>
        </span>
      </label>
      {canOrganize && <p className="inboxTriagePreview" role="status">
        {tr("triageAssignPreview")}: {[selectedProject?.title, selectedArea?.title].filter(Boolean).join(" · ")}
      </p>}
    </div>
    <button type="button" className="inboxDiscard" disabled={blocked}
      onClick={() => void act(async () => {
        const accepted = await askConfirm({
          title: tr("triageDiscard"), message: tr("triageDiscardConfirm"),
          confirmLabel: tr("triageDiscard"), danger: true,
        });
        if (accepted) await triageInbox(task, "discard");
      })}>{tr("triageDiscard")}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
