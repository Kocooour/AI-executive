"use client";
import { byManualOrder, taskDueTone } from "../../../lib/task-views";
import { addLocalDays, fromLocalDateTime, toLocalDateTime, ymd, zonedDateTimeToIso } from "../../../lib/local-dates";
import { isFallbackArea } from "../../../lib/area-write-invariants";
import type { LumiApp } from "../use-lumi-app";
import { ProjectIcon } from "./project-icon";
import { DurationInput } from "./duration-input";
import { SyncConflicts } from "./sync-conflicts";
import { NoteEditor } from "./note-editor";
import { DeferChip } from "./defer-popover";
import { InboxTriage } from "./inbox-triage";
import { heldBackReason } from "./held-back";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { mobileDesignV1Preview } from "../navigation";
import { entityConflicts } from "../../../lib/field-merge";
import { taskPreviewCanToggle } from "../../../lib/task-detail-preview";

// What a field has sent and not yet seen come back as the stored value. Saves finish later than
// they start: comparing a new value with the stored one would skip a change back to it (A → B →
// A while B is still being saved), and B would win. A newer value is compared with what was sent
// last instead, and the stored value is shown again once it has caught up.
function useSentValue(stored: string, show: (value: string) => void, canShow: () => boolean = () => true) {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (sent.current !== null && stored !== sent.current) return; // an older save finishing
    sent.current = null;
    if (canShow()) show(stored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  return (next: string, save: (value: string) => void) => {
    if (next === (sent.current ?? stored)) return;
    sent.current = next;
    save(next);
  };
}

// The follow-up date. What is typed is kept here; a year typed digit by digit passes through
// dates like 0002-10-09, so only a cleared field or a plausible date is saved.
function FollowUpDateInput({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [shown, setShown] = useState(value);
  const send = useSentValue(value, setShown);
  return (
    <input
      type="date"
      value={shown}
      onChange={(event) => {
        const next = event.target.value;
        setShown(next);
        if (next === "" || Number(next.slice(0, 4)) >= 2000) send(next, onSave);
      }}
    />
  );
}

// Who or what the task waits for, saved when the field is left.
function WaitingForInput({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (value: string) => void }) {
  const [shown, setShown] = useState(value);
  const focused = useRef(false);
  // A change from elsewhere does not replace what is being typed.
  const send = useSentValue(value, setShown, () => !focused.current);
  return (
    <input
      value={shown}
      maxLength={120}
      placeholder={placeholder}
      onFocus={() => { focused.current = true; }}
      onChange={(event) => setShown(event.target.value)}
      onBlur={(event) => {
        focused.current = false;
        send(event.target.value.trim(), onSave);
      }}
    />
  );
}

function gmailSource(value: unknown): { accountId: string; messageId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.provider !== "gmail" || typeof item.accountId !== "string" || typeof item.messageId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(item.accountId) || !/^[0-9a-f]{5,64}$/i.test(item.messageId)) return null;
  return { accountId: item.accountId, messageId: item.messageId };
}

function TaskPreviewTitle({ children }: { children: ReactNode }) {
  return <div className="taskPreviewTitleRow">{children}</div>;
}

export function DetailPanel({ app }: { app: LumiApp }) {
  const {
    titleEdited,
    titleEditSeq,
    noteOpenTexts,
    unsent,
    heldBack,
    acceptNativeDrop,
    areas,
    calendarToday,
    checklistDraft,
    closeDetail,
    closeInspector,
    editNotes,
    notesDraft,
    saveNotes,
    context,
    contextClaims,
    contextPredicateLabel,
    done,
    dragHandle,
    dragTarget,
    draggingId,
    inspect,
    language,
    notificationState,
    patch,
    projects,
    relate,
    remove,
    rename,
    reopenTask,
    scheduleTask,
    selected,
    setActiveDragTarget,
    setChecklistDraft,
    setSelected,
    sources,
    targets,
    tasks,
    today,
    tr,
    view,
    workSession,
  } = app;
  const source = selected?.type === "task" ? gmailSource(selected.properties.mailSource) : null;
  const [mobileViewport, setMobileViewport] = useState(false);
  useEffect(() => {
    if (!mobileDesignV1Preview) return;
    const media = window.matchMedia("(max-width: 700px)");
    const sync = () => setMobileViewport(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const selectedTask = selected?.type === "task" ? selected : null;
  const activeTaskSession = Boolean(selectedTask && workSession?.taskId === selectedTask.id);
  const mobileTaskPreview = Boolean(mobileDesignV1Preview && mobileViewport && selectedTask);
  const taskPreviewDueTone = selectedTask ? taskDueTone(selectedTask, today) : "";
  const taskPreviewMayToggle = taskPreviewCanToggle(selectedTask, app.activeWorkspaceId,
    Boolean(selectedTask && (isFallbackArea(selectedTask, app.items) ||
      unsent.has(selectedTask.id) || heldBack.some((item) => item.id === selectedTask.id) ||
      entityConflicts(selectedTask).length > 0 || activeTaskSession)));
  const taskProjectId = selectedTask ? targets(selectedTask.id, "belongs_to_project")[0] : null;
  const taskProject = selectedTask && taskProjectId
    ? projects.find((project) => project.id === taskProjectId && project.workspaceId === selectedTask.workspaceId)
    : null;
  const inspectorRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Opening with the keyboard moves focus into the inspector; closing returns it to the
  // row that opened it. Pointer-driven selection is left alone.
  useEffect(() => {
    if (selected) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches(".taskRowOpen")) {
        returnFocusRef.current = active;
        inspectorRef.current?.focus();
      }
    } else if (returnFocusRef.current) {
      if (returnFocusRef.current.isConnected) returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [selected?.id]);
  return (
    <>
      {selected && (
        <div className="backdrop inspectorBackdrop" onClick={closeInspector}>
          <aside ref={inspectorRef} tabIndex={-1} className="detail inspectorDetail" aria-label={`${tr(selected.type)}: ${selected.title}`}
            data-task-detail-preview={mobileTaskPreview ? "lumi-v1" : undefined}
            data-task-due-tone={mobileTaskPreview ? taskPreviewDueTone : undefined}
            data-task-completed={mobileTaskPreview && selectedTask ? selectedTask.status === "completed" : undefined}
            onClick={(e) => e.stopPropagation()}>
            <button
              className="close inspectorClose"
              type="button"
              onClick={closeInspector}
            >
              <span className="inspectorCloseIcon"><span aria-hidden="true">×</span><span className="inspectorCloseAccessible">{tr("close")}</span></span>
              <span className="inspectorBackLabel">{language === "cs" ? "← Zpět" : "← Back"}</span>
            </button>
            <p className="eyebrow">{tr(selected.type)}</p>
            <TaskPreviewTitle>
              {mobileTaskPreview && selectedTask && (
                <button type="button" className="taskPreviewCheck" data-task-preview-check={selectedTask.id}
                  role="checkbox" aria-checked={selectedTask.status === "completed"}
                  aria-label={activeTaskSession
                    ? `${language === "cs" ? "Nejdřív ukončete pracovní blok" : "Finish the work session first"}: ${selectedTask.title}`
                    : selectedTask.status === "completed"
                      ? `${tr("reopen")}: ${selectedTask.title}`
                      : `${tr("complete")}: ${selectedTask.title}${taskPreviewDueTone === "dueOverdue"
                        ? language === "cs" ? " · Po termínu" : " · Overdue"
                        : taskPreviewDueTone === "dueSoon"
                          ? language === "cs" ? " · Blíží se termín" : " · Due soon"
                          : ""}`}
                  disabled={!taskPreviewMayToggle}
                  onClick={() => {
                    if (!taskPreviewMayToggle) return;
                    if (selectedTask.status === "completed") void reopenTask(selectedTask);
                    else void done(selectedTask.id);
                  }}>
                  {selectedTask.status === "completed" ? <span aria-hidden="true">✓</span> : null}
                </button>
              )}
            <input
              className="titleEdit"
              readOnly={isFallbackArea(selected, app.items)}
              maxLength={1000}
              value={selected.title}
              onChange={(e) => {
                titleEdited.current = true;
                titleEditSeq.current += 1;
                setSelected({ ...selected, title: e.target.value });
              }}
              onBlur={(e) => {
                // Only a title the user changed is saved; an untouched field cannot put back an old one.
                if (!titleEdited.current) { noteOpenTexts(); return; }
                // The title stays marked as edited (also for other tabs signing out) until it is
                // saved; a failed save keeps it marked, and typing on during the save keeps it too.
                const seq = titleEditSeq.current;
                rename(selected, e.target.value, seq).then(() => {
                  if (titleEditSeq.current !== seq) return;
                  titleEdited.current = false;
                  noteOpenTexts();
                }, () => undefined);
              }}
            />
            </TaskPreviewTitle>
            {mobileTaskPreview && selectedTask && (
              <div className="taskPreviewFacts" data-task-preview-facts aria-label={language === "cs" ? "Základní údaje o úkolu" : "Task essentials"}>
                {typeof selectedTask.properties.when === "string" && selectedTask.properties.when &&
                  <span>{tr("when")}: <strong>{selectedTask.properties.when}</strong></span>}
                {typeof selectedTask.properties.deadline === "string" && selectedTask.properties.deadline &&
                  <span>{tr("deadline")}: <strong>{selectedTask.properties.deadline}</strong></span>}
                {taskProject &&
                  <span>{tr("project")}: <strong>{taskProject.title}</strong></span>}
              </div>
            )}
            {heldBack.some((entity) => entity.id === selected.id)
              ? <p className="recordState recordHeldBack" role="status">{tr("heldBackDetail").replace("{reason}", () => heldBackReason(app, selected))}</p>
              : unsent.has(selected.id) && <p className="recordState" role="status">{tr("unsentDetail")}</p>}
            {isFallbackArea(selected, app.items) && <p className="recordState" role="status" data-testid="fallback-area-note">{tr("fallbackAreaProtected")}</p>}
            <SyncConflicts app={app} entity={selected} />
            {context && (
              <div className="contextStrip">
                <b>{tr("context")}</b>
                <span>
                  {tr("contextSummary").replace("{tasks}", String(context.summary.tasks)).replace("{notes}", String(context.summary.notes))
                    .replace("{projects}", String(context.summary.projects)).replace("{areas}", String(context.summary.areas))}
                </span>
                <small>
                  {context.related
                    .slice(0, 6)
                    .map((x) => x.title)
                    .join(" · ") || tr("noRelatedEntities")}
                </small>
              </div>
            )}
            {selected.type === "task" && (
              <section className="detailKnowledge" aria-label={tr("whatLumiKnows")}>
                <h3>{tr("whatLumiKnows2")}</h3>
                {contextClaims.filter((claim) => (claim.subject.canonicalEntityId === selected.id || claim.target?.canonicalEntityId === selected.id) && !claim.archivedAt).map((claim) => <article key={claim.id}>
                  <strong>{claim.subject.title} · {contextPredicateLabel(claim.predicate)}: {String(claim.literal?.value ?? claim.target?.title ?? "—")}</strong>
                  <small>{claim.reviewStatus === "confirmed" ? (tr("confirmed2")) : claim.reviewStatus === "proposed" ? (tr("toReview2")) : (tr("rejected"))} · {claim.freshness === "current" ? (tr("current2")) : claim.freshness === "needs_review" ? (tr("needsReview2")) : (tr("stale2"))}{claim.validTo ? ` · ${tr("validTo2")} ${claim.validTo}` : ""}</small>
                </article>)}
                {!contextClaims.some((claim) => (claim.subject.canonicalEntityId === selected.id || claim.target?.canonicalEntityId === selected.id) && !claim.archivedAt) && <p>{tr("noClaimsForThis")}</p>}
              </section>
            )}
            {selected.type === "area" && (
              <div className="projectDetail">
                <h3>{tr("Projects").toUpperCase()}</h3>
                {projects
                  .filter((p) =>
                    sources(selected.id, "belongs_to_area").includes(p.id),
                  )
                  .sort(byManualOrder(`project:area:${selected.id}`))
                  .map((p) => (
                    <article
                      key={p.id}
                      className={`${draggingId === p.id ? "isDragging" : ""} ${dragTarget === `entity:${p.id}` ? "dropActive" : ""}`.trim()}
                      data-drop-entity={p.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${p.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${p.id}`)}
                      onClick={() => inspect(p)}
                    >
                      {dragHandle(p, `project:area:${selected.id}`)}
                      <div className="entityIcon projectIcon"><ProjectIcon /></div>
                      <div>
                        <strong>{p.title}</strong>
                        <small>{tr("project")}</small>
                      </div>
                    </article>
                  ))}
                <h3>{tr("task").toUpperCase()}</h3>
                {tasks
                  .filter(
                    (t) =>
                      t.status === "open" &&
                      sources(selected.id, "belongs_to_area").includes(t.id),
                  )
                  .sort(byManualOrder(`task:area:${selected.id}`))
                  .map((t) => (
                    <article
                      key={t.id}
                      className={`${draggingId === t.id ? "isDragging" : ""} ${dragTarget === `entity:${t.id}` ? "dropActive" : ""} ${taskDueTone(t, today)}`.trim()}
                      data-drop-entity={t.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${t.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${t.id}`)}
                      onClick={() => inspect(t)}
                    >
                      {dragHandle(t, `task:area:${selected.id}`)}
                      <button
                        className="check"
                        onClick={(e) => {
                          e.stopPropagation();
                          done(t.id);
                        }}
                      >
                        ○
                      </button>
                      <strong>{t.title}</strong>
                    </article>
                  ))}
              </div>
            )}
            {selected.type === "note" && (
              <div className="fields">
                <label>
                  {tr("project")}
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_project")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_project",
                      );
                    }}
                  >
                    <option value="">{tr("none")}</option>
                    {projects.filter((project) => project.workspaceId === selected.workspaceId && (project.status === "active" || targets(selected.id, "belongs_to_project").includes(project.id))).map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {selected.type === "note" && <NoteEditor key={selected.id} app={app} />}
            {selected.type === "task" && selected.status === "open" && selected.properties.inbox === true && view === "Inbox" &&
              <InboxTriage key={selected.id} app={app} task={selected} />}
            {selected.type === "task" && source && (
              <section className="detailKnowledge" aria-label={language === "cs" ? "Zdrojový e-mail" : "Source email"}>
                <h3>{language === "cs" ? "Zdrojový e-mail" : "Source email"}</h3>
                <p>Gmail · {language === "cs" ? "Odkaz na původní zprávu" : "Reference to the original message"}</p>
                <button type="button" onClick={() => {
                  app.setMailSourceToOpen({ workspaceId: selected.workspaceId, accountId: source.accountId, messageId: source.messageId });
                  closeDetail();
                  app.selectWorkspace(selected.workspaceId);
                  app.setInboxTab("mail");
                  app.setView("Inbox");
                }}>{language === "cs" ? "Otevřít zdrojovou zprávu" : "Open source message"}</button>
              </section>
            )}
            {selected.type === "task" && (
              <div className="fields">
                <label>
                  {tr("list")}
                  <select
                    value={
                      selected.properties.inbox === true
                        ? "Inbox"
                        : selected.properties.someday === true
                          ? "Someday"
                        : selected.properties.today === true ||
                            (typeof selected.properties.when === "string" && selected.properties.when !== "" && selected.properties.when <= today)
                            ? "Today"
                            : "Anytime"
                    }
                    onChange={(event) => {
                      const destination = event.target.value;
                      patch(selected, {
                        inbox: destination === "Inbox",
                        someday: destination === "Someday",
                        today: destination === "Today",
                        when: destination === "Today" ? today : "",
                      }, `moved to ${destination}`);
                    }}
                  >
                    <option value="Inbox">{tr("Inbox")}</option>
                    <option value="Today">{tr("Today")}</option>
                    <option value="Anytime">{tr("Anytime")}</option>
                    <option value="Someday">{tr("Someday")}</option>
                  </select>
                </label>
                <div className="scheduleField">
                  <span>{tr("when")}</span>
                  <div className="scheduleChoices" role="group" aria-label={tr("when")}>
                    {(["today", "tomorrow", "someday", "clear"] as const).map((choice) => (
                      <button key={choice} type="button"
                        className={choice === "today" ? (selected.properties.when === today ? "active" : "")
                          : choice === "tomorrow" ? (selected.properties.when === ymd(addLocalDays(new Date(), 1)) ? "active" : "")
                            : choice === "someday" ? (selected.properties.someday === true ? "active" : "")
                              : (!selected.properties.when && selected.properties.someday !== true && selected.properties.inbox !== true ? "active" : "")}
                        onClick={() => void scheduleTask(selected, choice)}>{tr(`schedule${choice[0].toUpperCase()}${choice.slice(1)}`)}</button>
                    ))}
                  </div>
                  <input
                    type="date"
                    aria-label={tr("when")}
                    value={String(selected.properties.when || "")}
                    onChange={(e) => void scheduleTask(selected, e.target.value || "clear")}
                  />
                </div>
                <label>
                  {tr("deadline")}
                  <input
                    type="date"
                    value={String(selected.properties.deadline || "")}
                    onChange={(e) =>
                      patch(selected, { deadline: e.target.value })
                    }
                  />
                </label>
                <label>
                  {tr("project")}
                  <select
                    value={String(
                      targets(selected.id, "belongs_to_project")[0] || "",
                    )}
                    onChange={async (e) => {
                      await relate(
                        selected.id,
                        e.target.value,
                        "belongs_to_project",
                      );
                    }}
                  >
                    <option value="">{tr("none")}</option>
                    {projects.filter((project) => project.workspaceId === selected.workspaceId && (project.status === "active" || targets(selected.id, "belongs_to_project").includes(project.id))).map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                {targets(selected.id, "belongs_to_project").length > 0 ? (
                  // 2a part 4: a task in a project has no Area of its own, it inherits the project's.
                  <p className="inheritedArea" id="inherited-area-note" data-testid="inherited-area">
                    {tr("areaFromProject").replace("{name}", (() => {
                      const projectArea = areas.find((area) => area.id === targets(targets(selected.id, "belongs_to_project")[0], "belongs_to_area")[0]);
                      return projectArea?.title || "—";
                    })())}
                  </p>
                ) : (
                  <label>
                    {tr("area")}
                    <select
                      aria-label={tr("area")}
                      value={String(
                        targets(selected.id, "belongs_to_area")[0] || "",
                      )}
                      onChange={async (e) => {
                        await relate(
                          selected.id,
                          e.target.value,
                          "belongs_to_area",
                        );
                      }}
                    >
                      {/* A legacy task without an Area is shown as unassigned; an Area cannot be cleared. */}
                      {!targets(selected.id, "belongs_to_area")[0] && <option value="" disabled>{tr("none")}</option>}
                      {areas.filter((area) => area.workspaceId === selected.workspaceId).map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.title}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label>
                  {tr("priority")}
                  <select
                    value={String(selected.properties.priority || "none")}
                    onChange={(e) =>
                      patch(selected, { priority: e.target.value })
                    }
                  >
                    <option value="none">{tr("none")}</option>
                    <option value="low">{tr("low")}</option>
                    <option value="medium">{tr("medium")}</option>
                    <option value="high">{tr("high")}</option>
                  </select>
                </label>
                <fieldset className="waitingField">
                  <legend>{tr("waitingTitle")}</legend>
                  <label className="inlineCheck">
                    <input
                      type="checkbox"
                      checked={selected.properties.waiting === true}
                      onChange={(event) => patch(selected, event.target.checked
                        // A waiting task is sorted: it leaves the Inbox (owner decision 2026-10-09).
                        // Starts clean: a date or name left by an earlier waiting (or merged in from
                        // another device) would otherwise come back with it.
                        ? { waiting: true, waitingSince: Date.now(), inbox: false, waitingFor: "", followUpDate: "" }
                        : { waiting: false, waitingFor: "", waitingSince: null, followUpDate: "" }, event.target.checked ? "waiting started" : "waiting ended", true)}
                    />
                    {tr("waitingToggle")}
                  </label>
                  {selected.properties.waiting === true && (
                    <>
                      <label>
                        {tr("waitingFor")}
                        <WaitingForInput
                          key={selected.id}
                          value={String(selected.properties.waitingFor || "")}
                          placeholder={tr("waitingForPlaceholder")}
                          onSave={(value) => void patch(selected, { waitingFor: value }, "waiting for changed", true)}
                        />
                      </label>
                      <label>
                        {tr("followUpDate")}
                        <FollowUpDateInput
                          key={selected.id}
                          value={String(selected.properties.followUpDate || "")}
                          onSave={(value) => void patch(selected, { followUpDate: value }, "follow-up date changed", true)}
                        />
                      </label>
                      <small>{tr("waitingHelp")}</small>
                    </>
                  )}
                </fieldset>
                <label>
                  {tr("duration")}
                  <DurationInput
                    value={String(selected.properties.estimatedMinutes || "")}
                    onChange={(estimatedMinutes) => {
                      const plannedStart = String(selected.properties.plannedStart || "");
                      patch(selected, {
                        estimatedMinutes,
                        ...(plannedStart ? { plannedEnd: new Date(Date.parse(plannedStart) + estimatedMinutes * 60_000).toISOString() } : {}),
                      }, "duration changed");
                    }}
                  />
                </label>
                <label>
                  {tr("plannedTime")}
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(selected.properties.plannedStart)}
                    onChange={(event) => {
                      const plannedStart = fromLocalDateTime(event.target.value);
                      const estimatedMinutes = Number(selected.properties.estimatedMinutes || 30);
                      const feedback = { date: calendarToday, decision: "adjusted", at: Date.now(), chosenStart: plannedStart,
                        plannedMinutes: plannedStart ? estimatedMinutes : undefined };
                      const history = Array.isArray(selected.properties.planningHistory) ? selected.properties.planningHistory : [];
                      patch(selected, {
                        plannedStart,
                        plannedEnd: plannedStart ? new Date(Date.parse(plannedStart) + estimatedMinutes * 60_000).toISOString() : "",
                        planningSource: plannedStart ? "manual" : "",
                        planningFeedback: feedback,
                        planningHistory: [...history, feedback].slice(-50),
                        ...(event.target.value ? { when: event.target.value.slice(0, 10), inbox: false, someday: false } : {}),
                      }, "planned time changed");
                    }}
                  />
                </label>
                <label>
                  {tr("reminder")}
                  <input
                    type="datetime-local"
                    value={toLocalDateTime(selected.properties.reminderAt)}
                    onChange={(e) =>
                      patch(selected, { reminderAt: fromLocalDateTime(e.target.value) }, "reminder changed")
                    }
                  />
                </label>
                {selected.properties.when && notificationState && (
                  <button
                    type="button"
                    onClick={() => {
                      const planned = new Date(`${String(selected.properties.when)}T12:00:00Z`);
                      const workdays = notificationState.preferences.workdays;
                      while (workdays.length && !workdays.includes(planned.getUTCDay())) {
                        planned.setUTCDate(planned.getUTCDate() + 1);
                      }
                      const date = planned.toISOString().slice(0, 10);
                      patch(selected, {
                        reminderAt: zonedDateTimeToIso(
                          date,
                          notificationState.preferences.workdayStart,
                          notificationState.preferences.timezone,
                        ),
                      }, "workday reminder set");
                    }}
                  >
                    {tr("nextWorkday")}
                  </button>
                )}
                <label>
                  {tr("taskNotes")}
                  <textarea
                    value={notesDraft?.id === selected.id ? notesDraft.text : String(selected.properties.notes || "")}
                    onChange={(e) => editNotes(selected.id, e.target.value, String(selected.properties.notes || ""))}
                    // Only notes typed here are saved: leaving the field unchanged must not write the
                    // value it showed back over a change made meanwhile in another tab or device.
                    onBlur={(e) => { if (notesDraft?.id === selected.id) void saveNotes(selected, e.target.value); }}
                    placeholder={tr("notesPlaceholder")}
                  />
                </label>
                <div className="checklistField">
                  <span>{tr("checklist")}</span>
                  {(Array.isArray(selected.properties.checklist)
                    ? selected.properties.checklist
                    : []
                  ).map((raw, index, all) => {
                    const item = typeof raw === "string"
                      ? { id: `${index}`, title: raw, done: false }
                      : raw as { id?: string; title?: string; done?: boolean };
                    return (
                      <label className="checklistItem" key={item.id || index}>
                        <input
                          type="checkbox"
                          checked={Boolean(item.done)}
                          onChange={() => patch(selected, (stored) => ({
                            // From the stored list: another tab or device may have changed it.
                            checklist: (Array.isArray(stored.checklist) ? stored.checklist : all).map((entry, entryIndex) => {
                              const normalized = typeof entry === "string"
                                ? { id: `${entryIndex}`, title: entry, done: false }
                                : entry as { id?: string; title?: string; done?: boolean };
                              const target = item.id ? normalized.id === item.id : entryIndex === index;
                              return target ? { ...normalized, done: !item.done } : normalized;
                            }),
                          }), "checklist updated")}
                        />
                        <span className={item.done ? "checked" : ""}>{item.title}</span>
                      </label>
                    );
                  })}
                  <div className="checklistAdd">
                    <input
                      value={checklistDraft}
                      onChange={(event) => setChecklistDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" || !checklistDraft.trim()) return;
                        event.preventDefault();
                        const added = { id: crypto.randomUUID(), title: checklistDraft.trim(), done: false };
                        patch(selected, (stored) => ({
                          checklist: [...(Array.isArray(stored.checklist) ? stored.checklist : []), added],
                        }), "checklist item added");
                        setChecklistDraft("");
                      }}
                      placeholder={tr("addChecklistItem")}
                    />
                    <button
                      type="button"
                      disabled={!checklistDraft.trim()}
                      onClick={() => {
                        const added = { id: crypto.randomUUID(), title: checklistDraft.trim(), done: false };
                        patch(selected, (stored) => ({
                          checklist: [...(Array.isArray(stored.checklist) ? stored.checklist : []), added],
                        }), "checklist item added");
                        setChecklistDraft("");
                      }}
                    >{tr("add")}</button>
                  </div>
                </div>
                <label>
                  {tr("repeat")}
                  <select
                    value={String(
                      (selected.properties.recurrence as any)?.frequency ||
                        selected.properties.repeat ||
                        "",
                    )}
                    onChange={(e) =>
                      patch(selected, {
                        recurrence: e.target.value
                          ? {
                              frequency: e.target.value,
                              interval: 1,
                              mode: "scheduled",
                            }
                          : null,
                        repeat: null,
                      })
                    }
                  >
                    <option value="">{tr("never")}</option>
                    <option value="daily">{tr("daily")}</option>
                    <option value="weekly">{tr("weekly")}</option>
                    <option value="monthly">{tr("monthly")}</option>
                    <option value="yearly">{tr("yearly")}</option>
                  </select>
                </label>
                {(selected.properties.recurrence as any)?.frequency && (
                  <>
                    <label>
                      {tr("every")}
                      <input
                        type="number"
                        min="1"
                        value={String(
                          (selected.properties.recurrence as any)?.interval ||
                            1,
                        )}
                        onChange={(e) =>
                          patch(selected, {
                            recurrence: {
                              ...(selected.properties.recurrence as any),
                              interval: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      {tr("repeatFrom")}
                      <select
                        value={String(
                          (selected.properties.recurrence as any)?.mode ||
                            "scheduled",
                        )}
                        onChange={(e) =>
                          patch(selected, {
                            recurrence: {
                              ...(selected.properties.recurrence as any),
                              mode: e.target.value,
                            },
                          })
                        }
                      >
                        <option value="scheduled">{tr("scheduledDate")}</option>
                        <option value="completion">{tr("completionDate")}</option>
                      </select>
                    </label>
                  </>
                )}
                {Array.isArray(selected.properties.activity) && selected.properties.activity.length > 0 && (
                  <div className="activityLog">
                    <h3>{tr("history").toUpperCase()}</h3>
                    {[...selected.properties.activity]
                      .reverse()
                      .slice(0, 12)
                      .map((entry: any, index) => (
                        <div key={`${entry.at}-${index}`}>
                          <span>{String(entry.action || "updated")}</span>
                          <time>{new Date(Number(entry.at)).toLocaleString()}</time>
                        </div>
                      ))}
                  </div>
                )}
                <button
                  onClick={() =>
                    patch(selected, {
                      someday: true,
                      today: false,
                      when: "",
                      inbox: false,
                    })
                  }
                >
                  {tr("moveSomeday")}
                </button>
                {selected.status === "open" && app.activeWorkspaceId !== "all" && <DeferChip app={app} task={selected} />}
                {(!mobileTaskPreview || activeTaskSession) && (selected.status === "completed" ? (
                  <button onClick={() => reopenTask(selected)}>{tr("reopen")}</button>
                ) : (
                  <button className="primaryAction" onClick={() => done(selected.id)}>{workSession?.taskId === selected.id ? tr("workFinish") : tr("complete")}</button>
                ))}
                <button className="danger" disabled={isFallbackArea(selected, app.items)} onClick={() => remove(selected)}>
                  {tr("delete")}
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
