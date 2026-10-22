"use client";
import type { Entity } from "../../../lib/db";
import { planSkippedToday, type PlanSlot } from "../../../lib/today-plan";
import type { DayPlanItem } from "../types";
import type { LumiApp } from "../use-lumi-app";
import { PopoverMenu } from "./popover-menu";

function ClockIcon() {
  return (
    <svg className="todayTimeIcon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.5V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// The time cell of a Today row: the plan's time range (an accepted or existing block in normal text,
// a proposal muted with a dotted underline), "—" for a task the plan could not place, "not planned
// today" for a task the owner skipped, nothing for a task that is not in the plan. It opens a small
// menu with why the task is planned and the plan actions the day-plan cards used to carry (the
// confirmations and Undo are those of the plan itself). On a phone it is a compact icon control.
export function TodayTimeCell({ app, task, slot }: { app: LumiApp; task: Entity; slot: PlanSlot<DayPlanItem> | undefined }) {
  const { activeWorkspaceId, applyDayPlanAction, dayPlanBusy, dayPlanWhy, deferBusy, deferTask, inspect, language, tr, visibleDayPlan, workSession, workSessionAction, workSessionBusy } = app;
  if (!visibleDayPlan || task.workspaceId !== visibleDayPlan.workspaceId) return null;
  const skipped = !slot && planSkippedToday(task, visibleDayPlan.date);
  if (!slot && !skipped) return null;
  const item = slot?.item;
  const kind = slot ? slot.kind : "unscheduled";
  const format = new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { timeZone: visibleDayPlan.timezone, hour: "2-digit", minute: "2-digit" });
  const range = item && kind !== "unscheduled" && item.start && item.end ? `${format.format(new Date(item.start))}–${format.format(new Date(item.end))}` : "";
  const state = skipped ? tr("todaySkipped")
    : kind === "unscheduled" || !range ? tr("dayPlanUnscheduled")
      : tr(kind === "existing" ? item?.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed");
  const proposed = kind === "proposed" && Boolean(range);
  const unplaced = !range;
  const dataKind = skipped ? "skipped" : proposed ? "proposed" : unplaced ? "unscheduled" : "existing";
  const estimateLabel = item ? tr(item.estimateSource === "actual" ? "dayPlanActualEstimate" : item.estimateSource === "learned" ? "dayPlanLearnedEstimate" : item.estimateSource === "explicit" ? "dayPlanExplicitEstimate" : "dayPlanDefaultEstimate")
    + (item.estimateSource === "learned" || item.estimateSource === "actual" ? ` (${item.estimateSamples})` : "") : "";
  const reasonLabel = item ? tr(`dayPlanReason${item.reason[0].toUpperCase()}${item.reason.slice(1)}`) : "";

  return (
    <PopoverMenu
      label={`${tr("todayTimeMenu")}: ${task.title}`}
      role="group"
      className="todayTime"
      triggerClassName={`todayTimeCell ${proposed ? "isProposed" : unplaced ? "isUnplaced" : "isPlanned"}`}
      triggerLabel={`${state}${range ? `: ${range}` : ""}. ${tr("todayTimeMenu")}: ${task.title}`}
      triggerData={{ "data-time-cell": task.id, "data-time-kind": dataKind }}
      triggerContent={<><ClockIcon /><span className="todayTimeText">{skipped ? tr("todaySkippedShort") : range || "—"}</span></>}
    >
      {(close) => {
        // The plan's own handler asks for the confirmation and returns focus to the element that was
        // active; closing first puts that on the time cell.
        const run = (decision: "accepted" | "tomorrow" | "dismissed") => { if (item) { close(true); void applyDayPlanAction(item, decision); } };
        return (
          <div className="timeMenu" data-time-menu={task.id}>
            <p className="timeMenuHead"><strong>{range || state}</strong><span>{skipped ? tr("todaySkippedNote") : `${range ? `${state} · ` : ""}${reasonLabel} · ${item?.estimatedMinutes} min`}</span></p>
            {item && item.whyNow?.length > 0 && <>
              <p className="timeMenuWhyTitle">{tr("whyNow")}</p>
              <ul className="timeMenuWhy">{item.whyNow.map((reason) => <li key={reason}>{dayPlanWhy(reason)}</li>)}</ul>
            </>}
            {item && <p className="timeMenuEstimate" data-time-estimate>{item.estimatedMinutes} min · {estimateLabel}</p>}
            <div className="timeMenuActions">
              {proposed && <button type="button" className="primaryAction" data-time-action="accept" disabled={dayPlanBusy} onClick={() => run("accepted")}>{tr("acceptBlock")}</button>}
              {kind !== "existing" && <>
                <button type="button" data-time-action="another" disabled={dayPlanBusy} onClick={() => { close(false); void inspect(task); }}>{tr("anotherTime")}</button>
                {item
                  ? <button type="button" data-time-action="tomorrow" disabled={dayPlanBusy} onClick={() => run("tomorrow")}>{tr("moveTomorrow")}</button>
                  : activeWorkspaceId !== "all" && <button type="button" data-time-action="tomorrow" disabled={deferBusy} onClick={() => { close(true); void deferTask(task, "tomorrow", "manual"); }}>{tr("moveTomorrow")}</button>}
                {item && <button type="button" data-time-action="dismiss" disabled={dayPlanBusy} onClick={() => run("dismissed")}>{tr("skipPlanning")}</button>}
              </>}
              {!workSession && item && kind !== "unscheduled" && <button type="button" data-time-action="start" disabled={workSessionBusy} onClick={() => { close(false); void workSessionAction("start", task); }}>{tr("todayStart")}</button>}
            </div>
          </div>
        );
      }}
    </PopoverMenu>
  );
}
