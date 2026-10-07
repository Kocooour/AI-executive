"use client";
import type { LumiApp } from "../use-lumi-app";

// Today's read-only calendar events. Shared by Home and the Calendar view.
export function TodayAgenda({ app }: { app: LumiApp }) {
  const { calendarTimezone, language, todayCalendarEvents, tr } = app;
  return (
    <div className="calendarAgenda">
      {todayCalendarEvents.map((event) => (
        <div key={event.id} className={event.busy ? "busy" : "free"}>
          <span>{event.allDay ? tr("allDay") : new Date(event.start).toLocaleTimeString(language === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone })}</span>
          <strong>{event.title}</strong>
          <small>{event.busy ? tr("busy") : tr("freeTime")}</small>
        </div>
      ))}
    </div>
  );
}
