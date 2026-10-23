"use client";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { calendarOverviewIntersects } from "../../../lib/calendar-overview";
import { calendarEventDisplay } from "../../../lib/calendar-event-display";
import {
  layoutDayTimeline, timelineNowOffset, TIMELINE_PX_PER_MINUTE, TIMELINE_PX_PER_MINUTE_NARROW, untimedRowHeight, type PlacedTimelineItem, type TimelineSource,
} from "../../../lib/day-timeline";
import type { Entity } from "../../../lib/db";
import { planSlotsByTask } from "../../../lib/today-plan";
import type { CalendarEvent, DayPlanItem } from "../types";
import type { LumiApp } from "../use-lumi-app";
import { CalendarEventActions } from "./calendar-event-actions";
import { DeferChip } from "./defer-popover";
import { PopoverMenu } from "./popover-menu";
import { TodayTimeCell } from "./today-time-cell";

// One local day as a vertical time axis: every item is as tall as it lasts (1 px per minute, 0.8 on a
// narrow screen), so a 90-minute meeting is visibly longer than a 30-minute one. Events, accepted and
// proposed work blocks and tasks made from events sit at their time; overlapping items stand side by
// side. Items open a small panel with the details and the owner's actions (the same controls the lists
// carry). The axis itself is decorative: the items are a list in start order.

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
const MINUTE = 60_000;

type Kind = "event" | "task" | "plan";
interface Entry extends TimelineSource {
  kind: Kind;
  title: string;
  event?: CalendarEvent;
  task?: Entity;
  block?: DayPlanItem;
  proposal?: boolean;
  hidden?: boolean;
  busy?: boolean;
  done?: boolean;
  allDay?: boolean;
  conflict?: boolean;
  /** Length used when the item is not drawn from clock times (all-day items have none). */
  minutes?: number;
}

export function DayTimeline({ app, mode, empty }: { app: LumiApp; mode: "today" | "calendar"; empty?: ReactNode }) {
  const { applyDayPlanAction, busyCalendarDayEvents, calendarDayEvents, calendarDayEventsAll, calendarEventTasks, calendarTimezone, calendarToday, createCalendarEventTask,
    dayPlanBusy, dayPlanNow, inspect, isCalendarEventHidden, items, language, notificationState, todayTasks, tr, unhideCalendarEvent, visibleDayPlan, calendarEventNeedsQuestion } = app;
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 560px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const pxPerMinute = narrow ? TIMELINE_PX_PER_MINUTE_NARROW : TIMELINE_PX_PER_MINUTE;
  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone }), [locale, calendarTimezone]);

  const entries = useMemo<Entry[]>(() => {
    // Today shows what the agenda shows (no hidden events, no events that became tasks); Calendar shows all.
    const agendaIds = new Set(calendarDayEvents.map((event) => event.id));
    const result: Entry[] = [];
    const taskIds = new Set<string>();
    for (const event of calendarDayEventsAll) {
      const task = calendarEventTasks.get(event.id);
      if (task) {
        if (mode === "today" && task.status !== "open") continue;
        const estimate = typeof task.properties.estimatedMinutes === "number" && task.properties.estimatedMinutes > 0 ? task.properties.estimatedMinutes : 0;
        const start = Date.parse(event.start);
        const end = estimate ? start + estimate * MINUTE : Date.parse(event.end);
        taskIds.add(task.id);
        result.push({ id: `event:${event.id}`, kind: "task", title: task.title || event.title, start: event.start, end: Number.isFinite(end) ? new Date(end).toISOString() : event.end,
          event, task, done: task.status !== "open", allDay: event.allDay, minutes: estimate || undefined });
        continue;
      }
      const hidden = isCalendarEventHidden(event);
      if (mode === "today" ? !agendaIds.has(event.id) : false) continue;
      result.push({ id: `event:${event.id}`, kind: "event", title: event.title, start: event.start, end: event.end, event, hidden, busy: event.busy, allDay: event.allDay });
    }
    if (visibleDayPlan) {
      const blocks = [
        ...visibleDayPlan.existingBlocks.map((block) => ({ block, proposal: false })),
        ...visibleDayPlan.planBlocks.map((block) => ({ block, proposal: true })),
      ];
      for (const { block, proposal } of blocks) {
        if (!block.start || !block.end || taskIds.has(block.taskId)) continue;
        result.push({ id: `${proposal ? "proposal" : "existing"}:${block.taskId}:${block.start}`, kind: "plan", title: block.title, start: block.start, end: block.end, block, proposal,
          task: items.find((item) => item.id === block.taskId && item.type === "task") });
      }
    }
    // A conflict is a plan block over a busy event or over another plan block (events beside each other are normal).
    const busyIds = new Set(busyCalendarDayEvents.map((event) => event.id));
    const occupying = result.filter((entry) => !entry.allDay && (entry.kind === "plan" || (entry.kind === "event" && entry.event && busyIds.has(entry.event.id))));
    for (let left = 0; left < occupying.length; left += 1) {
      for (let right = left + 1; right < occupying.length; right += 1) {
        const a = occupying[left], b = occupying[right];
        if (a.kind !== "plan" && b.kind !== "plan") continue;
        if (!calendarOverviewIntersects(a, b, calendarTimezone)) continue;
        a.conflict = true;
        b.conflict = true;
      }
    }
    return result;
  }, [mode, calendarDayEvents, calendarDayEventsAll, calendarEventTasks, calendarTimezone, busyCalendarDayEvents, isCalendarEventHidden, items, visibleDayPlan]);

  const allDay = useMemo(() => entries.filter((entry) => entry.allDay), [entries]);
  const timed = useMemo(() => entries.filter((entry) => !entry.allDay), [entries]);
  const layout = useMemo(() => layoutDayTimeline(timed, {
    day: calendarToday, timezone: calendarTimezone, pxPerMinute, fitToItems: mode === "today",
    workdayStart: notificationState?.preferences.workdayStart, workdayEnd: notificationState?.preferences.workdayEnd,
  }), [timed, mode, calendarToday, calendarTimezone, pxPerMinute, notificationState?.preferences.workdayStart, notificationState?.preferences.workdayEnd]);
  const nowTop = timelineNowOffset(layout, dayPlanNow);

  // Calendar only: today's open tasks that have no time on the axis, each as tall as its estimate.
  // (Today lists them right below, in the working list.)
  const placedTaskIds = new Set(entries.flatMap((entry) => entry.task ? [entry.task.id] : []));
  const untimed = mode === "calendar" ? todayTasks.filter((task) => task.type === "task" && task.status === "open" && !placedTaskIds.has(task.id)) : [];
  const planSlots = planSlotsByTask(visibleDayPlan);

  if (entries.length === 0 && untimed.length === 0) return <>{empty}</>;

  const minutesText = (minutes: number) => fill(tr("timelineMinutes"), { n: minutes });
  const timeText = (item: PlacedTimelineItem<Entry>) =>
    `${clock.format(new Date(layout.dayStartMs + item.startMinute * MINUTE))}–${clock.format(new Date(layout.dayStartMs + item.endMinute * MINUTE))}`;
  const kindText = (entry: Entry) => tr(entry.kind === "event" ? "timelineKindEvent" : entry.kind === "task" ? "timelineKindTask" : "timelineKindPlan");
  const flags = (entry: Entry) => [
    entry.kind === "event" && entry.hidden && tr("calEventHiddenLabel"),
    entry.kind === "event" && !entry.hidden && (entry.busy ? tr("busy") : tr("freeTime")),
    entry.kind === "plan" && tr(entry.proposal ? "dayPlanProposed" : entry.block?.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting"),
    entry.proposal && tr("calendarProposalNeedsApproval"),
    entry.done && tr("Completed"),
    entry.conflict && tr("calendarConflict"),
  ].filter(Boolean).join(", ");

  const panel = (entry: Entry, when: string, close: (returnFocus?: boolean) => void) => {
    const event = entry.event;
    const display = event ? calendarEventDisplay(event, { language, timezone: calendarTimezone, day: calendarToday }) : null;
    const continuation = display ? [display.continuesFromPreviousDay && tr("calendarContinuesFromPreviousDay"), display.continuesIntoNextDay && tr("calendarContinuesIntoNextDay")].filter(Boolean).join(" · ") : "";
    return (
      <div className="dayTimelinePanel" data-timeline-panel={entry.id}>
        <p className="timeMenuHead"><strong>{entry.title}</strong><span>{[when, kindText(entry), flags(entry)].filter(Boolean).join(" · ")}</span></p>
        {continuation && <p className="dayTimelineNote">{continuation}</p>}
        {entry.kind === "event" && event && (entry.hidden ? (
          <div className="calendarEventRow"><button type="button" className="calendarEventHide" data-event-unhide={event.id} aria-label={fill(tr("calEventUnhideLabel"), { title: event.title })}
            onClick={() => { close(false); void unhideCalendarEvent(event); }}>{tr("calEventUnhide")}</button></div>
        ) : (
          <>
            <p className="dayTimelineNote">{event.allDay ? `${tr("allDay")} · ${display?.detail}` : display?.detail} · {tr("calendarReadOnlyEvent")}</p>
            <CalendarEventActions app={app} event={event} />
            {!calendarEventNeedsQuestion(event) && (
              <button type="button" data-event-create-task={event.id} onClick={() => void createCalendarEventTask(event)}>{tr("calEventCreateTask")}</button>
            )}
          </>
        ))}
        {entry.kind === "task" && event && <CalendarEventActions app={app} event={event} />}
        {entry.kind === "plan" && (
          <div className="timeMenuActions">
            {entry.task && <button type="button" onClick={() => { close(false); void inspect(entry.task as Entity); }}>{tr("timelineOpenTask")}</button>}
            {entry.proposal && entry.block && (
              <button type="button" className="primaryAction" disabled={dayPlanBusy} onClick={() => { close(true); void applyDayPlanAction(entry.block as DayPlanItem, "accepted"); }}>{tr("calendarReviewProposal")}</button>
            )}
          </div>
        )}
      </div>
    );
  };

  const classes = (entry: Entry) => [
    "dayTimelineBlock", `is-${entry.kind}`,
    entry.kind === "event" && !entry.hidden ? (entry.busy ? "busy" : "free") : "",
    entry.hidden ? "isHidden" : "", entry.proposal ? "isProposal" : "", entry.done ? "isDone" : "", entry.conflict ? "isConflict" : "",
  ].filter(Boolean).join(" ");

  const stale = mode === "today" && !app.calendarFresh && app.calendarDayEvents.length > 0;
  const body = (
    <div className="dayTimeline" data-day-timeline={mode} style={{ "--tl-scale": pxPerMinute } as CSSProperties}>
      {allDay.length > 0 && (
        <ul className="dayTimelineAllDay" aria-label={tr("timelineAllDay")}>
          {allDay.map((entry) => {
            const label = `${entry.title}, ${tr("timelineAllDay")}${flags(entry) ? `, ${flags(entry)}` : ""}`;
            return (
              <li key={entry.id}>
                <PopoverMenu role="group" className="dayTimelineItemMenu" label={fill(tr("timelineItemMenu"), { title: entry.title })} triggerLabel={label}
                  triggerClassName={classes(entry) + " isAllDay"} triggerData={{ "data-timeline-item": entry.id }}
                  triggerContent={<><span className="dtTitle">{entry.title}</span><span className="dtMeta">{tr("timelineAllDay")}</span></>}>
                  {(close) => panel(entry, tr("timelineAllDay"), close)}
                </PopoverMenu>
              </li>
            );
          })}
        </ul>
      )}
      {layout.items.length > 0 && (
        <div className="dayTimelineBody" style={{ height: layout.height }}>
          <div className="dayTimelineAxis" aria-hidden="true">
            {layout.hours.map((hour) => <div key={hour.minute} className="dayTimelineHour" style={{ top: hour.top }}><span>{hour.label}</span></div>)}
          </div>
          <ol className="dayTimelineItems" aria-label={tr("timelineTitle")}>
            {layout.items.map((placed) => {
              const entry = placed.source;
              const when = timeText(placed);
              const minutes = entry.minutes ?? placed.durationMinutes;
              const continues = [placed.continuesFromPreviousDay && tr("calendarContinuesFromPreviousDay"), placed.continuesIntoNextDay && tr("calendarContinuesIntoNextDay")].filter(Boolean).join(", ");
              const label = `${entry.title}, ${when}, ${minutesText(minutes)}, ${kindText(entry)}${flags(entry) ? `, ${flags(entry)}` : ""}${continues ? `, ${continues}` : ""}`;
              return (
                <li key={entry.id} className="dayTimelineItem" style={{ top: placed.top, height: placed.height, "--col": placed.column, "--cols": placed.columns } as CSSProperties}>
                  <PopoverMenu role="group" className="dayTimelineItemMenu" label={fill(tr("timelineItemMenu"), { title: entry.title })} triggerLabel={label}
                    triggerClassName={`${classes(entry)} ${placed.height < 40 ? "isCompact" : ""}`.trim()}
                    triggerData={{ "data-timeline-item": entry.id, "data-timeline-minutes": String(minutes), "data-timeline-kind": entry.kind }}
                    triggerContent={<><span className="dtTitle">{entry.title}</span><span className="dtMeta">{when} · {minutesText(minutes)}</span></>}>
                    {(close) => panel(entry, `${when} · ${minutesText(minutes)}`, close)}
                  </PopoverMenu>
                </li>
              );
            })}
          </ol>
          {nowTop !== null && <div className="dayTimelineNow" style={{ top: nowTop }} aria-hidden="true"><span>{tr("timelineNow")}</span></div>}
        </div>
      )}
      {untimed.length > 0 && (
        <section className="dayTimelineUntimed" aria-labelledby="day-timeline-untimed-title">
          <h4 id="day-timeline-untimed-title">{tr("timelineUntimed")}</h4>
          <ul>
            {untimed.map((task) => {
              const estimate = typeof task.properties.estimatedMinutes === "number" && task.properties.estimatedMinutes > 0 ? task.properties.estimatedMinutes : null;
              return (
                <li key={task.id} className="dayTimelineUntimedRow" data-untimed-task={task.id} style={{ minHeight: untimedRowHeight(estimate, pxPerMinute) }}>
                  <button type="button" className="check" aria-label={`${tr("complete")} ${task.title || tr("untitledItem")}`} onClick={() => void app.done(task.id)}>○</button>
                  <span className="dayTimelineUntimedMain">
                    <button type="button" className="taskRowOpen" onClick={() => void inspect(task)}>{task.title || tr("untitledItem")}</button>
                    <small data-timeline-estimate>{estimate ? minutesText(estimate) : tr("timelineNoEstimate")}</small>
                  </span>
                  <TodayTimeCell app={app} task={task} slot={planSlots.get(task.id)} />
                  {app.activeWorkspaceId !== "all" && <DeferChip app={app} task={task} />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
  if (mode === "calendar") return body;
  // Today: the day overview above the working list; the stale-calendar note is said once, here.
  return (
    <section className="todayCalendarCommitments dayTimelineSection" aria-labelledby="today-calendar-title">
      <h2 id="today-calendar-title">{tr("timelineTitle")}</h2>
      {stale && <p role="status">{tr("dayPlanStale")}</p>}
      {body}
    </section>
  );
}
