"use client";
import { useEffect, useMemo, useRef } from "react";
import { mobileCalendarDateParts, mobileCalendarKeyboardTarget, mobileCalendarStripDays } from "../../../lib/mobile-calendar-day";

export function MobileCalendarDateStrip({ selectedDay, today, language, onSelect }: {
  selectedDay: string;
  today: string;
  language: string;
  onSelect: (day: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const pendingKeyboardDayRef = useRef<string | null>(null);
  const days = useMemo(() => mobileCalendarStripDays(selectedDay), [selectedDay]);
  // Keep the selected date visible after tapping a day or jumping a week.
  // No animated scrolling: reduced-motion preference is always respected.
  useEffect(() => {
    const strip = stripRef.current;
    const selected = strip?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (strip && selected) strip.scrollLeft = selected.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + selected.clientWidth / 2;
  }, [selectedDay]);

  // The strip is a single Tab stop. After Arrow/Page movement re-render,
  // focus the newly selected bubble rather than leaving focus on the old date.
  useEffect(() => {
    const requested = pendingKeyboardDayRef.current;
    if (!requested || requested !== selectedDay) return;
    pendingKeyboardDayRef.current = null;
    stripRef.current?.querySelector<HTMLButtonElement>(`[data-date="${requested}"]`)
      ?.focus({ preventScroll: true });
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
    <div className="mobileCalendarDateStrip" ref={stripRef} role="group"
      aria-label={cs ? "Vyberte den kalendáře" : "Select a calendar day"}
      aria-describedby="mobile-calendar-keyboard-help">
      <span className="srOnly" id="mobile-calendar-keyboard-help">
        {cs ? "Šipky vlevo a vpravo mění den; Page Up a Page Down mění týden." :
          "Left and right arrows change the day; Page Up and Page Down change the week."}
      </span>
      {days.map((day) => {
        const parts = mobileCalendarDateParts(day, language);
        const active = day === selectedDay;
        const past = day < today;
        return <button type="button" key={day} className="mobileCalendarDateBubble" data-date={day}
          data-selected={active ? "true" : undefined} data-past={past && !active ? "true" : undefined}
          aria-pressed={active} aria-label={parts.accessibleLabel} tabIndex={active ? 0 : -1}
          onClick={() => onSelect(day)}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const nextDay = mobileCalendarKeyboardTarget(day, event.key);
            if (!nextDay) return;
            event.preventDefault();
            pendingKeyboardDayRef.current = nextDay;
            onSelect(nextDay);
          }}>
          <span className="mobileCalendarWeekday" aria-hidden="true">{parts.weekday}</span>
          <span className="mobileCalendarDateNumber" aria-hidden="true">{parts.date}</span>
        </button>;
      })}
    </div>
  </div>;
}
