// Lumi's one summary suggestion at the bottom of Today. Pure: reuses the deferral rules of
// lib/defer-suggestion.ts, so the sentence and the target day are the ones the "When" popover offers.
import type { Entity } from "./db";
import { OVERLOADED_TODAY_TASKS, suggestDeferral, type DeferSuggestion } from "./defer-suggestion";

export type TodaySummarySuggestion = { task: Entity; suggestion: DeferSuggestion };

// Shown only when the calendar says the day is overloaded or Today holds more than six open tasks.
// The candidate is the last task of the list as it is ordered now for which the deferral rules say
// "Today is full" (a close deadline, a follow-up or repeated postponing give other reasons and are
// skipped). `todayCount` is the number of open tasks in Today (not only those left by a filter).
export function pickSummarySuggestion({ ordered, todayCount, openTasks, today, calendarOverloaded, todayTaskIds }: {
  ordered: Entity[];
  todayCount: number;
  openTasks: Entity[];
  today: string;
  calendarOverloaded: boolean;
  /** Only for the UI-04c preview; legacy lists keep their original membership. */
  todayTaskIds?: ReadonlySet<string>;
}): TodaySummarySuggestion | null {
  if (!calendarOverloaded && todayCount <= OVERLOADED_TODAY_TASKS) return null;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const task = ordered[index];
    const suggestion = suggestDeferral({ task, openTasks, today, calendarOverloaded, todayTaskIds });
    if (suggestion && suggestion.reason === "deferOverloaded" && suggestion.target !== "someday") return { task, suggestion };
  }
  return null;
}


/** Stable evidence identifiers for the preview approval gate. The whole
 * task snapshot is compared with the latest local record before a write; a
 * changed title, field, status, revision or workspace requires fresh review.
 * This is not an authorization token (server ACL still applies).
 */
export const todayProposalTaskSignature = (task: Entity): string => JSON.stringify([
  task.id, task.type, task.status, task.workspaceId, task.title,
  task.content ?? null, task.createdAt, task.updatedAt, task.properties,
]);

export function todayProposalReviewKey(
  picked: TodaySummarySuggestion, workspaceId: string, today: string,
): string {
  return JSON.stringify([
    workspaceId, today, todayProposalTaskSignature(picked.task),
    picked.suggestion.target, picked.suggestion.reason, picked.suggestion.params,
  ]);
}
