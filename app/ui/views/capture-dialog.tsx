"use client";
import { handleOverlayKeys } from "../focus";
import { type CaptureSuggestion } from "../types";
import type { LumiApp } from "../use-lumi-app";
import { DurationInput } from "./duration-input";

export function CaptureDialog({ app }: { app: LumiApp }) {
  const {
    capture,
    captureModalRef,
    captureProjectAction,
    captureProjectId,
    captureAreaId,
    captureSuggestion,
    captureSuggestionBusy,
    captureSuggestionError,
    captureType,
    draft,
    items,
    language,
    parseCapture,
    selectCaptureWriteWorkspace,
    setCapture,
    setCaptureProjectAction,
    chooseCaptureArea,
    setCaptureSuggestion,
    setCaptureSuggestionError,
    setDraft,
    setUseCaptureSuggestion,
    submitCapture,
    tr,
    useCaptureSuggestion,
    workspaces,
    writeWorkspaceId,
  } = app;
  // A task added to a project goes to the project's workspace, so its area has to come from there.
  const captureWorkspaceId = (captureProjectId && items.find((item) => item.id === captureProjectId)?.workspaceId) || writeWorkspaceId;
  return (
    <>
      {capture && (
        <div className="captureOverlay" onClick={() => setCapture(false)}>
          <form
            ref={captureModalRef}
            className="captureModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capture-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => handleOverlayKeys(e, () => setCapture(false))}
            onSubmit={(e) => {
              e.preventDefault();
              submitCapture();
            }}
          >
            <h2 id="capture-title">{captureType === "note" ? tr("addNote") : tr("quickCapture")}</h2>
            {workspaces.length > 1 && !captureProjectId && (
              <label className="captureWorkspace">
                {tr("workspace")}
                <select
                  value={writeWorkspaceId}
                  onChange={(event) => selectCaptureWriteWorkspace(event.target.value)}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.workspaceId}>
                      {workspace.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <input
              autoFocus
              aria-label={captureType === "note" ? tr("noteTitle") : tr("taskTitle")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                captureType === "note" ? tr("noteTitle") : tr("taskPrompt")
              }
            />
            {captureType === "task" && (
              <label className="captureArea">
                {tr("area")}
                <select value={captureAreaId} onChange={(event) => chooseCaptureArea(event.target.value)}>
                  <option value="">{tr("none")}</option>
                  {items.filter((item) => item.type === "area" && item.status === "active" && item.workspaceId === captureWorkspaceId).sort((a, b) => a.title.localeCompare(b.title)).map((item) => (
                    <option key={item.id} value={item.id}>{item.title}</option>
                  ))}
                </select>
              </label>
            )}
            {captureType === "task" && (
              <>
                <p>{tr("captureExample")}</p>
                {draft.trim() && (
                  <div className="capturePreview">
                    <strong>{parseCapture(draft).title || tr("untitledTask")}</strong>
                    <span>
                      {parseCapture(draft).when || tr("Inbox")}
                      {parseCapture(draft).priority !== "none" ? ` · ${tr(parseCapture(draft).priority)}` : ""}
                    </span>
                  </div>
                )}
                {captureSuggestionBusy && <div className="captureSuggestionState">◇ {tr("suggesting")}</div>}
                {captureSuggestionError && !captureSuggestionBusy && (
                  <div className="captureSuggestionState error">{captureSuggestionError}</div>
                )}
                {captureSuggestion && !captureSuggestionBusy && (
                  <div className="captureSuggestion">
                    <div className="captureSuggestionHead">
                      <strong>◇ {tr("albertSuggestion")}</strong>
                      <span>{tr("confidence")}: {tr(captureSuggestion.confidence)}</span>
                    </div>
                    <label className="captureSuggestionToggle">
                      <input
                        type="checkbox"
                        checked={useCaptureSuggestion}
                        onChange={(event) => setUseCaptureSuggestion(event.target.checked)}
                      />
                      {tr("useSuggestion")}
                    </label>
                    {captureSuggestion.newProjectSuggestion && !captureProjectId && useCaptureSuggestion && (
                      <fieldset className="captureProjectChoice">
                        <legend>{tr("projectChoice")}</legend>
                        <label>
                          <input
                            type="radio"
                            name="capture-project-action"
                            checked={captureProjectAction === "new"}
                            onChange={() => { setCaptureProjectAction("new"); setCaptureSuggestionError(""); }}
                          />
                          <span>
                            <b>{tr("createSuggestedProject")}</b>
                            <small>{captureSuggestion.newProjectSuggestion.reason}</small>
                          </span>
                        </label>
                        {captureProjectAction === "new" && (
                          <label className="captureNewProjectName">
                            {tr("newProjectName")}
                            <input
                              value={captureSuggestion.newProjectSuggestion.title}
                              maxLength={120}
                              onChange={(event) => setCaptureSuggestion({
                                ...captureSuggestion,
                                newProjectSuggestion: captureSuggestion.newProjectSuggestion
                                  ? { ...captureSuggestion.newProjectSuggestion, title: event.target.value }
                                  : null,
                              })}
                            />
                          </label>
                        )}
                        <label>
                          <input
                            type="radio"
                            name="capture-project-action"
                            checked={captureProjectAction === "existing"}
                            onChange={() => { setCaptureProjectAction("existing"); setCaptureSuggestionError(""); }}
                          />
                          <span><b>{tr("assignExistingProject")}</b></span>
                        </label>
                        {captureProjectAction === "existing" && (
                          <select
                            aria-label={tr("project")}
                            value={captureSuggestion.projectId}
                            onChange={(event) => {
                              const entity = items.find((item) => item.id === event.target.value);
                              setCaptureSuggestion({ ...captureSuggestion, projectId: event.target.value, projectTitle: entity?.title || "" });
                            }}
                          >
                            <option value="">—</option>
                            {items.filter((item) => item.type === "project" && item.status === "active" && item.workspaceId === writeWorkspaceId).sort((a, b) => a.title.localeCompare(b.title)).map((item) => (
                              <option key={item.id} value={item.id}>{item.title}</option>
                            ))}
                          </select>
                        )}
                        <label>
                          <input
                            type="radio"
                            name="capture-project-action"
                            checked={captureProjectAction === "none"}
                            onChange={() => { setCaptureProjectAction("none"); setCaptureSuggestionError(""); }}
                          />
                          <span><b>{tr("withoutProject")}</b></span>
                        </label>
                        {!captureProjectAction && <small className="captureProjectRequired">{tr("chooseProjectBeforeAdding")}</small>}
                      </fieldset>
                    )}
                    <div className="captureSuggestionGrid" aria-disabled={!useCaptureSuggestion}>
                      {(!captureSuggestion.newProjectSuggestion || Boolean(captureProjectId)) && (
                        <label>
                          {tr("project")}
                          <select
                            value={captureSuggestion.projectId}
                            disabled={!useCaptureSuggestion || Boolean(captureProjectId)}
                            onChange={(event) => {
                              const entity = items.find((item) => item.id === event.target.value);
                              setCaptureSuggestion({ ...captureSuggestion, projectId: event.target.value, projectTitle: entity?.title || "" });
                              setCaptureProjectAction(event.target.value ? "existing" : "none");
                            }}
                          >
                            <option value="">—</option>
                            {items.filter((item) => item.type === "project" && item.status === "active" && item.workspaceId === writeWorkspaceId).sort((a, b) => a.title.localeCompare(b.title)).map((item) => (
                              <option key={item.id} value={item.id}>{item.title}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label>
                        {tr("priority")}
                        <select
                          value={captureSuggestion.priority}
                          disabled={!useCaptureSuggestion || parseCapture(draft).priority !== "none"}
                          onChange={(event) => setCaptureSuggestion({ ...captureSuggestion, priority: event.target.value as CaptureSuggestion["priority"] })}
                        >
                          {(["none", "low", "medium", "high"] as const).map((priority) => (
                            <option key={priority} value={priority}>{tr(priority)}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {tr("duration")}
                        <span className="captureDurationInput">
                          <DurationInput
                            value={captureSuggestion.estimatedMinutes}
                            disabled={!useCaptureSuggestion}
                            onChange={(minutes) => setCaptureSuggestion({
                              ...captureSuggestion,
                              estimatedMinutes: minutes,
                              scheduledStart: "",
                              scheduledEnd: "",
                              scheduledDate: parseCapture(draft).when,
                              scheduledOptions: [],
                            })}
                          />
                          {tr("minutes")}
                        </span>
                      </label>
                    </div>
                    <div className="capturePlannedTime">
                      <b>{tr("plannedTime")}</b>
                      {captureSuggestion.scheduledOptions.length ? (
                        <select
                          value={captureSuggestion.scheduledStart}
                          disabled={!useCaptureSuggestion}
                          onChange={(event) => {
                            const option = captureSuggestion.scheduledOptions.find((candidate) => candidate.start === event.target.value);
                            setCaptureSuggestion({
                              ...captureSuggestion,
                              scheduledStart: option?.start || "",
                              scheduledEnd: option?.end || "",
                              scheduledDate: option?.date || parseCapture(draft).when,
                            });
                          }}
                        >
                          <option value="">{tr("noPlannedTime")}</option>
                          {captureSuggestion.scheduledOptions.map((option) => (
                            <option key={option.start} value={option.start}>
                              {new Date(option.start).toLocaleString(language === "cs" ? "cs-CZ" : "en-US", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </option>
                          ))}
                        </select>
                      ) : <span>{tr("noFreeSlot")}</span>}
                    </div>
                    <details>
                      <summary>{tr("whySuggested")}</summary>
                      <ul>{captureSuggestion.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                      <b>{tr("constraintsUsed")}</b>
                      <ul>{captureSuggestion.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul>
                    </details>
                  </div>
                )}
              </>
            )}
            <div>
              <button type="button" onClick={() => setCapture(false)}>
                {tr("cancel")}
              </button>
              <button
                type="submit"
                className="ai"
                disabled={!draft.trim() || (captureType === "task" && (
                  captureSuggestionBusy || Boolean(useCaptureSuggestion && captureSuggestion?.newProjectSuggestion && (
                    !captureProjectAction ||
                    (captureProjectAction === "new" && !captureSuggestion.newProjectSuggestion.title.trim()) ||
                    (captureProjectAction === "existing" && !captureSuggestion.projectId)
                  ))
                ))}
              >
                {captureType === "note" ? tr("addNote") : tr("addTask")}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
