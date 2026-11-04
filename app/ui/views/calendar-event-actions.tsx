"use client";
import { inSentenceDate } from "../format";
import type { CalendarEvent } from "../types";
import type { Entity } from "../../../lib/db";
import type { LumiApp } from "../use-lumi-app";
import { PopoverMenu } from "./popover-menu";

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);

// The owner's controls for one calendar event: "Is it a task?" (Yes / No), the task it became, and
// Hide. A recurring event asks whether to hide this occurrence or the whole series.
export function CalendarEventActions({ app, event, linkedTask }: { app: LumiApp; event: CalendarEvent; linkedTask?: Entity | null }) {
  const { calendarEventNeedsQuestion, calendarEventTasks, createCalendarEventTask, hideCalendarEvent, done, inspect, isCalendarEventRecurring, markCalendarEventNotTask, tr } = app;
  const task = linkedTask === undefined ? calendarEventTasks.get(event.id) : linkedTask ?? undefined;
  const asking = !task && calendarEventNeedsQuestion(event);
  const title = { title: event.title };
  const hideLabel = fill(tr("calEventHideLabel"), title);
  return (
    <div className="calendarEventActions" data-event-actions={event.id}>
      <div className="calendarEventRow">
        {task ? (
          <div className="calendarEventTask"><button type="button" className="textAction" onClick={() => void inspect(task)} aria-label={fill(tr("calEventOpenTask"), { title: task.title })}>{tr("calendarOpenTask")}</button>{task.status === "open" && <button type="button" className="primaryAction" data-event-complete={task.id} aria-label={`${tr("complete")}: ${task.title}`} onClick={() => void done(task.id)}>{tr("complete")}</button>}</div>
        ) : asking ? (
          <div className="calendarEventAsk" role="group" aria-label={`${tr("calEventIsTask")} ${event.title}`}>
            <p>{tr("calEventIsTask")}</p>
            <button type="button" className="primaryAction" data-event-answer="yes" aria-label={fill(tr("calEventYesLabel"), title)} onClick={() => void createCalendarEventTask(event)}>{tr("calEventYes")}</button>
            <button type="button" data-event-answer="no" aria-label={fill(tr("calEventNoLabel"), title)} onClick={() => void markCalendarEventNotTask(event)}>{tr("calEventNo")}</button>
          </div>
        ) : null}
        {task ? null : isCalendarEventRecurring(event) ? (
          <PopoverMenu label={hideLabel} triggerLabel={hideLabel} triggerClassName="calendarEventHide" triggerContent={tr("calEventHide")} triggerData={{ "data-event-hide": event.id }}>
            {(close) => (
              <div className="calendarEventHideMenu">
                <button type="button" role="menuitem" data-event-hide-scope="occurrence" onClick={() => { close(false); void hideCalendarEvent(event, "occurrence"); }}>{tr("calEventHideOne")}</button>
                <button type="button" role="menuitem" data-event-hide-scope="series" onClick={() => { close(false); void hideCalendarEvent(event, "series"); }}>{tr("calEventHideSeries")}</button>
              </div>
            )}
          </PopoverMenu>
        ) : (
          <button type="button" className="calendarEventHide" data-event-hide={event.id} aria-label={hideLabel} onClick={() => void hideCalendarEvent(event)}>{tr("calEventHide")}</button>
        )}
      </div>
    </div>
  );
}

// Lumi's one suggestion after an event became a task on a full day, and a failed decision. Shown once
// per view (Home, Today, Calendar), not in the event's row: the event leaves Today's and Home's agenda
// as soon as it is a task.
export function CalendarEventNotice({ app }: { app: LumiApp }) {
  const { activeWorkspaceId, applyCalendarEventSuggestion, calendarDecisionFailed, calendarEventSuggestion: suggestion, dismissCalendarEventSuggestion, language, tr } = app;
  if (!suggestion && !calendarDecisionFailed) return null;
  return <>
    {suggestion && (
      <p className="calendarEventSuggestion" role="status" data-event-suggestion>
        {fill(tr("calEventSuggest"), { task: suggestion.taskTitle, target: suggestion.target === "someday" ? tr("scheduleSomeday") : inSentenceDate(suggestion.target, language) })}
        {activeWorkspaceId !== "all" && <button type="button" className="primaryAction" data-event-suggestion-apply onClick={() => void applyCalendarEventSuggestion()}>{tr("calEventSuggestApply")}</button>}
        <button type="button" data-event-suggestion-dismiss onClick={dismissCalendarEventSuggestion}>{tr("calEventSuggestDismiss")}</button>
      </p>
    )}
    {calendarDecisionFailed && <p className="calendarEventError" role="alert">{tr("calEventFailed")}</p>}
  </>;
}
