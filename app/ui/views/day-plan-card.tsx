"use client";
import type { LumiApp } from "../use-lumi-app";

export function DayPlanCard({ app }: { app: LumiApp }) {
  const {
    applyDayPlanAction,
    calendarToday,
    calendarWorkspaceSelection,
    currentDayPlanBlock,
    dayPlanBusy,
    dayPlanStatus,
    dayPlanTimeline,
    dayPlanUndo,
    dayPlanWhy,
    inspect,
    items,
    language,
    loadDayPlan,
    nextDayPlanBlock,
    setDayPlanNow,
    setDayPlanStatus,
    tr,
    undoDayPlanBlock,
    visibleDayPlan,
    workSession,
    workSessionAction,
    workSessionBusy,
  } = app;
  // Preserve time ordering inside each group, but never mix accepted plans with
  // proposals that still require confirmation (LUMI-UX-012).
  const planGroups = [
    { key: "fixed", label: "dayPlanGroupFixed", blocks: dayPlanTimeline.filter((item) => item.existing && item.planningSource !== "albert-day-plan") },
    { key: "approved", label: "dayPlanGroupApproved", blocks: dayPlanTimeline.filter((item) => item.existing && item.planningSource === "albert-day-plan") },
    { key: "suggested", label: "dayPlanGroupSuggested", blocks: dayPlanTimeline.filter((item) => !item.existing) },
  ].filter((group) => group.blocks.length > 0);
  return (
            <section className="dayPlanCard" aria-labelledby="day-plan-title">
              <div className="sectionHeading">
                <div><p className="eyebrow">LUMI</p><h2 id="day-plan-title">{tr("dayPlanTitle")}</h2></div>
                <div className="dayPlanActions">
                  {visibleDayPlan?.calendar === "ready" && <strong>{Math.floor((visibleDayPlan.freeMinutes || 0) / 60)} h {(visibleDayPlan.freeMinutes || 0) % 60} min</strong>}
                  <button disabled={dayPlanBusy} onClick={() => loadDayPlan(calendarWorkspaceSelection.current, calendarToday)
                    .then(() => { setDayPlanNow(Date.now()); setDayPlanStatus(tr("dayPlanRefreshed")); })
                    .catch((error) => setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged")))}>{tr("dayPlanRefresh")}</button>
                </div>
              </div>
              {dayPlanStatus && <p role="status">{dayPlanStatus}</p>}
              {visibleDayPlan ? <>
                <p>{tr(visibleDayPlan.calendar === "ready" ? "dayPlanReady" : visibleDayPlan.calendar === "missing" ? "dayPlanMissing" : visibleDayPlan.calendar === "stale" ? "dayPlanStale" : "dayPlanNonWorkday")}</p>
                {visibleDayPlan.overloaded && <p role="status" className="dayPlanWarning">{tr("dayPlanOverloaded")} ({visibleDayPlan.requiredMinutes} min)</p>}
                {currentDayPlanBlock && <p><strong>{tr("dayPlanCurrent")}:</strong> {currentDayPlanBlock.title} · {tr(currentDayPlanBlock.existing ? currentDayPlanBlock.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed")}</p>}
                {nextDayPlanBlock && <p><strong>{tr("dayPlanNext")}:</strong> {nextDayPlanBlock.title} · {tr(nextDayPlanBlock.existing ? nextDayPlanBlock.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed")}</p>}
                {dayPlanUndo?.workspaceId === visibleDayPlan.workspaceId && dayPlanUndo.date === visibleDayPlan.date && <button disabled={dayPlanBusy} onClick={undoDayPlanBlock}>{tr("dayPlanUndo")}</button>}
                {visibleDayPlan.existingBlocks.length + visibleDayPlan.planBlocks.length + visibleDayPlan.unscheduled.length === 0 && <p>{tr("dayPlanEmpty")}</p>}
                <div className="dayPlanTimeline">
                  {planGroups.map((group) => (
                    <section key={group.key} className="dayPlanGroup" data-plan-group={group.key} aria-label={tr(group.label)}>
                      <div className="dayPlanGroupHeader"><h3>{tr(group.label)}</h3><span aria-hidden="true">{group.blocks.length}</span></div>
                      <div className="dayPlanGroupItems">
                        {group.blocks.map((item) => (
                    <article className={`dayPlanBlock ${item.existing ? "existing" : "proposed"}`} key={`${item.taskId}:${item.start}`}>
                      <time>{new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { timeZone: visibleDayPlan.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(item.start!))}–{new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { timeZone: visibleDayPlan.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(item.end!))}</time>
                      <div><strong>{item.title}</strong><small>{tr(item.existing ? item.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed")} · {tr(`dayPlanReason${item.reason[0].toUpperCase()}${item.reason.slice(1)}`)} · {item.estimatedMinutes} min · {tr(item.estimateSource === "actual" ? "dayPlanActualEstimate" : item.estimateSource === "learned" ? "dayPlanLearnedEstimate" : item.estimateSource === "explicit" ? "dayPlanExplicitEstimate" : "dayPlanDefaultEstimate")}{item.estimateSource === "learned" || item.estimateSource === "actual" ? ` (${item.estimateSamples})` : ""}{item.preferredMinute !== null && item.preferredMinute !== undefined ? ` · ${tr("dayPlanPreferredTime")} (${item.timeSamples})` : ""}</small>{item.whyNow?.length > 0 && <details className="whyNow"><summary>{tr("whyNow")}</summary><ul>{item.whyNow.map((reason) => <li key={reason}>{dayPlanWhy(reason)}</li>)}</ul></details>}
                        <div className="dayPlanActions">
                          {!workSession && <button disabled={workSessionBusy} onClick={() => { const task = items.find((candidate) => candidate.id === item.taskId); if (task) workSessionAction("start", task); }}>{tr("workStart")}</button>}
                        {!item.existing && <>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "accepted")}>{tr("acceptBlock")}</button>
                          <button disabled={dayPlanBusy} onClick={() => { const task = items.find((candidate) => candidate.id === item.taskId); if (task) inspect(task); }}>{tr("anotherTime")}</button>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "tomorrow")}>{tr("moveTomorrow")}</button>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "dismissed")}>{tr("skipPlanning")}</button>
                        </>}
                        </div>
                      </div>
                    </article>
                        ))}
                      </div>
                    </section>
                  ))}
                  {visibleDayPlan.unscheduled.length > 0 && <section className="dayPlanGroup" data-plan-group="unscheduled" aria-label={tr("dayPlanGroupUnscheduled")}>
                    <div className="dayPlanGroupHeader"><h3>{tr("dayPlanGroupUnscheduled")}</h3><span aria-hidden="true">{visibleDayPlan.unscheduled.length}</span></div>
                    <div className="dayPlanGroupItems">
                  {visibleDayPlan.unscheduled.map((item) => (
                    <article className="dayPlanBlock unscheduled" key={item.taskId}>
                      <span>{tr("dayPlanUnscheduled")}</span>
                      <div><strong>{item.title}</strong><small>{tr(`dayPlanReason${item.reason[0].toUpperCase()}${item.reason.slice(1)}`)} · {item.estimatedMinutes} min · {tr(item.estimateSource === "actual" ? "dayPlanActualEstimate" : item.estimateSource === "learned" ? "dayPlanLearnedEstimate" : item.estimateSource === "explicit" ? "dayPlanExplicitEstimate" : "dayPlanDefaultEstimate")}</small>{item.whyNow?.length > 0 && <details className="whyNow"><summary>{tr("whyNow")}</summary><ul>{item.whyNow.map((reason) => <li key={reason}>{dayPlanWhy(reason)}</li>)}</ul></details>}
                        <div className="dayPlanActions">
                          <button disabled={dayPlanBusy} onClick={() => { const task = items.find((candidate) => candidate.id === item.taskId); if (task) inspect(task); }}>{tr("anotherTime")}</button>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "tomorrow")}>{tr("moveTomorrow")}</button>
                          <button disabled={dayPlanBusy} onClick={() => applyDayPlanAction(item, "dismissed")}>{tr("skipPlanning")}</button>
                        </div>
                      </div>
                    </article>
                  ))}
                    </div>
                  </section>}
                </div>
              </> : !dayPlanStatus && <p>{tr("checking")}</p>}
            </section>
  );
}
