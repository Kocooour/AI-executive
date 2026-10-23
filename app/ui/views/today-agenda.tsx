"use client";
import type { LumiApp } from "../use-lumi-app";
import { calendarEventDisplay } from "../../../lib/calendar-event-display";
import { CalendarEventActions } from "./calendar-event-actions";

// Read-only calendar events: Home retains its workday slice; Today can pass all local-day events.
export function TodayAgenda({ app, events = app.todayCalendarEvents, day }: {
  app: LumiApp;
  events?: LumiApp["calendarDayEvents"];
  day?: string;
}) {
  const { calendarTimezone, language, tr } = app;
  return (
    <div className="calendarAgenda">
      {events.map((event) => {
        const display = day ? calendarEventDisplay(event, { language, timezone: calendarTimezone, day }) : null;
        const timeLabel = event.allDay ? tr("allDay") : display
          ? display.coversWholeDay ? tr("calendarOccupiesWholeDay") : display.time
          : new Date(event.start).toLocaleTimeString(language === "cs" ? "cs-CZ" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: calendarTimezone });
        const continuation = display ? [
          display.continuesFromPreviousDay && tr("calendarContinuesFromPreviousDay"),
          display.continuesIntoNextDay && tr("calendarContinuesIntoNextDay"),
        ].filter(Boolean).join(" · ") : "";
        const minutes = event.allDay ? 0 : Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000);
        return (
          <div key={event.id} className={event.busy ? "busy" : "free"}>
            <span>{timeLabel}</span>
            <strong>{event.title}</strong>
            <small>{event.busy ? tr("busy") : tr("freeTime")}{continuation ? ` · ${continuation}` : ""}{minutes > 0 ? ` · ${tr("timelineMinutes").replace("{n}", String(minutes))}` : ""}</small>
            <CalendarEventActions app={app} event={event} />
          </div>
        );
      })}
    </div>
  );
}
