"use client";
import { type CaptureSuggestion } from "../types";
import type { LumiApp } from "../use-lumi-app";

export function CaptureDialog({ app }: { app: LumiApp }) {
  const {
    activeWorkspaceId,
    capture,
    captureModalRef,
    captureProjectAction,
    captureProjectId,
    captureSuggestion,
    captureSuggestionBusy,
    captureSuggestionError,
    captureType,
    draft,
    items,
    language,
    parseCapture,
    selectWriteWorkspace,
    setCapture,
    setCaptureProjectAction,
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
            onKeyDown={(e) => {
              if (e.key === "Escape") setCapture(false);
              if (e.key === "Tab") {
                const focusable = [...(captureModalRef.current?.querySelectorAll<HTMLElement>(
                  'input, button:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
                ) || [])];
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              submitCapture();
            }}
          >
            <h2 id="capture-title">{captureType === "note" ? tr("addNote") : tr("quickCapture")}</h2>
            {activeWorkspaceId === "all" && !captureProjectId && (
              <label className="captureWorkspace">
                {tr("workspace")}
                <select
                  value={writeWorkspaceId}
                  onChange={(event) => selectWriteWorkspace(event.target.value)}
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
                            {items.filter((item) => item.type === "project" && item.status === "active" && item.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId)).sort((a, b) => a.title.localeCompare(b.title)).map((item) => (
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
                            {items.filter((item) => item.type === "project" && item.status === "active" && item.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId)).sort((a, b) => a.title.localeCompare(b.title)).map((item) => (
                              <option key={item.id} value={item.id}>{item.title}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label>
                        {tr("area")}
                        <select
                          value={captureSuggestion.areaId}
                          disabled={!useCaptureSuggestion}
                          onChange={(event) => {
                            const entity = items.find((item) => item.id === event.target.value);
                            setCaptureSuggestion({ ...captureSuggestion, areaId: event.target.value, areaTitle: entity?.title || "" });
                          }}
                        >
                          <option value="">—</option>
                          {items.filter((item) => item.type === "area" && item.status === "active" && item.workspaceId === (activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId)).sort((a, b) => a.title.localeCompare(b.title)).map((item) => (
                            <option key={item.id} value={item.id}>{item.title}</option>
                          ))}
                        </select>
                      </label>
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
                          <input
                            type="number"
                            min="10"
                            max="480"
                            step="5"
                            value={captureSuggestion.estimatedMinutes}
                            disabled={!useCaptureSuggestion}
                            onChange={(event) => setCaptureSuggestion({
                              ...captureSuggestion,
                              estimatedMinutes: Math.max(10, Math.min(480, Number(event.target.value) || 10)),
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
