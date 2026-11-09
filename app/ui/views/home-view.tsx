"use client";
import { useEffect, useState } from "react";
import { taskDueTone, taskMatchesView } from "../../../lib/task-views";
import { taskPreviewCompletionTone, taskPreviewStateText } from "../../../lib/lumi-completion-state";
import { mobileDesignV1Preview } from "../navigation";
import { LumiCompletionControl } from "./lumi-completion-control";
import { attentionReason, taskDueSummary } from "../format";
import type { LumiApp } from "../use-lumi-app";
import { AttentionItemRow } from "./attention-item";
import { DeferChip } from "./defer-popover";
import { RecordMarks } from "./held-back";
import { CalendarEventNotice } from "./calendar-event-actions";
import { TodayAgenda } from "./today-agenda";
import { WorkNowCard } from "./work-now-card";

// Home is the brief of the current state: a status line, at most five attention items, and today.
// Working lists (projects, upcoming, recent) live in their own views.
export function HomeView({ app }: { app: LumiApp }) {
  const {
    acceptNativeDrop,
    activeWorkspaceId,
    attentionActionsBlocked,
    attentionError,
    attentionOutdated,
    attentionFromCache,
    attentionStale,
    calendarFresh,
    calendarSources,
    currentDayPlanBlock,
    dayPlanStatus,
    done,
    dragHandle,
    dragTarget,
    draggingId,
    freeHours,
    homeToday,
    homeTodayTasks,
    inspect,
    items,
    language,
    loadAttention,
    nextDayPlanBlock,
    openCapture,
    setActiveDragTarget,
    setAttentionError,
    setShowAllAttention,
    setView,
    showAllAttention,
    syncStatus,
    today,
    todayCalendarEvents,
    tr,
    view,
    visibleAttention,
    visibleDayPlan,
    workSession,
    writeWorkspace,
  } = app;
  // An ordinary save shows "syncing" for a moment; the line appears only when offline or when
  // syncing takes longer than 2 s, so the list below does not jump on every save.
  const [slowSync, setSlowSync] = useState(false);
  useEffect(() => {
    if (syncStatus === "synced" || syncStatus === "offline") { setSlowSync(false); return; }
    const timer = setTimeout(() => setSlowSync(true), 2000);
    return () => clearTimeout(timer);
  }, [syncStatus]);
  if (view !== "Home") return null;

  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const fill = (key: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), tr(key));
  const shortTime = (value: number, timeZone?: string) =>
    new Date(value).toLocaleString(locale, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
  const planBlockState = (block: { existing?: boolean; planningSource?: string }) =>
    tr(block.existing ? block.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed");

  const capacityLabel = calendarSources.length === 0 ? tr("calendarDisconnected")
    : calendarFresh ? `${freeHours.toLocaleString(locale, { maximumFractionDigits: 1 })} ${tr("freeHours")}` : tr("capacityUnknown");
  const syncLabel = syncStatus === "synced" ? tr("synced") : syncStatus === "syncing" ? tr("syncing")
    : syncStatus === "offline" ? tr("offline") : tr("connecting");
  // Counts come from the same set the list is cut from: Today tasks that are not attention items.
  const moreToday = homeToday.more;
  // The evaluation time is shown once, in the section header (the day too when it is not today).
  const updatedLabel = visibleAttention ? fill("homeUpdated", {
    time: new Date(visibleAttention.evaluatedAt).toLocaleString(locale, {
      ...(new Date(visibleAttention.evaluatedAt).toDateString() === new Date().toDateString() ? {} : { day: "numeric", month: "numeric" }),
      hour: "numeric", minute: "2-digit", timeZone: visibleAttention.timezone }),
  }) : "";
  const proposedBlocks = visibleDayPlan ? visibleDayPlan.planBlocks.length : 0;
  const unscheduledTasks = visibleDayPlan ? visibleDayPlan.unscheduled.length : 0;
  // The plan also takes tasks that are not in Today (a close deadline, high priority).
  const unscheduledOutsideToday = visibleDayPlan ? visibleDayPlan.unscheduled.filter((planned) => {
    const task = items.find((item) => item.id === planned.taskId);
    return !task || !taskMatchesView(task, "Today", today);
  }).length : 0;
  // Calendar and day plan belong to one workspace; name it when Home shows the read-only aggregate.
  const scopeNote = activeWorkspaceId === "all" && writeWorkspace ? ` (${writeWorkspace.title})` : "";

  const showSync = syncStatus === "offline" || (syncStatus !== "synced" && slowSync);

  return (
    <>
      {/* Only states that need something are shown; the Inbox count is in the navigation. */}
      <div role="status" className="homeNoticeLive">{showSync && <p className={`homeNotice homeSync ${syncStatus}`}><span className={`homeNoticeDot ${syncStatus === "offline" ? "danger" : ""}`} aria-hidden="true" />{tr("homeDataState")}: <b>{syncLabel}</b></p>}</div>

      {workSession && <WorkNowCard app={app} compact />}

      <section className="homeSection attentionSection" aria-labelledby="attention-title">
        <div className="homeSectionHead">
          <h2 id="attention-title" tabIndex={-1}>{tr("attentionTitle")}</h2>
          {updatedLabel && <span className="attentionUpdated" data-attention-updated>{updatedLabel}</span>}
          <button type="button" onClick={() => { if (syncStatus === "synced") void loadAttention(activeWorkspaceId).catch((error) => setAttentionError(error instanceof Error ? error.message : tr("attentionUnavailable"))); }} disabled={syncStatus !== "synced"}>
            {tr("refresh")}
          </button>
        </div>
        {visibleAttention ? <>
          {attentionStale
            ? <p className="attentionStale" role="status"><b>{tr("attentionStale")}</b> · {tr(syncStatus === "offline" ? "attentionStaleOffline" : attentionFromCache && !attentionOutdated ? "attentionStaleChecking" : "attentionStaleInfo")} {shortTime(visibleAttention.evaluatedAt, visibleAttention.timezone)}</p>
            : null}
          {attentionActionsBlocked && (syncStatus === "synced" || showSync) && visibleAttention.items.length > 0 && <p className="attentionMeta attentionBlocked">{tr("attentionStaleActions")}</p>}
          {visibleAttention.items.length === 0 ? <p className="attentionEmpty">{tr("attentionNone")}</p> : <div className="attentionList">
            {visibleAttention.items.slice(0, showAllAttention ? undefined : 5).map((candidate) => <AttentionItemRow key={candidate.attentionKey} app={app} candidate={candidate} />)}
          </div>}
          {visibleAttention.items.length > 5 && <button className="textAction" type="button" onClick={() => setShowAllAttention((current) => !current)}>{showAllAttention ? tr("attentionShowFewer") : fill("attentionShowMore", { n: visibleAttention.items.length - 5 })}</button>}
          {(visibleAttention.hidden.snoozed > 0 || visibleAttention.hidden.dismissed > 0) && <p className="attentionMeta">{fill("attentionHidden", visibleAttention.hidden)}</p>}
          <details className="attentionLimits"><summary>{tr("attentionCoverage")}</summary><p>{tr("attentionCoverageText")} {tr("attentionLastSource")}: {visibleAttention.sourceUpdatedAt ? new Date(visibleAttention.sourceUpdatedAt).toLocaleString(locale) : tr("attentionUnknown")}.{visibleAttention.timezone && visibleAttention.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` ${tr("attentionTimezone")}: ${visibleAttention.timezone}.` : ""}</p></details>
        </> : <p className="attentionEmpty" role="status">{syncStatus === "offline" ? tr("attentionOffline") : syncStatus !== "synced" ? tr("attentionWaitingSync") : attentionOutdated ? tr("attentionUnavailable") : tr("attentionEvaluating")}</p>}
        {attentionError && <p role="alert" className="attentionError">{attentionError}</p>}
      </section>

      <section className="homeSection homeToday" aria-labelledby="home-today-title">
        <div className="homeSectionHead">
          <h2 id="home-today-title">{tr("Today")}</h2>
          {calendarSources.length > 0 && <span className="homeCapacity">{capacityLabel}{scopeNote}</span>}
          <button type="button" onClick={() => setView("Today")}>{tr("seeAll")} <span aria-hidden="true">→</span></button>
        </div>
        <div className="homeTaskList">
          {homeTodayTasks.map((task) => (
            <article
              key={task.id}
              className={`${draggingId === task.id ? "isDragging" : ""} ${dragTarget === `entity:${task.id}` ? "dropActive" : ""} ${taskDueTone(task, today)}`.trim()}
              data-drop-entity={task.id}
              onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${task.id}`); }}
              onDrop={(event) => acceptNativeDrop(event, `entity:${task.id}`)}
              onClick={() => inspect(task)}
            >
              {!mobileDesignV1Preview && dragHandle(task, "task:Today")}
              {mobileDesignV1Preview ? (
                <LumiCompletionControl className="check" kind="task"
                  tone={taskPreviewCompletionTone(task, today)} complete={false}
                  stateLabel={taskPreviewStateText(taskPreviewCompletionTone(task, today), language)}
                  actionLabel={`${tr("complete")} ${task.title || tr("untitledItem")}`}
                  blockedReason={language === "cs" ? "Zvolte konkrétní prostor a vyčkejte na synchronizaci." : "Select a workspace and finish synchronization."}
                  disabled={activeWorkspaceId === "all" || app.unsent.has(task.id) || app.heldReasons.has(task.id)}
                  onClick={(event) => { event.stopPropagation(); void done(task.id); }} />
              ) : (
                <button type="button" className="check" aria-label={`Complete ${task.title}`}
                  onClick={(event) => { event.stopPropagation(); void done(task.id); }}>○</button>
              )}
              <div><strong>{task.title || tr("untitledItem")}<RecordMarks app={app} entity={task} /></strong><small>{taskDueSummary(task, today, language) || (task.properties.priority && task.properties.priority !== "none" ? tr(String(task.properties.priority)) : tr("Today"))}</small></div>
              {activeWorkspaceId !== "all" && <DeferChip app={app} task={task} />}
            </article>
          ))}
          {homeTodayTasks.length === 0 && homeToday.inAttention > 0 && <p className="attentionEmpty">{tr("homeTodayAllAttention")}</p>}
          {homeTodayTasks.length === 0 && homeToday.inAttention === 0 && <div className="calmEmpty"><span>✓</span><p>{tr("nothingToday")}</p>{!app.captureDisabled && <button onClick={() => openCapture()}>{tr("addTask")}</button>}</div>}
        </div>
        {moreToday > 0 && <button type="button" className="textAction" onClick={() => setView("Today")}>{fill("homeMoreToday", { n: moreToday })} →</button>}
        <CalendarEventNotice app={app} />
        {todayCalendarEvents.length > 0 && <>
          <p className="homeSubhead">{tr("homeFixedEvents")}</p>
          <TodayAgenda app={app} />
        </>}
        {calendarSources.length > 0 && !calendarFresh && <p className="attentionEmpty" role="status">{tr("calendarStale")}</p>}
        {visibleDayPlan ? <div className="homePlan">
          {scopeNote && <p className="attentionMeta">{tr("dayPlanTitle")}{scopeNote}</p>}
          {/* Without any calendar the single quiet line in the footer below says so. */}
          {visibleDayPlan.calendar !== "ready" && (visibleDayPlan.calendar !== "missing" || calendarSources.length > 0) && <p>{tr(visibleDayPlan.calendar === "missing" ? "dayPlanMissing" : visibleDayPlan.calendar === "stale" ? "dayPlanStale" : "dayPlanNonWorkday")}</p>}
          {visibleDayPlan.calendar === "ready" && visibleDayPlan.overloaded && <p role="status" className="dayPlanWarning">{tr("dayPlanOverloaded")} ({visibleDayPlan.requiredMinutes} min)</p>}
          {currentDayPlanBlock && <p><strong>{tr("dayPlanCurrent")}:</strong> {currentDayPlanBlock.title} · {planBlockState(currentDayPlanBlock)}</p>}
          {nextDayPlanBlock && <p><strong>{tr("dayPlanNext")}:</strong> {nextDayPlanBlock.title} · {planBlockState(nextDayPlanBlock)}</p>}
          {proposedBlocks > 0 && <p>{fill("homePlanProposed", { n: proposedBlocks })}</p>}
          {unscheduledTasks > 0 && <p>{unscheduledOutsideToday > 0 ? fill("homePlanUnscheduledExtra", { n: unscheduledTasks, m: unscheduledOutsideToday }) : fill("homePlanUnscheduled", { n: unscheduledTasks })}</p>}
          <button type="button" className="textAction" onClick={() => setView("Today")}>{tr("homePlanOpen")} →</button>
        </div> : dayPlanStatus ? <p className="attentionEmpty" role="status">{dayPlanStatus}</p> : null}
        {calendarSources.length === 0 && <p className="homeNotice homeCalendarNote">{tr("calendarDisconnectedNote")} <button type="button" className="textAction" onClick={() => setView("Calendar")}>{tr("homeConnectCalendar")}</button></p>}
      </section>
    </>
  );
}
