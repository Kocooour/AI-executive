"use client";
import { useEffect, useState } from "react";
import { mobileDesignV1Preview } from "../navigation";
import { mobileCalendarDateParts, mobileCalendarReadWindow } from "../../../lib/mobile-calendar-day";
import { MobileCalendarDateStrip } from "./mobile-calendar-date-strip";
import { calendarEventDisplay } from "../../../lib/calendar-event-display";
import type { CalendarEvent } from "../types";
import { CalendarEventActions, CalendarEventNotice } from "./calendar-event-actions";
import type { LumiApp } from "../use-lumi-app";
import { DayTimeline } from "./day-timeline";

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);

export function CalendarView({ app }: { app: LumiApp }) {
  const { calendarEventTasks, calendarFresh, createCalendarEventTask, isCalendarEventHidden, nearbyCalendarEventsAll, unhideCalendarEvent, calendarSources, calendarStatus, calendarTimezone, dayPlanStatus, freeHours, freeWindows,
    activeWorkspaceId, writeWorkspaceId, calendarToday, language, loadCalendar, setCalendarStatus, setSettingsSection, setView, tr, view } = app;
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const [mobileViewport, setMobileViewport] = useState(false);
  const [selectedCalendarDay, setSelectedCalendarDay] = useState<string | null>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setMobileViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const mobileDayMode = mobileDesignV1Preview && mobileViewport;
  // No pinned day follows calendarToday across midnight and timezone changes.
  const shownDay = selectedCalendarDay ?? calendarToday;
  const [dayReload, setDayReload] = useState(0);
  const workspaceId = activeWorkspaceId === "all" ? writeWorkspaceId : activeWorkspaceId;
  const remoteDay = mobileDayMode && view === "Calendar" && shownDay !== calendarToday;
  const dayRange = remoteDay ? mobileCalendarReadWindow(shownDay, calendarToday, calendarTimezone) : null;
  // A source refresh or workspace switch invalidates an earlier loaded day.
  const sourceVersion = calendarSources.map((source) => `${source.id}:${source.revision}:${source.lastSuccessAt}`).join("|");
  const dayKey = remoteDay && dayRange
    ? `${workspaceId}:${shownDay}:${calendarTimezone}:${sourceVersion}:${dayReload}`
    : null;
  const [dayRead, setDayRead] = useState<{
    key: string; status: "loading" | "ready" | "error"; events: CalendarEvent[];
  } | null>(null);
  useEffect(() => {
    if (!dayKey || !dayRange) return;
    const controller = new AbortController();
    setDayRead({ key: dayKey, status: "loading", events: [] });
    // The API and the calendar source cache are workspace-scoped. A separate
    // read avoids replacing the main Today/near-term event feed and its capacity.
    void (async () => {
      try {
        const url = `/api/calendar?workspaceId=${encodeURIComponent(workspaceId)}&from=${dayRange.from}&to=${dayRange.to}`;
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Calendar day read failed");
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !Array.isArray((body as { events?: unknown }).events)) {
          throw new Error("Invalid calendar day response");
        }
        // Never accept a late response or events belonging to a previous
        // workspace. The effect cleanup also cancels obsolete requests.
        if (!controller.signal.aborted) {
          setDayRead({ key: dayKey, status: "ready",
            events: (body as { events: CalendarEvent[] }).events.filter((event) => event.workspaceId === workspaceId) });
        }
      } catch {
        if (!controller.signal.aborted) setDayRead({ key: dayKey, status: "error", events: [] });
      }
    })();
    return () => controller.abort();
  }, [dayKey, dayRange?.from, dayRange?.to, workspaceId]);
  const selectedDayRead = dayRead?.key === dayKey ? dayRead : null;
  const refreshCalendar = () => {
    if (remoteDay) setDayReload((value) => value + 1);
    void loadCalendar().catch(() => setCalendarStatus(tr("calendarCouldNotBe")));
  };
  const eventCard = (event: CalendarEvent, includeDate = false) => {
    const isOpen = openEventId === event.id;
    const display = calendarEventDisplay(event, { language, timezone: calendarTimezone, day: includeDate ? undefined : calendarToday });
    const timeLabel = display.coversWholeDay ? tr("calendarOccupiesWholeDay") : display.time;
    const timing = event.allDay ? `${tr("allDay")} · ${display.date}` : includeDate ? `${display.date} · ${timeLabel}` : timeLabel;
    const continuation = [display.continuesFromPreviousDay && tr("calendarContinuesFromPreviousDay"), display.continuesIntoNextDay && tr("calendarContinuesIntoNextDay")].filter(Boolean).join(" · ");
    const minutes = event.allDay ? 0 : Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000);
    const durationText = minutes > 0 ? ` · ${fill(tr("timelineMinutes"), { n: String(minutes) })}` : "";
    const linkedTask = calendarEventTasks.get(event.id);
    // Hidden: only in the calendar, faded, until the owner shows it again. It does not occupy time.
    if (isCalendarEventHidden(event)) {
      return <article key={event.id} className="calendarAgendaItem hiddenEvent" data-event-state="hidden">
        <div className="calendarAgendaOpen"><span>{timing}</span><strong>{event.title}</strong><small>{tr("calEventHiddenLabel")}</small></div>
        <div className="calendarEventActions"><div className="calendarEventRow"><button type="button" className="calendarEventHide" data-event-unhide={event.id} aria-label={fill(tr("calEventUnhideLabel"), { title: event.title })} onClick={() => void unhideCalendarEvent(event)}>{tr("calEventUnhide")}</button></div></div>
      </article>;
    }
    // Became a task: listed once, as that task, at the event's time (no plain copy of the event).
    if (linkedTask) {
      const finished = linkedTask.status !== "open";
      return <article key={event.id} className={`calendarAgendaItem taskEvent ${finished ? "isDone" : ""}`.trim()} data-event-state="task">
        <div className="calendarAgendaOpen"><span>{timing}</span><strong>{linkedTask.title}</strong><small>{tr("calEventTask")}{finished ? ` · ${tr("Completed")}` : ""}</small></div>
        <CalendarEventActions app={app} event={event} />
      </article>;
    }
    return <article key={event.id} className={`calendarAgendaItem ${event.busy ? "busy" : "free"}`.trim()}>
      <button type="button" className="calendarAgendaOpen" aria-expanded={isOpen} onClick={() => setOpenEventId((current) => current === event.id ? null : event.id)}>
        <span>{timing}</span><strong>{event.title}</strong><small>{event.busy ? tr("busy") : tr("freeTime")}{continuation ? ` · ${continuation}` : ""}{durationText}</small>
      </button>
      {isOpen && <section className="calendarEventInspector" aria-label={`${tr("calendarEventDetails")}: ${event.title}`}>
        <strong>{tr("calendarEvent")}</strong><p>{event.allDay ? `${tr("allDay")} · ${display.detail}` : display.detail}</p>{continuation && <p>{continuation}</p>}<p>{tr("calendarReadOnlyEvent")}</p><button type="button" data-event-create-task={event.id} onClick={() => void createCalendarEventTask(event)}>{tr("calEventCreateTask")}</button><button type="button" onClick={() => setOpenEventId(null)}>{tr("calendarCloseEvent")}</button>
      </section>}
      <CalendarEventActions app={app} event={event} />
    </article>;
  };
  return view === "Calendar" ? <section className="calendarView homeSection" aria-labelledby="calendar-view-title">
    <div className="homeSectionHead"><span id="calendar-view-title"><span className="sectionDot todayDot" />{tr("todaySCalendar")}</span><button type="button" onClick={refreshCalendar}>{tr("refresh")}</button></div>
    <p className="attentionMeta">{tr("sourceConnectedReadOnly")} · {calendarTimezone}</p>
    <p role="status" className={`calendarFreshness ${calendarSources.length === 0 ? "disconnected" : calendarFresh && (!mobileDayMode || shownDay === calendarToday) ? "fresh" : "stale"}`}>{calendarSources.length === 0 ? tr("calendarDisconnected") : calendarFresh && (!mobileDayMode || shownDay === calendarToday) ? `${freeHours.toFixed(1)} ${tr("freeHours")}` : tr("capacityUnknown")}</p>
    {!calendarFresh && calendarSources.length > 0 && <p className="attentionEmpty" role="status">{tr("calendarStale")} {tr("freeWindowsAreHidden")}</p>}
    <CalendarEventNotice app={app} />
    {calendarSources.map((source) => <p className="attentionMeta" key={source.id}>{source.label} · {source.lastSuccessAt ? `${tr("lastSync")} ${new Date(source.lastSuccessAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}` : tr("capacityUnknown")}</p>)}
    {mobileDayMode ? (
      <section className="mobileCalendarDay" aria-labelledby="mobile-calendar-day-heading">
        <MobileCalendarDateStrip selectedDay={shownDay} today={calendarToday} language={language}
          onSelect={(day) => setSelectedCalendarDay(day === calendarToday ? null : day)} />
        <h3 id="mobile-calendar-day-heading">{mobileCalendarDateParts(shownDay, language).accessibleLabel}</h3>
        {shownDay !== calendarToday && <p role="status" className="attentionMeta">
          {language === "cs"
            ? "Jiný než dnešní den: zobrazeny pouze načtené položky, úplnost kalendáře ani volná kapacita nejsou ověřeny."
            : "Outside today: only loaded items are shown; calendar completeness and free capacity are unverified."}
        </p>}
        {remoteDay && !dayRange ? (
          <p role="status" className="attentionEmpty" data-calendar-day-state="outside-range">
            {language === "cs"
              ? "Den je mimo období načtené ze zdrojových kalendářů (přibližně 13 dní zpět a 89 dní dopředu)."
              : "This date is outside the calendar source cache (approximately 13 days back and 89 days ahead)."}
          </p>
        ) : remoteDay && selectedDayRead?.status !== "ready" ? (
          selectedDayRead?.status === "error" ? (
            <div role="alert" data-calendar-day-state="error">
              <p>{language === "cs" ? "Události pro vybraný den se nepodařilo načíst." : "Could not load events for the selected day."}</p>
              <button type="button" onClick={() => setDayReload((value) => value + 1)}>{tr("retry")}</button>
            </div>
          ) : <p role="status" data-calendar-day-state="loading">
            {language === "cs" ? "Načítám události vybraného dne…" : "Loading selected day's events…"}
          </p>
        ) : (
          <DayTimeline key={`${workspaceId}:${shownDay}`} app={app} mode="calendar" day={shownDay}
            dayEvents={remoteDay ? selectedDayRead?.events : undefined}
            empty={<p className="attentionEmpty">{calendarSources.length === 0 ? tr("calendarDisconnected") :
              shownDay !== calendarToday ? (language === "cs" ? "Žádné události v dostupných datech pro vybraný den; úplnost není zaručena." : "No events in available data for this day; completeness is not guaranteed.") :
              calendarFresh ? tr("noBlockingEvent") : tr("calendarStale")}</p>} />
        )}
        {shownDay === calendarToday && calendarFresh && freeWindows.length > 0 &&
          <p>{tr("nearestFree")} {freeWindows.slice(0, 3).map((window) =>
            `${new Date(window[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}–${new Date(window[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}`).join(", ")}</p>}
        {shownDay === calendarToday && dayPlanStatus && <p role="status">{dayPlanStatus}</p>}
      </section>
    ) : (
      <>
        <section className="calendarOverview" aria-labelledby="calendar-today-title"><h3 id="calendar-today-title">{tr("calendarTodayOverview")}</h3>
          <DayTimeline app={app} mode="calendar" empty={<p className="attentionEmpty">{calendarSources.length === 0 ? tr("calendarDisconnected") : calendarFresh ? tr("noBlockingEvent") : tr("calendarStale")}</p>} />
          {calendarFresh && freeWindows.length > 0 && <p>{tr("nearestFree")} {freeWindows.slice(0, 3).map((window) => `${new Date(window[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}–${new Date(window[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}`).join(", ")}</p>}
          {dayPlanStatus && <p role="status">{dayPlanStatus}</p>}</section>
        <section className="calendarOverview" aria-labelledby="calendar-near-term-title"><h3 id="calendar-near-term-title">{tr("calendarNearTerm")}</h3>{nearbyCalendarEventsAll.length === 0 ? <p className="attentionEmpty">{calendarSources.length === 0 ? tr("calendarDisconnected") : tr("noEventsInThe")}</p> : <div className="calendarAgenda">{nearbyCalendarEventsAll.map((event) => eventCard(event, true))}</div>}</section>
      </>
    )}
    <button type="button" className="textAction" onClick={() => setView("Today")}>{tr("openTodaySWork")} →</button><button type="button" className="textAction" onClick={() => { setSettingsSection("calendar"); setView("Settings"); }}>{tr("manageCalendars")} →</button>{calendarStatus && <p role="status">{calendarStatus}</p>}
  </section> : null;
}
