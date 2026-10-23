"use client";
import { useMemo, useState } from "react";
import { calendarOverviewConflictIds, calendarOverviewIntersects } from "../../../lib/calendar-overview";
import { calendarEventDisplay } from "../../../lib/calendar-event-display";
import type { CalendarEvent } from "../types";
import { CalendarEventActions } from "./calendar-event-actions";
import type { LumiApp } from "../use-lumi-app";

function blockTime(start: string | undefined, end: string | undefined, language: string, timezone: string) {
  if (!start || !end) return "";
  const format = new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  return `${format.format(new Date(start))}–${format.format(new Date(end))}`;
}

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
const fillN = (text: string, n: number) => fill(text, { n: String(n) });

export function CalendarView({ app }: { app: LumiApp }) {
  const { applyDayPlanAction, calendarDayEvents, calendarDayEventsAll, calendarEventTasks, calendarFresh, createCalendarEventTask, hiddenCalendarEvents, unhideCalendarEvent, calendarSources, calendarStatus, calendarTimezone, dayPlanBusy, dayPlanStatus, freeHours, freeWindows,
    calendarToday, inspect, items, language, loadCalendar, nearbyCalendarEvents, setCalendarStatus, setSettingsSection, setView, tr, view, visibleDayPlan } = app;
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const timeline = useMemo(() => visibleDayPlan ? [
    ...visibleDayPlan.existingBlocks.map((block) => ({ ...block, id: `existing:${block.taskId}:${block.start}`, state: "existing" as const })),
    ...visibleDayPlan.planBlocks.map((block) => ({ ...block, id: `proposal:${block.taskId}:${block.start}`, state: "proposal" as const })),
  ].sort((left, right) => String(left.start).localeCompare(String(right.start))) : [], [visibleDayPlan]);
  const planConflictIds = useMemo(() => calendarOverviewConflictIds(timeline), [timeline]);
  const { eventConflictIds, planEventConflictIds } = useMemo(() => {
    const eventConflictIds = new Set<string>();
    const planEventConflictIds = new Set<string>();
    for (const event of calendarDayEventsAll) {
      if (!event.busy) continue;
      for (const block of timeline) {
        if (!calendarOverviewIntersects(event, block, calendarTimezone)) continue;
        eventConflictIds.add(event.id);
        planEventConflictIds.add(block.id);
      }
    }
    return { eventConflictIds, planEventConflictIds };
  }, [calendarDayEventsAll, timeline, calendarTimezone]);
  const eventCard = (event: CalendarEvent, includeDate = false) => {
    const isOpen = openEventId === event.id;
    const hasConflict = eventConflictIds.has(event.id);
    const display = calendarEventDisplay(event, { language, timezone: calendarTimezone, day: includeDate ? undefined : calendarToday });
    const timeLabel = display.coversWholeDay ? tr("calendarOccupiesWholeDay") : display.time;
    const timing = event.allDay ? `${tr("allDay")} · ${display.date}` : includeDate ? `${display.date} · ${timeLabel}` : timeLabel;
    const continuation = [display.continuesFromPreviousDay && tr("calendarContinuesFromPreviousDay"), display.continuesIntoNextDay && tr("calendarContinuesIntoNextDay")].filter(Boolean).join(" · ");
    return <article key={event.id} className={`calendarAgendaItem ${event.busy ? "busy" : "free"} ${hasConflict ? "conflict" : ""}`.trim()}>
      <button type="button" className="calendarAgendaOpen" aria-expanded={isOpen} onClick={() => setOpenEventId((current) => current === event.id ? null : event.id)}>
        <span>{timing}</span><strong>{event.title}</strong><small>{event.busy ? tr("busy") : tr("freeTime")}{continuation ? ` · ${continuation}` : ""}{hasConflict ? ` · ${tr("calendarConflict")}` : ""}</small>
      </button>
      {isOpen && <section className="calendarEventInspector" aria-label={`${tr("calendarEventDetails")}: ${event.title}`}>
        <strong>{tr("calendarEvent")}</strong><p>{event.allDay ? `${tr("allDay")} · ${display.detail}` : display.detail}</p>{continuation && <p>{continuation}</p>}<p>{tr("calendarReadOnlyEvent")}</p>{!calendarEventTasks.has(event.id) && <button type="button" data-event-create-task={event.id} onClick={() => void createCalendarEventTask(event)}>{tr("calEventCreateTask")}</button>}<button type="button" onClick={() => setOpenEventId(null)}>{tr("calendarCloseEvent")}</button>
      </section>}
      <CalendarEventActions app={app} event={event} />
    </article>;
  };
  return view === "Calendar" ? <section className="calendarView homeSection" aria-labelledby="calendar-view-title">
    <div className="homeSectionHead"><span id="calendar-view-title"><span className="sectionDot todayDot" />{tr("todaySCalendar")}</span><button type="button" onClick={() => void loadCalendar().catch(() => setCalendarStatus(tr("calendarCouldNotBe")))}>{tr("refresh")}</button></div>
    <p className="attentionMeta">{tr("sourceConnectedReadOnly")} · {calendarTimezone}</p>
    <p role="status" className={`calendarFreshness ${calendarSources.length === 0 ? "disconnected" : calendarFresh ? "fresh" : "stale"}`}>{calendarSources.length === 0 ? tr("calendarDisconnected") : calendarFresh ? `${freeHours.toFixed(1)} ${tr("freeHours")}` : tr("capacityUnknown")}</p>
    {!calendarFresh && calendarSources.length > 0 && <p className="attentionEmpty" role="status">{tr("calendarStale")} {tr("freeWindowsAreHidden")}</p>}
    {calendarSources.map((source) => <p className="attentionMeta" key={source.id}>{source.label} · {source.lastSuccessAt ? `${tr("lastSync")} ${new Date(source.lastSuccessAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}` : tr("capacityUnknown")}</p>)}
    <section className="calendarOverview" aria-labelledby="calendar-today-title"><h3 id="calendar-today-title">{tr("calendarTodayOverview")}</h3>{calendarDayEvents.length === 0 ? <p className="attentionEmpty">{calendarSources.length === 0 ? tr("calendarDisconnected") : calendarFresh ? tr("noBlockingEvent") : tr("calendarStale")}</p> : <div className="calendarAgenda">{calendarDayEvents.map((event) => eventCard(event))}</div>}{calendarFresh && freeWindows.length > 0 && <p>{tr("nearestFree")} {freeWindows.slice(0, 3).map((window) => `${new Date(window[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}–${new Date(window[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}`).join(", ")}</p>}</section>
    <section className="calendarOverview" aria-labelledby="calendar-work-title"><h3 id="calendar-work-title">{tr("calendarPlannedWork")}</h3>{timeline.length === 0 ? <p className="attentionEmpty">{tr("calendarNoPlannedWork")}</p> : <div className="calendarPlanList">{timeline.map((block) => {
      const conflict = planConflictIds.has(block.id) || planEventConflictIds.has(block.id);
      const task = items.find((item) => item.id === block.taskId && item.type === "task");
      return <article className={`calendarPlanItem ${block.state} ${conflict ? "conflict" : ""}`.trim()} key={block.id}><span>{blockTime(block.start, block.end, language, calendarTimezone)}</span><div><strong>{block.title}</strong><small>{tr(block.state === "existing" ? block.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed")} · {block.estimatedMinutes} min{conflict ? ` · ${tr("calendarConflict")}` : ""}</small>{block.state === "proposal" && <p>{tr("calendarProposalNeedsApproval")}</p>}</div><div className="calendarPlanActions">{task && <button type="button" onClick={() => void inspect(task)}>{tr("calendarOpenTask")}</button>}{block.state === "proposal" && <button type="button" className="primaryAction" disabled={dayPlanBusy} onClick={() => void applyDayPlanAction(block, "accepted")}>{tr("calendarReviewProposal")}</button>}</div></article>;
    })}</div>}{dayPlanStatus && <p role="status">{dayPlanStatus}</p>}</section>
    <section className="calendarOverview" aria-labelledby="calendar-near-term-title"><h3 id="calendar-near-term-title">{tr("calendarNearTerm")}</h3>{nearbyCalendarEvents.length === 0 ? <p className="attentionEmpty">{calendarSources.length === 0 ? tr("calendarDisconnected") : tr("noEventsInThe")}</p> : <div className="calendarAgenda">{nearbyCalendarEvents.map((event) => eventCard(event, true))}</div>}</section>
    {hiddenCalendarEvents.length > 0 && <section className="calendarHidden" aria-label={fillN(tr("calEventHiddenCount"), hiddenCalendarEvents.length)} data-hidden-events>
      <p className="attentionMeta">{fillN(tr("calEventHiddenCount"), hiddenCalendarEvents.length)} · <button type="button" className="textAction" aria-expanded={showHidden} onClick={() => setShowHidden((current) => !current)}>{tr(showHidden ? "calEventCloseHidden" : "calEventShowHidden")}</button></p>
      {showHidden && <><p className="attentionMeta">{tr("calEventHiddenNote")}</p><div className="calendarAgenda">{hiddenCalendarEvents.map((event) => {
        const display = calendarEventDisplay(event, { language, timezone: calendarTimezone });
        return <article key={event.id} className="calendarAgendaItem hiddenEvent"><div className="calendarAgendaOpen"><span>{event.allDay ? `${tr("allDay")} · ${display.date}` : `${display.date} · ${display.time}`}</span><strong>{event.title}</strong><small /></div>
          <div className="calendarEventActions"><div className="calendarEventRow"><button type="button" className="calendarEventHide" data-event-unhide={event.id} aria-label={fill(tr("calEventUnhideLabel"), { title: event.title })} onClick={() => void unhideCalendarEvent(event)}>{tr("calEventUnhide")}</button></div></div></article>;
      })}</div></>}
    </section>}
    <button type="button" className="textAction" onClick={() => setView("Today")}>{tr("openTodaySWork")} →</button><button type="button" className="textAction" onClick={() => { setSettingsSection("calendar"); setView("Settings"); }}>{tr("manageCalendars")} →</button>{calendarStatus && <p role="status">{calendarStatus}</p>}
  </section> : null;
}
