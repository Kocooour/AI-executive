"use client";
import { useMemo, useState } from "react";
import { calendarOverviewConflictIds, calendarOverviewIntersects } from "../../../lib/calendar-overview";
import type { CalendarEvent } from "../types";
import type { LumiApp } from "../use-lumi-app";

function eventTime(event: CalendarEvent, language: string, timezone: string, includeDate = false) {
  if (event.allDay) return "";
  return new Date(event.start).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB", {
    ...(includeDate ? { weekday: "short", day: "numeric", month: "short" } : {}), hour: "2-digit", minute: "2-digit", timeZone: timezone,
  });
}

function blockTime(start: string | undefined, end: string | undefined, language: string, timezone: string) {
  if (!start || !end) return "";
  const format = new Intl.DateTimeFormat(language === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  return `${format.format(new Date(start))}–${format.format(new Date(end))}`;
}

export function CalendarView({ app }: { app: LumiApp }) {
  const { applyDayPlanAction, calendarDayEvents, calendarFresh, calendarSources, calendarStatus, calendarTimezone, dayPlanBusy, dayPlanStatus, freeHours, freeWindows,
    inspect, items, language, loadCalendar, nearbyCalendarEvents, setCalendarStatus, setSettingsSection, setView, tr, view, visibleDayPlan } = app;
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const todayEventIds = new Set(calendarDayEvents.map((event) => event.id));
  const nearTermEvents = nearbyCalendarEvents.filter((event) => !todayEventIds.has(event.id));
  const timeline = useMemo(() => visibleDayPlan ? [
    ...visibleDayPlan.existingBlocks.map((block) => ({ ...block, id: `existing:${block.taskId}:${block.start}`, state: "existing" as const })),
    ...visibleDayPlan.planBlocks.map((block) => ({ ...block, id: `proposal:${block.taskId}:${block.start}`, state: "proposal" as const })),
  ].sort((left, right) => String(left.start).localeCompare(String(right.start))) : [], [visibleDayPlan]);
  const planConflictIds = useMemo(() => calendarOverviewConflictIds(timeline), [timeline]);
  const eventConflictIds = useMemo(() => new Set(calendarDayEvents.filter((event) => event.busy && timeline.some((block) => calendarOverviewIntersects(event, block))).map((event) => event.id)), [calendarDayEvents, timeline]);
  const eventCard = (event: CalendarEvent, includeDate = false) => {
    const isOpen = openEventId === event.id;
    const hasConflict = eventConflictIds.has(event.id);
    return <article key={event.id} className={`calendarAgendaItem ${event.busy ? "busy" : "free"} ${hasConflict ? "conflict" : ""}`.trim()}>
      <button type="button" className="calendarAgendaOpen" aria-expanded={isOpen} onClick={() => setOpenEventId((current) => current === event.id ? null : event.id)}>
        <span>{event.allDay ? tr("allDay") : eventTime(event, language, calendarTimezone, includeDate)}</span><strong>{event.title}</strong><small>{event.busy ? tr("busy") : tr("freeTime")}{hasConflict ? ` · ${tr("calendarConflict")}` : ""}</small>
      </button>
      {isOpen && <section className="calendarEventInspector" aria-label={`${tr("calendarEventDetails")}: ${event.title}`}>
        <strong>{tr("calendarEvent")}</strong><p>{event.allDay ? tr("allDay") : `${new Date(event.start).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: calendarTimezone })}–${new Date(event.end).toLocaleTimeString(language === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}`}</p><p>{tr("calendarReadOnlyEvent")}</p><button type="button" onClick={() => setOpenEventId(null)}>{tr("calendarCloseEvent")}</button>
      </section>}
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
      const conflict = planConflictIds.has(block.id) || calendarDayEvents.some((event) => event.busy && calendarOverviewIntersects(event, block));
      const task = items.find((item) => item.id === block.taskId && item.type === "task");
      return <article className={`calendarPlanItem ${block.state} ${conflict ? "conflict" : ""}`.trim()} key={block.id}><span>{blockTime(block.start, block.end, language, calendarTimezone)}</span><div><strong>{block.title}</strong><small>{tr(block.state === "existing" ? block.planningSource === "albert-day-plan" ? "dayPlanApproved" : "dayPlanExisting" : "dayPlanProposed")} · {block.estimatedMinutes} min{conflict ? ` · ${tr("calendarConflict")}` : ""}</small>{block.state === "proposal" && <p>{tr("calendarProposalNeedsApproval")}</p>}</div><div className="calendarPlanActions">{task && <button type="button" onClick={() => void inspect(task)}>{tr("calendarOpenTask")}</button>}{block.state === "proposal" && <button type="button" className="primaryAction" disabled={dayPlanBusy} onClick={() => void applyDayPlanAction(block, "accepted")}>{tr("calendarReviewProposal")}</button>}</div></article>;
    })}</div>}{dayPlanStatus && <p role="status">{dayPlanStatus}</p>}</section>
    <section className="calendarOverview" aria-labelledby="calendar-near-term-title"><h3 id="calendar-near-term-title">{tr("calendarNearTerm")}</h3>{nearTermEvents.length === 0 ? <p className="attentionEmpty">{calendarSources.length === 0 ? tr("calendarDisconnected") : tr("noEventsInThe")}</p> : <div className="calendarAgenda">{nearTermEvents.map((event) => eventCard(event, true))}</div>}</section>
    <button type="button" className="textAction" onClick={() => setView("Today")}>{tr("openTodaySWork")} →</button><button type="button" className="textAction" onClick={() => { setSettingsSection("calendar"); setView("Settings"); }}>{tr("manageCalendars")} →</button>{calendarStatus && <p role="status">{calendarStatus}</p>}
  </section> : null;
}
