"use client";
import { taskDueTone } from "../../../lib/task-views";
import { attentionReason, friendlyDate, taskDueSummary } from "../format";
import type { LumiApp } from "../use-lumi-app";

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
    calendarTimezone,
    done,
    dragHandle,
    dragTarget,
    draggingId,
    freeHours,
    freeWindows,
    homeProjects,
    homeRecent,
    homeTodayTasks,
    homeUpcomingTasks,
    inspect,
    items,
    language,
    loadAttention,
    openCapture,
    runBriefing,
    setActiveDragTarget,
    setAttentionError,
    setShowAllAttention,
    setView,
    showAllAttention,
    sources,
    syncStatus,
    tasks,
    today,
    todayCalendarEvents,
    tr,
    view,
    visibleAttention,
    workspaceName,
    writeWorkspace,
  } = app;
  return (
    <>
          {view === "Home" && (
            <>
            <section className="homeSection attentionSection" aria-labelledby="attention-title">
              <div className="homeSectionHead">
                <span id="attention-title"><span className="sectionDot todayDot" />{language === "cs" ? "Vyžaduje pozornost" : "Needs attention"}</span>
                <button type="button" onClick={() => { if (syncStatus === "synced") void loadAttention(activeWorkspaceId).catch((error) => setAttentionError(error instanceof Error ? error.message : "Attention is unavailable")); }} disabled={syncStatus !== "synced"}>
                  {language === "cs" ? "Obnovit" : "Refresh"}
                </button>
              </div>
              {visibleAttention ? <>
                <p className="attentionMeta">{language === "cs" ? "Zdroj: serverová data" : "Source: server data"} · {language === "cs" ? "Vyhodnoceno" : "Evaluated"} {new Date(visibleAttention.evaluatedAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB", { timeZone: visibleAttention.timezone })} · rev. {visibleAttention.dataRevision} · {visibleAttention.timezone}</p>
                {visibleAttention.items.length === 0 ? <p className="attentionEmpty">{language === "cs" ? "Teď žádný viditelný kandidát." : "No visible attention items right now."}</p> : <div className="attentionList">
                  {visibleAttention.items.slice(0, showAllAttention ? undefined : 5).map((candidate) => <article key={candidate.attentionKey} className="attentionItem">
                    <div><strong>{candidate.title}</strong><p>{attentionReason(candidate, language)}</p>
                      <small>{candidate.subjectType === "task" ? tr("task") : tr("project")} · {candidate.workspaceId} · {candidate.confidence === "limited" ? (language === "cs" ? "omezené pokrytí" : "limited coverage") : (language === "cs" ? "zaznamenaný termín" : "recorded deadline")} · {language === "cs" ? "vyhodnoceno" : "evaluated"} {new Date(candidate.evaluatedAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB", { timeZone: candidate.timezone })} · rev. {candidate.evaluatedDataRevision}</small>
                      <details className="attentionSources"><summary>{language === "cs" ? "Zdroje a revize" : "Sources and revisions"}</summary><ul>{candidate.sourceIds.map((id) => <li key={id}><code>{id}</code> · rev. {candidate.sourceRevisions[id]}</li>)}</ul></details>
                    </div>
                    <div className="attentionActions">
                      <button type="button" onClick={() => {
                        const entity = items.find((item) => item.id === candidate.subjectId && item.workspaceId === candidate.workspaceId);
                        if (entity) void inspect(entity);
                        else setAttentionError(language === "cs" ? "Detail není v místních datech; obnovte synchronizaci." : "Detail is not in local data; refresh synchronization.");
                      }}>{language === "cs" ? "Detail" : "Open detail"}</button>
                      <button type="button" disabled={Boolean(attentionBusyKey)} onClick={() => void actOnAttention(candidate, "snooze")}>{language === "cs" ? "Odložit o 24 h" : "Snooze 24h"}</button>
                      <button type="button" disabled={Boolean(attentionBusyKey)} onClick={() => void actOnAttention(candidate, "dismiss")}>{language === "cs" ? "Skrýt" : "Dismiss"}</button>
                    </div>
                  </article>)}
                </div>}
                {visibleAttention.items.length > 5 && <button className="textAction" type="button" onClick={() => setShowAllAttention((current) => !current)}>{showAllAttention ? (language === "cs" ? "Zobrazit méně" : "Show fewer") : (language === "cs" ? `Zobrazit dalších ${visibleAttention.items.length - 5}` : `Show ${visibleAttention.items.length - 5} more`)}</button>}
                {(visibleAttention.hidden.snoozed > 0 || visibleAttention.hidden.dismissed > 0) && <p className="attentionMeta">{language === "cs" ? `Odloženo: ${visibleAttention.hidden.snoozed} · skryto: ${visibleAttention.hidden.dismissed}` : `Snoozed: ${visibleAttention.hidden.snoozed} · dismissed: ${visibleAttention.hidden.dismissed}`}</p>}
                <details className="attentionLimits"><summary>{language === "cs" ? "Pokrytí a čerstvost" : "Coverage and freshness"}</summary><p>{language === "cs" ? "Vyhodnocujeme termíny a aktivitu projektů z uložených projektů, úkolů a potvrzeného kontextu. Čekající návaznosti, kalendářní konflikty a kapacitu zatím nevyhodnocujeme. Historie smazaných úkolů a externí aktivita nejsou zahrnuty." : "We evaluate deadlines and project activity from stored projects, tasks, and confirmed context. Waiting follow-ups, calendar conflicts, and capacity are not evaluated yet. Deleted task history and external activity are not included."} {language === "cs" ? "Poslední změna dat" : "Last source update"}: {visibleAttention.sourceUpdatedAt ? new Date(visibleAttention.sourceUpdatedAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB") : (language === "cs" ? "neznámá" : "unknown")}.</p></details>
              </> : <p className="attentionEmpty" role="status">{syncStatus === "offline" ? (language === "cs" ? "Pozornost není dostupná offline." : "Attention is unavailable offline.") : syncStatus !== "synced" ? (language === "cs" ? "Čeká na synchronizaci…" : "Waiting for synchronization…") : (language === "cs" ? "Vyhodnocuji…" : "Evaluating…")}</p>}
              {attentionError && <p role="alert" className="attentionError">{attentionError}</p>}
            </section>
            <div className="homeOverview">
              <section className="homeSection homePrimary">
                <div className="homeSectionHead">
                  <span><span className="sectionDot todayDot" />{tr("Today")}</span>
                  <button onClick={() => setView("Today")}>{tr("seeAll")} <span aria-hidden="true">→</span></button>
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
              </section>
              <div className="homeSide">
                <section className="homeSection">
                  <div className="homeSectionHead"><span><span className="sectionDot inboxDot" />{tr("Inbox")}</span><b>{tasks.filter((task) => task.status === "open" && task.properties.inbox === true).length}</b></div>
                  <p>{tr("inboxDescription")}</p>
                  <button className="textAction" onClick={() => setView("Inbox")}>{tr("openInbox")} →</button>
                </section>
                <section className="homeSection">
                  <div className="homeSectionHead"><span><span className="sectionDot projectDot" />{tr("Projects")}</span><button onClick={() => setView("Projects")}>{tr("seeAll")} →</button></div>
                  <div className="homeCompactList">
                    {homeProjects.map((project) => <article key={project.id} className={`homeCompactRow ${dragTarget === `entity:${project.id}` ? "dropActive" : ""}`}
                      data-drop-entity={project.id}
                      onDragOver={(event) => { event.preventDefault(); setActiveDragTarget(`entity:${project.id}`); }}
                      onDrop={(event) => acceptNativeDrop(event, `entity:${project.id}`)}>
                      {dragHandle(project, "project:all")}<button
                      onClick={() => inspect(project)}
                    ><span>{project.title}</span><small>{tasks.filter((task) => task.status === "open" && sources(project.id, "belongs_to_project").includes(task.id)).length} {tr("openCount")}</small></button></article>)}
                    {homeProjects.length === 0 && <p>{tr("noProjects")}</p>}
                  </div>
                </section>
              </div>
              <section className="homeSection">
                <div className="homeSectionHead"><span><span className="sectionDot upcomingDot" />{tr("Upcoming")}</span><button onClick={() => setView("Upcoming")}>{tr("seeAll")} →</button></div>
                <div className="homeCompactList">
                  {homeUpcomingTasks.map((task) => <button key={task.id} onClick={() => inspect(task)}><span>{task.title}</span><small>{friendlyDate(task.properties.when, language)}</small></button>)}
                  {homeUpcomingTasks.length === 0 && <p>{tr("noUpcoming")}</p>}
                </div>
              </section>
              <section className="homeSection">
                <div className="homeSectionHead"><span><span className="sectionDot recentDot" />{tr("recent")}</span></div>
                <div className="homeCompactList">
                  {homeRecent.map((entity) => <button key={entity.id} onClick={() => inspect(entity)}><span>{entity.title}</span><small>{tr(entity.type)}</small></button>)}
                </div>
              </section>
            </div>
            <div className="homeInsights">
            <section className="briefingCard">
              <div className="sectionHeading">
                <div>
                  <p className="eyebrow">PROACTIVE EXECUTIVE</p>
                  <h2>{briefings[0]?.title || tr("dailyBrief")}</h2>
                </div>
                <div className="notificationActions">
                  <button onClick={() => runBriefing("morning")} disabled={briefingBusy}>{tr("morningBrief")}</button>
                  <button onClick={() => runBriefing("evening")} disabled={briefingBusy}>{tr("eveningReview")}</button>
                </div>
              </div>
              {briefings[0] ? (
                <div>
                  {briefings[0].kind === "evening" && briefings[0].planReview ? <p>
                    <strong>{tr("dayPlanReviewCounts")}:</strong> {briefings[0].planReview.planned} {tr("dayPlanReviewPlanned")},
                    {" "}{briefings[0].planReview.completed} {tr("dayPlanReviewCompleted")},
                    {" "}{briefings[0].planReview.open} {tr("dayPlanReviewOpen")},
                    {" "}{briefings[0].planReview.moved} {tr("dayPlanReviewMoved")},
                    {" "}{briefings[0].planReview.dismissed} {tr("dayPlanReviewDismissed")}.
                    {briefings[0].planReview.measuredSessions > 0 && <> {language === "cs" ? "Změřeno" : "Measured"}: {briefings[0].planReview.measuredMinutes} min{briefings[0].planReview.estimatedMinutes > 0 ? ` / ${briefings[0].planReview.estimatedMinutes} min` : ""}.</>}
                    {briefings[0].planReview.nextWorkday && <> {tr("dayPlanReviewNextWorkday")}: {briefings[0].planReview.nextWorkday}.</>}
                  </p> : <p>{briefings[0].summary}</p>}
                  {briefings[0].overloaded && <p role="status"><strong>{tr("capacityExceeded")}</strong> {tr("capacityEstimate")}</p>}
                  <ol className="briefingTasks">
                    {briefings[0].topTasks.map((task) => (
                      <li key={task.id}>
                        <button onClick={() => {
                          const entity = items.find((item) => item.id === task.id);
                          if (entity) inspect(entity);
                        }}>{task.title}</button>
                        <small>{task.reason}</small>
                      </li>
                    ))}
                  </ol>
                  <ul>{briefings[0].suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>
                  <small>{new Date(briefings[0].createdAt).toLocaleString()} · {briefings[0].workspaceName}</small>
                </div>
              ) : <p>{tr("firstBrief")}</p>}
            </section>
            <section className="briefingCard calendarCard">
              <div className="sectionHeading">
                <div>
                  <p className="eyebrow">{tr("calendarReadonly").toUpperCase()} · {activeWorkspaceId === "all" ? writeWorkspace?.title || "PERSONAL" : workspaceName}</p>
                  <h2>{tr("todayCapacity")}</h2>
                </div>
                <strong>{calendarSources.length === 0 ? tr("calendarDisconnected") : calendarFresh ? `${freeHours.toFixed(1)} ${tr("freeHours")}` : tr("capacityUnknown")}</strong>
              </div>
              {calendarSources.length > 0 && !calendarFresh && (
                <p role="status">{tr("calendarStale")}</p>
              )}
              {calendarFresh && todayCalendarEvents.length === 0 && <p>{tr("noBlockingEvent")}</p>}
              <div className="calendarAgenda">
                {todayCalendarEvents.map((event) => (
                  <div key={event.id} className={event.busy ? "busy" : "free"}>
                    <span>{event.allDay ? tr("allDay") : new Date(event.start).toLocaleTimeString(language === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}</span>
                    <strong>{event.title}</strong>
                    <small>{event.busy ? tr("busy") : tr("freeTime")}</small>
                  </div>
                ))}
              </div>
              {calendarFresh && freeWindows.length > 0 && (
                <p>
                  <strong>{tr("nearestFree")}</strong>{" "}
                  {freeWindows.slice(0, 3).map((window) => `${new Date(window[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}–${new Date(window[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}`).join(", ")}
                </p>
              )}
              <small>{tr("readOnlyEvents")}</small>
            </section>
            </div>
            </>
          )}
    </>
  );
}
