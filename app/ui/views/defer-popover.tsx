"use client";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Entity } from "../../../lib/db";
import { addDays, deferTargets, suggestDeferral } from "../../../lib/defer-suggestion";
import { attentionEvidenceIsVisible, attentionSubjectChangedSinceEvaluation } from "../../../lib/home-today";
import { ymd } from "../../../lib/local-dates";
import { pluralText } from "../../../lib/plural";
import { isEveningTask, taskDueTone } from "../../../lib/task-views";
import { friendlyDate, inSentenceDate } from "../format";
import { taskRowValue } from "../task-row-value";
import type { LumiApp } from "../use-lumi-app";

// The "When" control of a task row (Things-style deferral): a date chip on the row and one popover
// (a bottom sheet on a narrow screen) for the whole app. Which task's popover is open lives in
// use-lumi-app.tsx (`deferOpen`); the view keeps only local UI state (visible month, focused day).

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MOBILE_QUERY = "(max-width: 700px)";
const WIDTH = 340;

export function CalendarIcon() {
  return (
    <svg className="deferChipIcon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 6.5h12M5.5 1.8v2.6M10.5 1.8v2.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// The chip is the "When" control: it always shows the planned day. The deadline, which this control
// never changes, is a separate badge next to it. Rows with a sync/held state keep that state instead
// (the caller decides).
export function DeferChip({ app, task, fromAttention }: {
  app: LumiApp;
  task: Entity;
  fromAttention?: { key: string; fingerprint: string; workspaceId: string; evaluatedAt: number };
}) {
  const { deferOpen, language, setDeferError, setDeferOpen, today, tr } = app;
  const props = task.properties;
  const when = typeof props.when === "string" && DAY.test(props.when) ? props.when : "";
  const deadline = typeof props.deadline === "string" && DAY.test(props.deadline.slice(0, 10)) ? props.deadline.slice(0, 10) : "";
  const planned = isEveningTask(task, today) ? tr("deferEveningShort")
    : props.someday === true ? tr("scheduleSomeday")
      : when ? friendlyDate(when, language)
        : props.today === true ? tr("Today") : "";
  // Without a planned day the chip may still carry the waiting / estimate state the row used to show.
  const fallback = planned ? null : taskRowValue({ ...task, properties: { ...props, when: undefined, deadline: undefined } }, language, today,
    { held: false, unsent: false, openTaskCount: 0 });
  const extra = fallback && fallback.kind !== "none" ? fallback : null;
  const text = planned || extra?.text || "";
  const label = tr("deferChipLabel").replace("{value}", () => (planned || tr("deferNoDate")) + (extra ? `, ${extra.text}` : ""));
  const open = deferOpen?.taskId === task.id;
  const tone = taskDueTone(task, today);
  const deadlineTone = deadline && deadline < today ? "isPassed" : tone === "dueSoon" ? "isSoon" : "";
  return (
    <span className="deferGroup">
      {deadline && (
        <span className={`deadlineBadge ${deadlineTone}`.trim()} data-deadline={deadline}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path d="M3.5 14V2.5M3.5 3h8.5l-2 3 2 3H3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="deferVisuallyHidden">{tr("deferDeadlineLabel")} </span>{friendlyDate(deadline, language)}
        </span>
      )}
      <button
        type="button"
        className={`taskRowMeta deferChip ${!text ? "noDate" : ""}`.trim()}
        data-meta-kind={planned ? "date" : extra ? extra.kind : "none"}
        data-defer-chip={task.id}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setDeferError(false);
          setDeferOpen(open ? null : { taskId: task.id, anchor: event.currentTarget, ...(fromAttention ? { origin: "attention" as const, attention: fromAttention } : {}) });
        }}
      >
        {!planned && <CalendarIcon />}
        {text}
      </button>
    </span>
  );
}

// Rendered once by the app shell.
export function DeferPopover({ app }: { app: LumiApp }) {
  const { activeWorkspaceId, attentionActionsBlocked, deferOpen, items, setDeferOpen, showAllAttention, visibleAttention } = app;
  const task = deferOpen ? items.find((item) => item.id === deferOpen.taskId) : undefined;
  const evidence = deferOpen?.attention;
  // The popover may outlive its Attention row. Confirm that the *same* evidence
  // (not merely another recommendation about the same task) still appears in
  // the rendered list after a successful refresh, including "Show fewer".
  const currentEvidence = !deferOpen || deferOpen.origin !== "attention" || Boolean(evidence &&
    attentionEvidenceIsVisible({ ...evidence, taskId: deferOpen.taskId }, visibleAttention, showAllAttention));
  const locallyChanged = Boolean(evidence && attentionSubjectChangedSinceEvaluation(task, evidence.evaluatedAt));
  const revoked = Boolean(deferOpen?.origin === "attention" &&
    (attentionActionsBlocked || !currentEvidence || locallyChanged || !deferOpen.anchor.isConnected));

  // Check the anchor again *after* React commits. During a successful Attention
  // refresh it can still be connected in render and then be removed in commit,
  // while neither the task nor synchronization state changes.
  useLayoutEffect(() => {
    if (deferOpen?.origin !== "attention") return;
    if (!revoked && deferOpen.anchor.isConnected) return;
    setDeferOpen((current) => current === deferOpen ? null : current);
    // The old chip may have been removed with the row. Restore keyboard focus
    // to the stable Home section heading rather than leaving it on <body>.
    document.getElementById("attention-title")?.focus();
  });

  if (!deferOpen || !task || task.type !== "task" || task.status !== "open" || activeWorkspaceId === "all" || revoked) return null;
  return <DeferDialog key={task.id} app={app} task={task} anchor={deferOpen.anchor} fromAttention={deferOpen.origin === "attention" ? evidence : undefined} />;
}

function DeferDialog({ app, task, anchor, fromAttention }: { app: LumiApp; task: Entity; anchor: HTMLElement; fromAttention?: { evaluatedAt: number } }) {
  const { attentionActionsBlocked, calendarToday, deferBusy, deferError, deferTask, items, language, setDeferOpen, today, tr, visibleDayPlan } = app;
  // A second guard for event handlers already queued when freshness changes.
  const revoked = Boolean(fromAttention && (attentionActionsBlocked || !anchor.isConnected ||
    attentionSubjectChangedSinceEvaluation(task, fromAttention.evaluatedAt)));
  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const popRef = useRef<HTMLDivElement>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const when = typeof task.properties.when === "string" && DAY.test(task.properties.when) ? task.properties.when : "";
  const rawDeadline = typeof task.properties.deadline === "string" ? task.properties.deadline.slice(0, 10) : "";
  const deadline = DAY.test(rawDeadline) ? rawDeadline : "";
  const targets = deferTargets(today);
  // A planned day that has passed is not offered; the calendar starts at today then.
  const start0 = when && when >= today ? when : today;
  const month0 = start0.slice(0, 7);
  const [month, setMonth] = useState({ year: Number(month0.slice(0, 4)), month: Number(month0.slice(5, 7)) - 1 });
  const [focusDay, setFocusDay] = useState(start0);
  const [refocus, setRefocus] = useState(false);

  const close = (returnFocus: boolean) => {
    setDeferOpen(null);
    if (returnFocus && anchor.isConnected) anchor.focus();
  };

  // The suggestion needs the open tasks of this workspace and, for "overloaded", a fresh calendar.
  const openTasks = items.filter((item) => item.type === "task" && item.status === "open" && item.workspaceId === task.workspaceId);
  const calendarOverloaded = Boolean(visibleDayPlan && visibleDayPlan.calendar === "ready" && visibleDayPlan.overloaded &&
    visibleDayPlan.workspaceId === task.workspaceId && visibleDayPlan.date === calendarToday && calendarToday === today);
  const suggestion = suggestDeferral({ task, openTasks, today, calendarOverloaded });

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const change = () => setMobile(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  // Anchored to the chip on a wide screen: below it, or above when there is no room; kept on screen.
  useLayoutEffect(() => {
    if (mobile) { setPosition(null); return; }
    const place = () => {
      const pop = popRef.current;
      if (!pop) return;
      if (!anchor.isConnected) { setDeferOpen(null); return; }
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(WIDTH, window.innerWidth - 16);
      const height = pop.offsetHeight;
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) {
        top = rect.top - 6 - height >= 8 ? rect.top - 6 - height : Math.max(8, window.innerHeight - height - 8);
      }
      setPosition((current) => (current && current.top === top && current.left === left ? current : { top, left }));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [mobile, anchor, month, setDeferOpen]);

  // The row may disappear (another view, a sync); then there is nothing to hang the popover on.
  useEffect(() => { if (!anchor.isConnected) setDeferOpen(null); }, [items, anchor, setDeferOpen]);

  // Focus moves in once the popover is placed and visible (a hidden element cannot take focus).
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || (!mobile && !position)) return;
    focused.current = true;
    popRef.current?.querySelector<HTMLElement>(".deferApply, .deferChoice")?.focus();
  }, [mobile, position]);

  useEffect(() => {
    const inConfirm = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("dialog.confirmDialog"));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || inConfirm(event.target)) return;
      event.preventDefault();
      close(true);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || popRef.current?.contains(target) || anchor.contains(target) || inConfirm(target)) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onPointer); };
  });

  useEffect(() => {
    if (!refocus) return;
    popRef.current?.querySelector<HTMLElement>(`[data-day="${focusDay}"]`)?.focus();
    setRefocus(false);
  }, [refocus, focusDay]);

  async function choose(choice: string, via: "manual" | "lumi" = "manual") {
    if (revoked) { close(false); return; }
    if (deferBusy) return;
    if (await deferTask(task, choice, via)) close(true);
  }

  const longDate = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "numeric" });
  const shortDate = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "numeric" });
  const fullDate = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  // Once the deadline has passed, today is the earliest possible day and is not flagged.
  const afterDeadline = (day: string) => Boolean(deadline) && day > deadline && day > today;

  // Lumi's sentence: the reason key with its parameters; dates read as words ("tomorrow") where they can.
  const sentence = suggestion && Object.entries(suggestion.params).reduce((text, [name, value]) => {
    const shown = name === "date" ? inSentenceDate(String(value), language)
      : name === "who" ? String(value) || tr("deferWaitingSomeone")
        : name === "n" && suggestion.reason === "deferBusyWeek" ? pluralText(language, Number(value), tr("deferTaskForms")) : String(value);
    return text.replace(`{${name}}`, () => shown);
  }, tr(suggestion.reason === "deferKeepDeadline" && String(suggestion.params.date) < today ? "deferKeepOverdue" : suggestion.reason));
  const keep = suggestion?.reason === "deferKeepDeadline";
  const applySuggestion = () => {
    if (!suggestion) return;
    // Keeping the task today changes nothing only when it is already planned for today (not this
    // evening, not an older day that merely shows in Today).
    if (keep && task.properties.when === today && task.properties.evening !== true) { close(true); return; }
    void choose(keep ? "today" : suggestion.target, "lumi");
  };

  const quick: Array<{ key: string; icon: string; label: string; day?: string }> = [
    { key: "today", icon: "★", label: tr("scheduleToday"), day: targets.today },
    { key: "evening", icon: "☾", label: tr("deferEvening") },
    { key: "tomorrow", icon: "→", label: tr("scheduleTomorrow"), day: targets.tomorrow },
    { key: "weekend", icon: "▣", label: tr("deferWeekend"), day: targets.weekend },
    { key: "nextWeek", icon: "⇥", label: tr("deferNextWeek"), day: targets.nextWeek },
    { key: "someday", icon: "☁", label: tr("scheduleSomeday") },
  ];

  // Month grid, Monday first; days of the neighbouring months are shown muted and can be chosen too.
  const first = ymd(new Date(month.year, month.month, 1, 12));
  const offset = (new Date(month.year, month.month, 1, 12).getDay() + 6) % 7;
  const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  const start = addDays(first, -offset);
  const cells = Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index));
  const tabDay = cells.includes(focusDay) ? focusDay : first;
  const monday = "2024-01-01";
  const weekdays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(`${addDays(monday, index)}T12:00:00`);
    return { initial: day.toLocaleDateString(locale, { weekday: "narrow" }), name: day.toLocaleDateString(locale, { weekday: "long" }) };
  });
  const monthLabel = new Date(month.year, month.month, 1, 12).toLocaleDateString(locale, { month: "long", year: "numeric" });
  const shiftMonth = (by: number) => {
    const next = new Date(month.year, month.month + by, 1, 12);
    setMonth({ year: next.getFullYear(), month: next.getMonth() });
  };
  const moveTo = (day: string) => {
    setFocusDay(day);
    setMonth({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 });
    setRefocus(true);
  };
  const onDayKey = (event: ReactKeyboardEvent, day: string) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (step !== undefined) { event.preventDefault(); moveTo(addDays(day, step)); return; }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const [year, monthIndex, date] = day.split("-").map(Number);
      const by = event.key === "PageUp" ? -1 : 1;
      const lastDay = new Date(year, monthIndex - 1 + by + 1, 0).getDate();
      moveTo(ymd(new Date(year, monthIndex - 1 + by, Math.min(date, lastDay), 12)));
    }
  };

  const style = mobile ? undefined : { top: position?.top ?? 0, left: position?.left ?? 0, width: Math.min(WIDTH, window.innerWidth - 16), visibility: position ? "visible" as const : "hidden" as const };
  return (
    <>
      {mobile && <div className="deferBackdrop" aria-hidden="true" />}
      {/* On a phone the sheet is modal: Tab stays inside it and the backdrop takes every press outside. */}
      <div ref={popRef} className={`deferPopover ${mobile ? "isSheet" : ""}`.trim()} role="dialog" aria-modal={mobile ? true : undefined} aria-label={tr("deferTitle")} data-defer-task={task.id} style={style}
        onKeyDown={mobile ? (event) => {
          if (event.key !== "Tab" || !popRef.current) return;
          const focusable = [...popRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => element.offsetParent !== null);
          if (!focusable.length) return;
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        } : undefined}>
        <div className="deferHead">
          <span className="deferHeadTitle">{tr("deferTitle")}</span>
          <button type="button" className="deferClose" aria-label={tr("deferClose")} onClick={() => close(true)}>×</button>
        </div>
        {suggestion && (
          <section className="deferSuggestion" aria-label={tr("deferSuggestion")}>
            <p className="deferSuggestionText">
              <span className="deferLumi"><span aria-hidden="true">✦ </span>{tr("deferLumi")}:</span>{" "}
              {!keep && <b>{sentenceEnd(suggestion.target === "someday" ? tr("deferSuggestSomeday") : tr("deferSuggestTo").replace("{date}", () => longDate(suggestion.target)))} </b>}
              {sentence}
            </p>
            <button type="button" className="deferApply" disabled={deferBusy || revoked} onClick={applySuggestion}>{tr(keep ? "deferKeepToday" : "deferApply")}</button>
          </section>
        )}
        <div className="deferChoices">
          {quick.map((choice) => (
            <button key={choice.key} type="button" className="deferChoice" data-defer-choice={choice.key} disabled={deferBusy || revoked} onClick={() => void choose(choice.key)}>
              <span className="deferChoiceIcon" aria-hidden="true">{choice.icon}</span>
              <span className="deferChoiceText">
                <span>{choice.label}</span>
                {choice.day && <small>{shortDate(choice.day)}{afterDeadline(choice.day) ? ` · ${tr("deferPastDeadline")}` : ""}</small>}
              </span>
            </button>
          ))}
        </div>
        <div className="deferCalendar">
          <div className="deferMonthBar">
            <button type="button" aria-label={tr("deferPrevMonth")} onClick={() => shiftMonth(-1)}>‹</button>
            <span className="deferMonthLabel" aria-live="polite">{monthLabel}</span>
            <button type="button" aria-label={tr("deferNextMonth")} onClick={() => shiftMonth(1)}>›</button>
          </div>
          <div role="grid" aria-label={`${tr("deferCalendar")}: ${monthLabel}`} className="deferGrid">
            <div role="row" className="deferWeek deferWeekdays">
              {weekdays.map((weekday, index) => <span key={index} role="columnheader" aria-label={weekday.name} title={weekday.name}>{weekday.initial}</span>)}
            </div>
            {Array.from({ length: weeks }, (_, week) => (
              <div role="row" className="deferWeek" key={week}>
                {cells.slice(week * 7, week * 7 + 7).map((day) => {
                  const selected = day === when;
                  const late = afterDeadline(day);
                  const past = day < today;
                  const notes = [past ? tr("deferPastDay") : "", selected ? tr("deferSelectedDay") : "", day === deadline ? tr("deferDeadlineDay") : "", late ? tr("deferPastDeadline") : ""].filter(Boolean);
                  return (
                    <span role="gridcell" key={day}>
                      <button
                        type="button"
                        className={["deferDay", day === today ? "isToday" : "", selected ? "isSelected" : "", day === deadline ? "isDeadline" : "",
                          late ? "isLate" : "", day.slice(0, 7) !== first.slice(0, 7) ? "isOutside" : "", day < today ? "isPast" : ""].filter(Boolean).join(" ")}
                        data-day={day}
                        tabIndex={day === tabDay ? 0 : -1}
                        aria-label={`${fullDate(day)}${notes.length ? `, ${notes.join(", ")}` : ""}`}
                        aria-pressed={selected}
                        aria-disabled={past || deferBusy || revoked ? true : undefined}
                        aria-current={day === today ? "date" : undefined}
                        onFocus={() => setFocusDay(day)}
                        onKeyDown={(event) => onDayKey(event, day)}
                        onClick={() => { if (!past && !revoked) void choose(day); }}
                      >{Number(day.slice(8))}</button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        {deferError && <p role="alert" className="deferError">{tr("deferError")}</p>}
        <div className="deferFooter">
          {deadline ? <span className="deferDeadline">{tr("deferDeadlineNote").replace("{date}", () => fullDateShort(deadline, locale))}</span> : <span />}
          <button type="button" className="deferClear" data-defer-choice="clear" disabled={deferBusy || revoked} onClick={() => void choose("clear")}>{tr("scheduleClear")}</button>
        </div>
      </div>
    </>
  );
}

// Ends a clause with a full stop unless it already ends with one (a Czech date does: "23. 10.").
const sentenceEnd = (text: string) => (text.endsWith(".") ? text : `${text}.`);

const fullDateShort = (day: string, locale: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString(locale, { day: "numeric", month: "numeric", year: "numeric" });
