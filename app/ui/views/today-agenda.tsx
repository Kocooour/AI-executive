"use client";
import type { LumiApp } from "../use-lumi-app";

// Read-only calendar events: Home retains its workday slice; Today can pass all local-day events.
export function TodayAgenda({ app, events = app.todayCalendarEvents }: {
  app: LumiApp;
  events?: LumiApp["calendarDayEvents"];
}) {
  const { calendarTimezone, language, tr } = app;
  return (
    <div className="calendarAgenda">
      {events.map((event) => (
        <div key={event.id} className={event.busy ? "busy" : "free"}>
          <span>{event.allDay ? tr("allDay") : new Date(event.start).toLocaleTimeString(language === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}</span>
          <strong>{event.title}</strong>
          <small>{event.busy ? tr("busy") : tr("freeTime")}</small>
        </div>
      ))}
    </div>
  );
}
