"use client";
import type { LumiApp } from "../use-lumi-app";

export function WorkNowCard({ app }: { app: LumiApp }) {
  const {
    activeWorkspaceId,
    calendarToday,
    dayPlanBusy,
    loadDayPlan,
    setDayPlanStatus,
    tr,
    view,
    workElapsedText,
    workOverrun,
    workSession,
    workSessionAction,
    workSessionBusy,
    workSessionStatus,
    writeWorkspaceId,
  } = app;
  return (
    <>
          {(view === "Home" || view === "Today") && (
            <section className={`workNowCard ${workOverrun ? "overrun" : ""}`} aria-labelledby="work-now-title">
              <div>
                <p className="eyebrow">LUMI · {tr("workNow").toUpperCase()}</p>
                <h2 id="work-now-title">{workSession?.taskTitle || tr("workNotRunning")}</h2>
                {workSession && <p><strong>{tr("workElapsed")}:</strong> <time>{workElapsedText}</time>{workSession.estimatedMinutes ? ` · ${workSession.estimatedMinutes} min` : ""}</p>}
              </div>
              {workSession && <div className="workNowActions">
                {workSession.state === "running" ? <button disabled={workSessionBusy} onClick={() => workSessionAction("pause")}>{tr("workPause")}</button> : <button disabled={workSessionBusy} onClick={() => workSessionAction("resume")}>{tr("workResume")}</button>}
                <button className="primaryAction" disabled={workSessionBusy} onClick={() => workSessionAction("finish")}>{tr("workFinish")}</button>
              </div>}
              {workOverrun && <div><p className="dayPlanWarning" role="status">{tr("workOverrun")}</p><button disabled={dayPlanBusy} onClick={() => loadDayPlan(activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId, calendarToday).catch((error) => setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged")))}>{tr("workReplan")}</button></div>}
              {workSessionStatus && <p role="status">{workSessionStatus}</p>}
            </section>
          )}
    </>
  );
}
