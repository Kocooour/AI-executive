"use client";
import type { LumiApp } from "../use-lumi-app";

// The running work session: a compact bar with the task, the elapsed time and its actions. It exists
// only while a session runs; when idle only a failed start/finish message is kept.
export function WorkNowCard({ app, compact = false }: { app: LumiApp; compact?: boolean }) {
  const {
    activeWorkspaceId,
    calendarToday,
    dayPlanBusy,
    loadDayPlan,
    setDayPlanStatus,
    tr,
    workElapsedText,
    workOverrun,
    workSession,
    workSessionAction,
    workSessionBusy,
    workSessionStatus,
    writeWorkspaceId,
  } = app;
  if (!workSession) return workSessionStatus ? <p className="workNowStatus" role="status">{workSessionStatus}</p> : null;
  return (
            <section className={`workNowCard ${compact ? "compact" : ""} ${workOverrun ? "overrun" : ""}`.replace(/\s+/g, " ").trim()} aria-labelledby="work-now-title">
              <div>
                <p className="eyebrow">LUMI · {tr("workNow").toUpperCase()}</p>
                <h2 id="work-now-title">{workSession.taskTitle}</h2>
                <p><strong>{tr("workElapsed")}:</strong> <time>{workElapsedText}</time>{workSession.estimatedMinutes ? ` · ${workSession.estimatedMinutes} min` : ""}</p>
              </div>
              <div className="workNowActions">
                {workSession.state === "running" ? <button disabled={workSessionBusy} onClick={() => workSessionAction("pause")}>{tr("workPause")}</button> : <button disabled={workSessionBusy} onClick={() => workSessionAction("resume")}>{tr("workResume")}</button>}
                <button className="primaryAction" disabled={workSessionBusy} onClick={() => workSessionAction("finish")}>{tr("workFinish")}</button>
              </div>
              {workOverrun && <div><p className="dayPlanWarning" role="status">{tr("workOverrun")}</p><button disabled={dayPlanBusy} onClick={() => loadDayPlan(activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId, calendarToday).catch((error) => setDayPlanStatus(error instanceof Error ? error.message : tr("dayPlanChanged")))}>{tr("workReplan")}</button></div>}
              {workSessionStatus && <p role="status">{workSessionStatus}</p>}
            </section>
  );
}
