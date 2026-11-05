"use client";
import { useEffect, useMemo, useRef } from "react";
import { mobileCalendarDateParts, mobileCalendarStripDays } from "../../../lib/mobile-calendar-day";

export function MobileCalendarDateStrip({ selectedDay, today, language, onSelect }: {
  selectedDay: string;
  today: string;
  language: string;
  onSelect: (day: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const days = useMemo(() => mobileCalendarStripDays(selectedDay), [selectedDay]);
  // Keep the selected date visible after tapping a day or jumping a week.
  // No animated scrolling: reduced-motion preference is always respected.
  useEffect(() => {
    const strip = stripRef.current;
    const selected = strip?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (strip && selected) strip.scrollLeft = selected.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + selected.clientWidth / 2;
  }, [selectedDay]);

  const cs = language === "cs";
  return <div className="mobileCalendarPicker" data-mobile-calendar-day={selectedDay}>
    <div className="mobileCalendarPickerHead">
      {/* One direct return-to-today control. Swipe or select an edge bubble to
          navigate farther; duplicate previous/next-week chevrons are omitted. */}
      <button type="button" className="mobileCalendarTodayJump" data-calendar-v1-today-jump
        onClick={() => onSelect(today)} aria-label={cs ? "Přejít na dnešek" : "Go to today"}>
        {cs ? "Dnes" : "Today"}
      </button>
    </div>
    <div className="mobileCalendarDateStrip" ref={stripRef} role="group" aria-label={cs ? "Vyberte den kalendáře" : "Select a calendar day"}>
      {days.map((day) => {
        const parts = mobileCalendarDateParts(day, language);
        const active = day === selectedDay;
        const past = day < today;
        return <button type="button" key={day} className="mobileCalendarDateBubble" data-date={day}
          data-selected={active ? "true" : undefined} data-past={past && !active ? "true" : undefined}
          aria-pressed={active} aria-label={parts.accessibleLabel} onClick={() => onSelect(day)}>
          <span className="mobileCalendarWeekday" aria-hidden="true">{parts.weekday}</span>
          <span className="mobileCalendarDateNumber" aria-hidden="true">{parts.date}</span>
        </button>;
      })}
    </div>
  </div>;
}
