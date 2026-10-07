"use client";
import { taskDueTone } from "../../../lib/task-views";
import { attentionReason, taskDueSummary } from "../format";
import type { LumiApp } from "../use-lumi-app";
import { TodayAgenda } from "./today-agenda";
import { WorkNowCard } from "./work-now-card";

// Home is the daily brief: a status line, at most five attention items, and today.
// Working lists (projects, upcoming, recent) live in their own views.
export function HomeView({ app }: { app: LumiApp }) {
  const {
    acceptNativeDrop,
    actOnAttention,
    activeWorkspaceId,
    attentionBusyKey,
    attentionError,
    briefingBusy,
    briefings,
    calendarFresh,
    calendarSources,
    currentDayPlanBlock,
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
    runBriefing,
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

  const inboxCount = sidebarCounts.Inbox;
  const capacityLabel = calendarSources.length === 0 ? tr("calendarDisconnected")
    : calendarFresh ? `${freeHours.toFixed(1)} ${tr("freeHours")}` : tr("capacityUnknown");
  const syncLabel = syncStatus === "synced" ? tr("synced") : syncStatus === "syncing" ? tr("syncing")
    : syncStatus === "offline" ? tr("offline") : tr("connecting");
  const moreToday = (sidebarCounts.Today ?? homeTodayTasks.length) - homeTodayTasks.length;
  const pendingPlanItems = visibleDayPlan ? visibleDayPlan.planBlocks.length + visibleDayPlan.unscheduled.length : 0;
  const latestBrief = briefings[0];

  return (
    <>
      <ul className="homeStatus" aria-label={tr("homeStatusLabel")}>
        <li>
          <button type="button" onClick={() => setView("Inbox")}><b>{inboxCount}</b> {tr("homeInboxToSort")}</button>
        </li>
        <li>
          <button type="button" onClick={() => setView("Calendar")}>{tr("todayCapacity")}: <b>{capacityLabel}</b></button>
        </li>
        <li className={`homeSync ${syncStatus}`} role="status">{tr("homeDataState")}: <b>{syncLabel}</b></li>
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
          <p className="attentionMeta">{tr("attentionSource")} · {tr("attentionEvaluated")} {shortTime(visibleAttention.evaluatedAt, visibleAttention.timezone)}</p>
          {visibleAttention.items.length === 0 ? <p className="attentionEmpty">{tr("attentionNone")}</p> : <div className="attentionList">
            {visibleAttention.items.slice(0, showAllAttention ? undefined : 5).map((candidate) => <article key={candidate.attentionKey} className="attentionItem">
              <div className="attentionBody">
                <strong>{candidate.title}</strong>
                <p>{attentionReason(candidate, language)}</p>
                <small>{candidate.subjectType === "task" ? tr("task") : tr("project")} · {workspaceTitle(candidate.workspaceId)} · {candidate.confidence === "limited" ? tr("attentionLimited") : tr("attentionRecorded")} · {tr("attentionEvaluated")} {shortTime(candidate.evaluatedAt, candidate.timezone)}</small>
              </div>
              <button type="button" className="attentionOpen" onClick={() => {
                const entity = items.find((item) => item.id === candidate.subjectId && item.workspaceId === candidate.workspaceId);
                if (entity) void inspect(entity);
                else setAttentionError(tr("attentionDetailMissing"));
              }}>{tr("attentionOpen")}</button>
              <details className="attentionMore">
                <summary>{tr("attentionMore")}</summary>
                <div className="attentionActions">
                  <button type="button" disabled={Boolean(attentionBusyKey)} onClick={() => void actOnAttention(candidate, "snooze")}>{tr("attentionSnooze")}</button>
                  <button type="button" disabled={Boolean(attentionBusyKey)} onClick={() => void actOnAttention(candidate, "dismiss")}>{tr("attentionDismiss")}</button>
                </div>
                <p className="attentionMeta">{tr("attentionSources")} · {tr("attentionRevision")} {candidate.evaluatedDataRevision} · {candidate.timezone}</p>
                <ul className="attentionSources">{candidate.sourceIds.map((id) => <li key={id}><code>{id}</code> · rev. {candidate.sourceRevisions[id]}</li>)}</ul>
              </details>
            </article>)}
          </div>}
          {visibleAttention.items.length > 5 && <button className="textAction" type="button" onClick={() => setShowAllAttention((current) => !current)}>{showAllAttention ? tr("attentionShowFewer") : fill("attentionShowMore", { n: visibleAttention.items.length - 5 })}</button>}
          {(visibleAttention.hidden.snoozed > 0 || visibleAttention.hidden.dismissed > 0) && <p className="attentionMeta">{fill("attentionHidden", visibleAttention.hidden)}</p>}
          <details className="attentionLimits"><summary>{tr("attentionCoverage")}</summary><p>{tr("attentionCoverageText")} {tr("attentionLastSource")}: {visibleAttention.sourceUpdatedAt ? new Date(visibleAttention.sourceUpdatedAt).toLocaleString(locale) : tr("attentionUnknown")}. {tr("attentionRevision")} {visibleAttention.dataRevision} · {visibleAttention.timezone}.</p></details>
        </> : <p className="attentionEmpty" role="status">{syncStatus === "offline" ? tr("attentionOffline") : syncStatus !== "synced" ? tr("attentionWaitingSync") : tr("attentionEvaluating")}</p>}
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
              <div><strong>{task.title}</strong><small>{taskDueSummary(task, today, language) || (task.properties.priority && task.properties.priority !== "none" ? tr(String(task.properties.priority)) : tr("Today"))}</small></div>
            </article>
          ))}
          {homeTodayTasks.length === 0 && <div className="calmEmpty"><span>✓</span><p>{tr("nothingToday")}</p><button onClick={() => openCapture()}>{tr("addTask")}</button></div>}
        </div>
        {moreToday > 0 && <button type="button" className="textAction" onClick={() => setView("Today")}>{fill("homeMoreToday", { n: moreToday })} →</button>}
        {todayCalendarEvents.length > 0 && <>
          <h3 className="homeSubhead">{tr("homeFixedEvents")}</h3>
          <TodayAgenda app={app} />
        </>}
        {calendarSources.length > 0 && !calendarFresh && <p className="attentionEmpty" role="status">{tr("calendarStale")}</p>}
        {visibleDayPlan && (currentDayPlanBlock || nextDayPlanBlock || pendingPlanItems > 0) && <div className="homePlan">
          {currentDayPlanBlock && <p><strong>{tr("dayPlanCurrent")}:</strong> {currentDayPlanBlock.title} · {planBlockState(currentDayPlanBlock)}</p>}
          {nextDayPlanBlock && <p><strong>{tr("dayPlanNext")}:</strong> {nextDayPlanBlock.title} · {planBlockState(nextDayPlanBlock)}</p>}
          {pendingPlanItems > 0 && <p>{fill("homePlanPending", { n: pendingPlanItems })}</p>}
          <button type="button" className="textAction" onClick={() => setView("Today")}>{tr("homePlanOpen")} →</button>
        </div>}
      </section>

      <details className="homeSection homeBrief">
        <summary>
          <span><span className="sectionDot recentDot" />{tr("dailyBrief")}</span>
          <small>{latestBrief ? `${latestBrief.title} · ${shortTime(latestBrief.createdAt)}` : tr("homeBriefNone")}</small>
        </summary>
        <div className="notificationActions">
          <button onClick={() => runBriefing("morning")} disabled={briefingBusy}>{tr("morningBrief")}</button>
          <button onClick={() => runBriefing("evening")} disabled={briefingBusy}>{tr("eveningReview")}</button>
        </div>
        {latestBrief ? (
          <div>
            {latestBrief.kind === "evening" && latestBrief.planReview ? <p>
              <strong>{tr("dayPlanReviewCounts")}:</strong> {latestBrief.planReview.planned} {tr("dayPlanReviewPlanned")},
              {" "}{latestBrief.planReview.completed} {tr("dayPlanReviewCompleted")},
              {" "}{latestBrief.planReview.open} {tr("dayPlanReviewOpen")},
              {" "}{latestBrief.planReview.moved} {tr("dayPlanReviewMoved")},
              {" "}{latestBrief.planReview.dismissed} {tr("dayPlanReviewDismissed")}.
              {latestBrief.planReview.measuredSessions > 0 && <> {language === "cs" ? "Změřeno" : "Measured"}: {latestBrief.planReview.measuredMinutes} min{latestBrief.planReview.estimatedMinutes > 0 ? ` / ${latestBrief.planReview.estimatedMinutes} min` : ""}.</>}
              {latestBrief.planReview.nextWorkday && <> {tr("dayPlanReviewNextWorkday")}: {latestBrief.planReview.nextWorkday}.</>}
            </p> : <p>{latestBrief.summary}</p>}
            {latestBrief.overloaded && <p role="status"><strong>{tr("capacityExceeded")}</strong> {tr("capacityEstimate")}</p>}
            <ol className="briefingTasks">
              {latestBrief.topTasks.map((task) => (
                <li key={task.id}>
                  <button onClick={() => {
                    const entity = items.find((item) => item.id === task.id);
                    if (entity) inspect(entity);
                  }}>{task.title}</button>
                  <small>{task.reason}</small>
                </li>
              ))}
            </ol>
            <ul>{latestBrief.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>
            <small>{new Date(latestBrief.createdAt).toLocaleString()} · {latestBrief.workspaceName}</small>
          </div>
        ) : <p>{tr("firstBrief")}</p>}
      </details>
    </>
  );
}
