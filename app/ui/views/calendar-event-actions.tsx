"use client";
import { inSentenceDate } from "../format";
import type { CalendarEvent } from "../types";
import type { LumiApp } from "../use-lumi-app";
import { PopoverMenu } from "./popover-menu";

const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);

// The owner's controls for one calendar event: "Is it a task?" (Yes / No), the task it became, Lumi's
// one suggestion for a full day, and Hide. A recurring event asks whether to hide this occurrence or
// the whole series. Hidden events still occupy time in the calendar.
export function CalendarEventActions({ app, event }: { app: LumiApp; event: CalendarEvent }) {
  const { activeWorkspaceId, applyCalendarEventSuggestion, calendarDecisionFailed, calendarEventNeedsQuestion, calendarEventSuggestion, calendarEventTasks, createCalendarEventTask,
    dismissCalendarEventSuggestion, hideCalendarEvent, inspect, isCalendarEventRecurring, language, markCalendarEventNotTask, tr } = app;
  const task = calendarEventTasks.get(event.id);
  const asking = !task && calendarEventNeedsQuestion(event);
  const suggestion = calendarEventSuggestion?.eventId === event.id ? calendarEventSuggestion : null;
  const title = { title: event.title };
  const hideLabel = fill(tr("calEventHideLabel"), title);
  return (
    <div className="calendarEventActions" data-event-actions={event.id}>
      <div className="calendarEventRow">
        {task ? (
          <span className="calendarEventTask">{tr("calEventTask")}: <button type="button" className="textAction" onClick={() => void inspect(task)} aria-label={fill(tr("calEventOpenTask"), { title: task.title })}>{task.title}</button></span>
        ) : asking ? (
          <span className="calendarEventAsk" role="group" aria-label={`${tr("calEventIsTask")} ${event.title}`}>
            <span>{tr("calEventIsTask")}</span>
            <button type="button" className="primaryAction" data-event-answer="yes" aria-label={fill(tr("calEventYesLabel"), title)} onClick={() => void createCalendarEventTask(event)}>{tr("calEventYes")}</button>
            <button type="button" data-event-answer="no" aria-label={fill(tr("calEventNoLabel"), title)} onClick={() => void markCalendarEventNotTask(event)}>{tr("calEventNo")}</button>
          </span>
        ) : <span />}
        {isCalendarEventRecurring(event) ? (
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
      {suggestion && (
        <p className="calendarEventSuggestion" role="status" data-event-suggestion>
          <span aria-hidden="true">✦ </span>
          {fill(tr("calEventSuggest"), { task: suggestion.taskTitle, target: suggestion.target === "someday" ? tr("scheduleSomeday") : inSentenceDate(suggestion.target, language) })}
          {activeWorkspaceId !== "all" && <button type="button" className="primaryAction" data-event-suggestion-apply onClick={() => void applyCalendarEventSuggestion()}>{tr("calEventSuggestApply")}</button>}
          <button type="button" data-event-suggestion-dismiss onClick={dismissCalendarEventSuggestion}>{tr("calEventSuggestDismiss")}</button>
        </p>
      )}
      {calendarDecisionFailed && <p className="calendarEventError" role="alert">{tr("calEventFailed")}</p>}
    </div>
  );
}
