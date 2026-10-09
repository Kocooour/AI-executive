"use client";
import { taskDueTone } from "../../../lib/task-views";
import { attentionReason, taskDueSummary } from "../format";
import type { LumiApp } from "../use-lumi-app";
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
  const inboxCount = sidebarCounts.Inbox;
  const capacityLabel = calendarSources.length === 0 ? tr("calendarDisconnected")
    : calendarFresh ? `${freeHours.toFixed(1)} ${tr("freeHours")}` : tr("capacityUnknown");
  const syncLabel = syncStatus === "synced" ? tr("synced") : syncStatus === "syncing" ? tr("syncing")
    : syncStatus === "offline" ? tr("offline") : tr("connecting");
  const moreToday = (sidebarCounts.Today ?? homeTodayTasks.length) - homeTodayTasks.length;
  const proposedBlocks = visibleDayPlan ? visibleDayPlan.planBlocks.length : 0;
  const unscheduledTasks = visibleDayPlan ? visibleDayPlan.unscheduled.length : 0;
  // Calendar and day plan belong to one workspace; name it when Home shows the read-only aggregate.
  const scopeNote = activeWorkspaceId === "all" && writeWorkspace ? ` (${writeWorkspace.title})` : "";

  return (
    <>
      <ul className="homeStatus" aria-label={tr("homeStatusLabel")}>
        <li>
          <button type="button" onClick={() => setView("Inbox")}><b>{inboxCount}</b> {tr("homeInboxToSort")}</button>
        </li>
        <li><span className={`homeSync ${syncStatus}`} role="status">{tr("homeDataState")}: <b>{syncLabel}</b></span></li>
        <li>
          <button type="button" onClick={() => setView("Calendar")}>{tr("todayCapacity")}{scopeNote}: <b>{capacityLabel}</b></button>
        </li>
      </ul>

      {workSession && <WorkNowCard app={app} />}

      <section className="homeSection attentionSection" aria-labelledby="attention-title">
        <div className="homeSectionHead">
          <span id="attention-title"><span className="sectionDot todayDot" />{tr("attentionTitle")}</span>
          <button type="button" onClick={() => { if (syncStatus === "synced") void loadAttention(activeWorkspaceId).catch((error) => setAttentionError(error instanceof Error ? error.message : tr("attentionUnavailable"))); }} disabled={syncStatus !== "synced"}>
            {tr("refresh")}
          </button>
        </div>
        {visibleAttention ? <>
          {attentionStale
            ? <p className="attentionStale" role="status"><b>{tr("attentionStale")}</b> · {tr(syncStatus === "offline" ? "attentionStaleOffline" : "attentionStaleInfo")} {shortTime(visibleAttention.evaluatedAt, visibleAttention.timezone)}</p>
            : <p className="attentionMeta">{tr("attentionSource")} · {tr("attentionEvaluated")} {shortTime(visibleAttention.evaluatedAt, visibleAttention.timezone)}</p>}
          {visibleAttention.items.length === 0 ? <p className="attentionEmpty">{tr("attentionNone")}</p> : <div className="attentionList">
            {visibleAttention.items.slice(0, showAllAttention ? undefined : 5).map((candidate) => <article key={candidate.attentionKey} className="attentionItem">
              <div className="attentionBody">
                <strong>{candidate.title}</strong>
                <p>{attentionReason(candidate, language)}</p>
                <small>{candidate.subjectType === "task" ? tr("task") : tr("project")} · {workspaceTitle(candidate.workspaceId)} · {candidate.confidence === "limited" ? tr("attentionLimited") : candidate.ruleId === "waiting_follow_up" ? tr("attentionRecordedWaiting") : candidate.ruleId === "planned_date_passed" ? tr("attentionRecordedPlanned") : tr("attentionRecorded")}{!attentionStale && <> · {tr("attentionEvaluated")} {shortTime(candidate.evaluatedAt, candidate.timezone)}</>}{changedSince(candidate) && <> · <b>{tr("attentionChangedSince")}</b></>}</small>
              </div>
              <button type="button" className="attentionOpen" aria-label={`${tr("attentionOpen")}: ${candidate.title}`} onClick={() => {
                const entity = items.find((item) => item.id === candidate.subjectId && item.workspaceId === candidate.workspaceId);
                if (entity) void inspect(entity);
                else setAttentionError(tr("attentionDetailMissing"));
              }}>{tr("attentionOpen")}</button>
              <details className="attentionMore">
                <summary>{tr("attentionMore")}</summary>
                <div className="attentionActions">
                  <button type="button" disabled={Boolean(attentionBusyKey) || attentionActionsBlocked} onClick={() => void actOnAttention(candidate, "snooze")}>{tr("attentionSnooze")}</button>
                  <button type="button" disabled={Boolean(attentionBusyKey) || attentionActionsBlocked} onClick={() => void actOnAttention(candidate, "dismiss")}>{tr("attentionDismiss")}</button>
                </div>
                {attentionActionsBlocked && <p className="attentionMeta">{tr("attentionStaleActions")}</p>}
                <p className="attentionMeta">{tr("attentionSources")} · {tr("attentionRevision")} {candidate.evaluatedDataRevision} · {candidate.timezone}</p>
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
          <span id="home-today-title"><span className="sectionDot todayDot" />{tr("Today")}</span>
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
          {unscheduledTasks > 0 && <p>{fill("homePlanUnscheduled", { n: unscheduledTasks })}</p>}
          <button type="button" className="textAction" onClick={() => setView("Today")}>{tr("homePlanOpen")} →</button>
        </div> : dayPlanStatus ? <p className="attentionEmpty" role="status">{dayPlanStatus}</p> : null}
      </section>
    </>
  );
}
