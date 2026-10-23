// Lumi's one summary suggestion at the bottom of Today. Pure: reuses the deferral rules of
// lib/defer-suggestion.ts, so the sentence and the target day are the ones the "When" popover offers.
import type { Entity } from "./db";
import { OVERLOADED_TODAY_TASKS, suggestDeferral, type DeferSuggestion } from "./defer-suggestion";

export type TodaySummarySuggestion = { task: Entity; suggestion: DeferSuggestion };

// Shown only when the calendar says the day is overloaded or Today holds more than six open tasks.
// The candidate is the last task of the list as it is ordered now for which the deferral rules say
// "Today is full" (a close deadline, a follow-up or repeated postponing give other reasons and are
// skipped). `todayCount` is the number of open tasks in Today (not only those left by a filter).
export function pickSummarySuggestion({ ordered, todayCount, openTasks, today, calendarOverloaded }: {
  ordered: Entity[];
  todayCount: number;
  openTasks: Entity[];
  today: string;
  calendarOverloaded: boolean;
}): TodaySummarySuggestion | null {
  if (!calendarOverloaded && todayCount <= OVERLOADED_TODAY_TASKS) return null;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const task = ordered[index];
    const suggestion = suggestDeferral({ task, openTasks, today, calendarOverloaded });
    if (suggestion && suggestion.reason === "deferOverloaded" && suggestion.target !== "someday") return { task, suggestion };
  }
  return null;
}
