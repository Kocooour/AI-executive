"use client";
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  dayFreeMinutes, decisionFor, eventTaskDraft, isRecurringEvent, linkedEventTasks, needsTaskQuestion, occurrenceDecisionKey, readDecisions,
  reprioritizeSuggestion, seriesDecisionKey, withDecision, DECISIONS_PROPERTY, type CalendarDecision, type CalendarDecisions,
} from "../../../lib/calendar-decisions";
import { isAdopting } from "../../../lib/adoption";
import { writeTime } from "../../../lib/clock";
import { db, type Entity, type Relation } from "../../../lib/db";
import type { CalendarEvent } from "../types";

// What Lumi can still do after a task was made from a calendar event: move a less important task
// of that day (the day is full). Kept until it is applied or dismissed.
export interface EventSuggestion {
  eventId: string;
  taskId: string;
  taskTitle: string;
  /** A YYYY-MM-DD day or "someday". */
  target: string;
}

// The owner's decisions about calendar events (hide, "not a task") and the task made from an event.
// Decisions are stored on the workspace entity (lib/calendar-decisions.ts), so they sync like any
// other record and belong to one workspace. The calendar itself stays read-only.
export function useCalendarEvents({ items, calendarEvents, calendarFresh, calendarTimezone, workdayStart, workdayEnd, today, activeWorkspaceId, calendarWorkspaceSelection,
  localDataVersion, syncToServer, load, setUndo, setUndoRelations, undoCreated, create, deferTask }: {
  items: Entity[];
  calendarEvents: CalendarEvent[];
  calendarFresh: boolean;
  calendarTimezone: string;
  workdayStart: string;
  workdayEnd: string;
  today: string;
  activeWorkspaceId: string;
  calendarWorkspaceSelection: MutableRefObject<string>;
  localDataVersion: MutableRefObject<number>;
  syncToServer: () => Promise<unknown>;
  load: () => Promise<unknown>;
  setUndo: (entity: Entity | null) => void;
  setUndoRelations: (relations: Relation[]) => void;
  undoCreated: MutableRefObject<Entity | null>;
  create: (type: "task", title: string, extra?: Record<string, unknown>, onLocalCommit?: () => void) => Promise<string | undefined>;
  deferTask: (task: Entity, choice: string, via: "manual" | "lumi") => Promise<boolean>;
}) {
  const [suggestion, setSuggestion] = useState<EventSuggestion | null>(null);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const workspaceId = calendarWorkspaceSelection.current;
  const workspace = items.find((entity) => entity.type === "workspace" && entity.workspaceId === workspaceId);
  const decisions = useMemo<CalendarDecisions>(() => readDecisions(workspace), [workspace]);
  // The task each event already has (any state); open tasks are preferred.
  const eventTasks = useMemo(() => linkedEventTasks(items, workspaceId), [items, workspaceId]);

  useEffect(() => { setSuggestion(null); setFailed(false); }, [workspaceId, activeWorkspaceId]);

  const isHidden = (event: CalendarEvent) => decisionFor(decisions, event)?.decision === "hidden";
  const visibleEvents = (events: CalendarEvent[]) => events.filter((event) => !isHidden(event));
  const isRecurring = (event: CalendarEvent) => isRecurringEvent(event, calendarEvents);
  const needsQuestion = (event: CalendarEvent) => needsTaskQuestion(event, { decisions, linked: eventTasks, now: Date.now() });

  // One write of the workspace record: the previous version is the single-step Undo.
  async function changeDecisions(change: (decisions: CalendarDecisions) => CalendarDecisions) {
    if (isAdopting() || busy.current) return false;
    busy.current = true;
    setFailed(false);
    let previous: Entity | null = null;
    localDataVersion.current += 1;
    try {
      await db.transaction("rw", db.entities, async () => {
        const current = await db.entities.get(`workspace:${workspaceId}`);
        // A placeholder that has not been replaced by the server's copy yet (timestamp 0) must not win a merge.
        if (!current || current.type !== "workspace" || current.updatedAt === 0) throw new Error("workspace");
        const next = change(readDecisions(current));
        const properties = { ...current.properties };
        if (Object.keys(next).length) properties[DECISIONS_PROPERTY] = next; else delete properties[DECISIONS_PROPERTY];
        previous = current;
        await db.entities.update(current.id, { properties, updatedAt: writeTime() });
      });
    } catch {
      setFailed(true);
      return false;
    } finally {
      localDataVersion.current += 1;
      busy.current = false;
    }
    undoCreated.current = null;
    setUndo(previous);
    setUndoRelations([]);
    try { await syncToServer(); await load(); } catch { await Promise.resolve(load()).catch(() => undefined); }
    return true;
  }

  const hideEvent = (event: CalendarEvent, scope: "occurrence" | "series" = "occurrence") =>
    changeDecisions((current) => withDecision(current, scope === "series" ? seriesDecisionKey(event) || occurrenceDecisionKey(event) : occurrenceDecisionKey(event), "hidden", Date.now()));
  // Removes whichever decision hides the event (its own, or its whole series').
  const unhideEvent = (event: CalendarEvent) => {
    const found = decisionFor(decisions, event);
    return found ? changeDecisions((current) => withDecision(current, found.key, null, Date.now())) : Promise.resolve(false);
  };
  const markNotTask = (event: CalendarEvent) =>
    changeDecisions((current) => withDecision(current, occurrenceDecisionKey(event), "notTask" satisfies CalendarDecision, Date.now()));

  // "Yes, it is a task": a task in the event's workspace with the event's title, day and length.
  async function createEventTask(event: CalendarEvent) {
    if (isAdopting() || busy.current || eventTasks.has(event.id)) return;
    const draft = eventTaskDraft(event, calendarTimezone);
    if (!draft || !draft.title) return;
    busy.current = true;
    setFailed(false);
    try {
      const id = await create("task", draft.title, {
        ...draft.properties,
        entityId: crypto.randomUUID(),
        workspaceId: event.workspaceId,
        literalTaskTitle: true,
        when: draft.when,
        today: draft.when === today,
        inbox: false,
      }, () => undefined);
      const created = id ? await db.entities.get(id) : undefined;
      if (!created) { setFailed(true); return; }
      // Undo removes the task again (restore() in use-lumi-app.tsx).
      undoCreated.current = created;
      setUndo(created);
      setUndoRelations([]);
      if (!calendarFresh || activeWorkspaceId === "all") { setSuggestion(null); return; }
      const tasks = (await db.entities.toArray()).filter((entity) => entity.type === "task" && entity.workspaceId === event.workspaceId);
      const proposal = reprioritizeSuggestion({
        tasks, workspaceId: event.workspaceId, day: draft.when, today,
        freeMinutes: dayFreeMinutes(calendarEvents, draft.when, calendarTimezone, workdayStart, workdayEnd),
      });
      setSuggestion(proposal ? { eventId: event.id, taskId: proposal.task.id, taskTitle: proposal.task.title, target: proposal.target } : null);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
    }
  }

  async function applySuggestion() {
    if (!suggestion) return;
    const task = await db.entities.get(suggestion.taskId);
    setSuggestion(null);
    if (task) await deferTask(task, suggestion.target, "lumi");
  }

  return {
    calendarDecisions: decisions,
    calendarEventTasks: eventTasks,
    calendarEventSuggestion: suggestion,
    calendarDecisionFailed: failed,
    isCalendarEventHidden: isHidden,
    visibleCalendarEvents: visibleEvents,
    isCalendarEventRecurring: isRecurring,
    calendarEventNeedsQuestion: needsQuestion,
    hideCalendarEvent: hideEvent,
    unhideCalendarEvent: unhideEvent,
    markCalendarEventNotTask: markNotTask,
    createCalendarEventTask: createEventTask,
    applyCalendarEventSuggestion: applySuggestion,
    dismissCalendarEventSuggestion: () => setSuggestion(null),
  };
}
