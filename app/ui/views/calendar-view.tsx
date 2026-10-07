"use client";
import type { LumiApp } from "../use-lumi-app";
import { TodayAgenda } from "./today-agenda";

export function CalendarView({ app }: { app: LumiApp }) {
  const {
    setSettingsSection,
    calendarFresh,
    calendarSources,
    calendarStatus,
    calendarTimezone,
    freeHours,
    freeWindows,
    language,
    loadCalendar,
    nearbyCalendarEvents,
    setCalendarStatus,
    setView,
    todayCalendarEvents,
    tr,
    view,
  } = app;
  return (
    <>
          {view === "Calendar" && (
            <section className="calendarView homeSection" aria-labelledby="calendar-view-title">
              <div className="homeSectionHead"><span id="calendar-view-title"><span className="sectionDot todayDot" />{language === "cs" ? "Dnešní kalendář" : "Today's calendar"}</span><button type="button" onClick={() => void loadCalendar().catch(() => setCalendarStatus(language === "cs" ? "Kalendář se nepodařilo načíst." : "Calendar could not be loaded."))}>{tr("refresh")}</button></div>
              <p className="attentionMeta">{language === "cs" ? "Zdroj: připojený kalendář pouze pro čtení" : "Source: connected read-only calendar"} · {calendarTimezone}</p>
              <p role="status">{calendarSources.length === 0 ? tr("calendarDisconnected") : calendarFresh ? `${freeHours.toFixed(1)} ${tr("freeHours")}` : tr("capacityUnknown")}</p>
              {!calendarFresh && calendarSources.length > 0 && <p className="attentionEmpty">{tr("calendarStale")} {language === "cs" ? "Volné časy nezobrazujeme, dokud není zdroj čerstvý (do 30 minut)." : "Free windows are hidden until the source is fresh (within 30 minutes)."}</p>}
              {calendarSources.map((source) => <p className="attentionMeta" key={source.id}>{source.label} · {source.lastSuccessAt ? `${tr("lastSync")} ${new Date(source.lastSuccessAt).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB")}` : tr("capacityUnknown")}</p>)}
              <TodayAgenda app={app} />
              {calendarFresh && todayCalendarEvents.length === 0 && <p className="attentionEmpty">{tr("noBlockingEvent")}</p>}
              {calendarFresh && freeWindows.length > 0 && <p>{tr("nearestFree")} {freeWindows.slice(0, 3).map((window) => `${new Date(window[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}–${new Date(window[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}`).join(", ")}</p>}
              <h3>{language === "cs" ? "Nadcházející události · 7 dní" : "Upcoming events · 7 days"}</h3>
              {nearbyCalendarEvents.length === 0 ? <p className="attentionEmpty">{calendarSources.length === 0 ? tr("calendarDisconnected") : language === "cs" ? "Žádné události v příštích 7 dnech." : "No events in the next 7 days."}</p> : <div className="calendarAgenda">{nearbyCalendarEvents.map((event) => <div key={event.id} className={event.busy ? "busy" : "free"}><span>{new Date(event.start).toLocaleString(language === "cs" ? "cs-CZ" : "en-GB", { weekday: "short", day: "numeric", month: "short", ...(event.allDay ? {} : { hour: "2-digit", minute: "2-digit" }), timeZone: calendarTimezone })}</span><strong>{event.title}</strong><small>{event.busy ? tr("busy") : tr("freeTime")}</small></div>)}</div>}
              <button type="button" className="textAction" onClick={() => setView("Today")}>{language === "cs" ? "Přejít na dnešní práci" : "Open today's work"} →</button>
              <button type="button" className="textAction" onClick={() => { setSettingsSection("calendar"); setView("Settings"); }}>{language === "cs" ? "Spravovat kalendáře" : "Manage calendars"} →</button>
              {calendarStatus && <p role="status">{calendarStatus}</p>}
            </section>
          )}
    </>
  );
}
