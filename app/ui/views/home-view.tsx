"use client";
import { useEffect, useState } from "react";
import { taskDueTone, taskMatchesView } from "../../../lib/task-views";
import { attentionReason, taskDueSummary } from "../format";
import { taskRowValue } from "../task-row-value";
import type { LumiApp } from "../use-lumi-app";
import { DeferChip } from "./defer-popover";
import { RecordMarks } from "./held-back";
import { TodayAgenda } from "./today-agenda";
import { WorkNowCard } from "./work-now-card";

// Home is the brief of the current state: a status line, at most five attention items, and today.
// Working lists (projects, upcoming, recent) live in their own views.
export function HomeView({ app }: { app: LumiApp }) {
  const {
    acceptNativeDrop,
    actOnAttention,
    activeWorkspaceId,
    attentionBusyKey,
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
    sidebarCounts,
    syncStatus,
    today,
    todayCalendarEvents,
    tr,
    view,
    visibleAttention,
    visibleDayPlan,
    workSession,
    workspaces,
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
  const workspaceTitle = (workspaceId: string) =>
    workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.title || workspaceId;
  const planBlockState = (block: { existing?: boolean; planningSource?: string }) =>
    tr(block.existing ? block.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed");

  // A row evaluated before the user edited its subject on this device may no longer hold.
  const changedSince = (candidate: { subjectId: string; workspaceId: string; evaluatedAt: number }) => {
    if (!attentionActionsBlocked) return false;
    const local = items.find((item) => item.id === candidate.subjectId && item.workspaceId === candidate.workspaceId);
    return Boolean(local && Number(local.updatedAt) > candidate.evaluatedAt);
  };
  const capacityLabel = calendarSources.length === 0 ? tr("calendarDisconnected")
    : calendarFresh ? `${freeHours.toLocaleString(locale, { maximumFractionDigits: 1 })} ${tr("freeHours")}` : tr("capacityUnknown");
  const syncLabel = syncStatus === "synced" ? tr("synced") : syncStatus === "syncing" ? tr("syncing")
    : syncStatus === "offline" ? tr("offline") : tr("connecting");
  const moreToday = (sidebarCounts.Today ?? homeTodayTasks.length) - homeTodayTasks.length;
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

  // The snoozed or dismissed item leaves the list; keyboard focus moves to the item now in its place
  // (or the one before it, or the section heading) instead of falling back to the page.
  async function actAndKeepFocus(button: HTMLElement, candidate: Parameters<typeof actOnAttention>[0], action: "snooze" | "dismiss") {
    const items = Array.from(document.querySelectorAll<HTMLElement>(".attentionSection .attentionItem"));
    const index = items.indexOf(button.closest(".attentionItem") as HTMLElement);
    await actOnAttention(candidate, action);
    // Let React remove the item first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (document.activeElement && document.activeElement !== document.body && document.contains(document.activeElement)) return;
    const opens = document.querySelectorAll<HTMLElement>(".attentionSection .attentionItem .attentionOpen");
    const target = opens[Math.min(Math.max(index, 0), opens.length - 1)] ?? document.getElementById("attention-title");
    target?.focus();
  }

  return (
    <>
      {/* Only states that need something are shown; the Inbox count is in the navigation. */}
      <div role="status" className="homeNoticeLive">{showSync && <p className={`homeNotice homeSync ${syncStatus}`}><span className={`homeNoticeDot ${syncStatus === "offline" ? "danger" : ""}`} aria-hidden="true" />{tr("homeDataState")}: <b>{syncLabel}</b></p>}</div>
      {calendarSources.length === 0 && <p className="homeNotice"><span className="homeNoticeDot muted" aria-hidden="true" />{tr("calendarDisconnected")} · <button type="button" className="textAction" onClick={() => setView("Calendar")}>{tr("homeConnectCalendar")}</button></p>}

      {workSession && <WorkNowCard app={app} />}

      <section className="homeSection attentionSection" aria-labelledby="attention-title">
        <div className="homeSectionHead">
          <h2 id="attention-title" tabIndex={-1}>{tr("attentionTitle")}</h2>
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
            {visibleAttention.items.slice(0, showAllAttention ? undefined : 5).map((candidate) => <article key={candidate.attentionKey} className="attentionItem">
              <div className="attentionBody">
                <strong>{candidate.title}</strong>
                {/* One line: why, from what, when evaluated (docs/UX-UI.md asks all three on every card). */}
                <p className="attentionWhy"><span className="attentionReason">{attentionReason(candidate, language).replace(/\.$/, "")}</span> · {candidate.confidence === "limited" ? tr("attentionLimited") : candidate.ruleId === "waiting_follow_up" ? tr("attentionRecordedWaiting") : candidate.ruleId === "planned_date_passed" ? tr("attentionRecordedPlanned") : tr("attentionRecorded")}{activeWorkspaceId === "all" && <> · {workspaceTitle(candidate.workspaceId)}</>} · <span className="attentionTime">{tr("attentionEvaluated")} {shortTime(candidate.evaluatedAt, candidate.timezone)}</span>{changedSince(candidate) && <> · <b>{tr("attentionChangedSince")}</b></>}</p>
              </div>
              <div className="attentionActions">
                <button type="button" aria-label={`${tr("attentionSnooze")}: ${candidate.title}`} disabled={Boolean(attentionBusyKey) || attentionActionsBlocked} onClick={(event) => void actAndKeepFocus(event.currentTarget, candidate, "snooze")}>{tr("attentionSnooze")}</button>
                <button type="button" aria-label={`${tr("attentionDismiss")}: ${candidate.title}`} disabled={Boolean(attentionBusyKey) || attentionActionsBlocked} onClick={(event) => void actAndKeepFocus(event.currentTarget, candidate, "dismiss")}>{tr("attentionDismiss")}</button>
              </div>
              <button type="button" className="attentionOpen" aria-label={`${tr("attentionOpen")}: ${candidate.title}`} onClick={() => {
                const entity = items.find((item) => item.id === candidate.subjectId && item.workspaceId === candidate.workspaceId);
                if (entity) void inspect(entity);
                else setAttentionError(tr("attentionDetailMissing"));
              }}>{tr("attentionOpen")}</button>
              <details className="attentionMore">
                <summary>{tr("attentionSourceDetails")}</summary>
                <p className="attentionMeta">{candidate.subjectType === "task" ? tr("task") : tr("project")} · {workspaceTitle(candidate.workspaceId)} · {tr("attentionRevision")} {candidate.evaluatedDataRevision} · {candidate.timezone}</p>
                <ul className="attentionSources">{candidate.sourceIds.map((id) => <li key={id}><code>{id}</code> · rev. {candidate.sourceRevisions[id]}</li>)}</ul>
              </details>
            </article>)}
          </div>}
          {visibleAttention.items.length > 5 && <button className="textAction" type="button" onClick={() => setShowAllAttention((current) => !current)}>{showAllAttention ? tr("attentionShowFewer") : fill("attentionShowMore", { n: visibleAttention.items.length - 5 })}</button>}
          {(visibleAttention.hidden.snoozed > 0 || visibleAttention.hidden.dismissed > 0) && <p className="attentionMeta">{fill("attentionHidden", visibleAttention.hidden)}</p>}
          <details className="attentionLimits"><summary>{tr("attentionCoverage")}</summary><p>{tr("attentionCoverageText")} {tr("attentionLastSource")}: {visibleAttention.sourceUpdatedAt ? new Date(visibleAttention.sourceUpdatedAt).toLocaleString(locale) : tr("attentionUnknown")}. {tr("attentionRevision")} {visibleAttention.dataRevision} · {visibleAttention.timezone}.</p></details>
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
              {dragHandle(task, "task:Today")}
              <button className="check" aria-label={`Complete ${task.title}`} onClick={(event) => { event.stopPropagation(); done(task.id); }}>○</button>
              <div><strong>{task.title || tr("untitledItem")}<RecordMarks app={app} entity={task} /></strong><small>{taskDueSummary(task, today, language) || (task.properties.priority && task.properties.priority !== "none" ? tr(String(task.properties.priority)) : tr("Today"))}</small></div>
              {activeWorkspaceId !== "all" && <DeferChip app={app} task={task} meta={taskRowValue(task, language, today, { held: false, unsent: false, openTaskCount: 0 })} />}
            </article>
          ))}
          {homeTodayTasks.length === 0 && <div className="calmEmpty"><span>✓</span><p>{tr("nothingToday")}</p><button onClick={() => openCapture()}>{tr("addTask")}</button></div>}
        </div>
        {moreToday > 0 && <button type="button" className="textAction" onClick={() => setView("Today")}>{fill("homeMoreToday", { n: moreToday })} →</button>}
        {todayCalendarEvents.length > 0 && <>
          <p className="homeSubhead">{tr("homeFixedEvents")}</p>
          <TodayAgenda app={app} />
        </>}
        {calendarSources.length > 0 && !calendarFresh && <p className="attentionEmpty" role="status">{tr("calendarStale")}</p>}
        {visibleDayPlan ? <div className="homePlan">
          {scopeNote && <p className="attentionMeta">{tr("dayPlanTitle")}{scopeNote}</p>}
          {visibleDayPlan.calendar !== "ready" && <p>{tr(visibleDayPlan.calendar === "missing" ? "dayPlanMissing" : visibleDayPlan.calendar === "stale" ? "dayPlanStale" : "dayPlanNonWorkday")}</p>}
          {visibleDayPlan.calendar === "ready" && visibleDayPlan.overloaded && <p role="status" className="dayPlanWarning">{tr("dayPlanOverloaded")} ({visibleDayPlan.requiredMinutes} min)</p>}
          {currentDayPlanBlock && <p><strong>{tr("dayPlanCurrent")}:</strong> {currentDayPlanBlock.title} · {planBlockState(currentDayPlanBlock)}</p>}
          {nextDayPlanBlock && <p><strong>{tr("dayPlanNext")}:</strong> {nextDayPlanBlock.title} · {planBlockState(nextDayPlanBlock)}</p>}
          {proposedBlocks > 0 && <p>{fill("homePlanProposed", { n: proposedBlocks })}</p>}
          {unscheduledTasks > 0 && <p>{unscheduledOutsideToday > 0 ? fill("homePlanUnscheduledExtra", { n: unscheduledTasks, m: unscheduledOutsideToday }) : fill("homePlanUnscheduled", { n: unscheduledTasks })}</p>}
          <button type="button" className="textAction" onClick={() => setView("Today")}>{tr("homePlanOpen")} →</button>
        </div> : dayPlanStatus ? <p className="attentionEmpty" role="status">{dayPlanStatus}</p> : null}
      </section>
    </>
  );
}
