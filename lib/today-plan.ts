// How the day plan shows up in the single Today list: one time cell per row, the header total and
// the plan items that are not in Today. Pure: no clock, React, storage or network access.

export type PlanItemLike = { taskId: string; estimatedMinutes?: number; start?: string; end?: string };
export type PlanLike<T extends PlanItemLike = PlanItemLike> = { existingBlocks: T[]; planBlocks: T[]; unscheduled: T[] };
// "existing": a block already in the calendar or approved; "proposed": a block waiting for the
// owner's approval; "unscheduled": planned for today but without a fitting time.
export type PlanSlotKind = "existing" | "proposed" | "unscheduled";
export type PlanSlot<T extends PlanItemLike = PlanItemLike> = { kind: PlanSlotKind; item: T };

// One slot per task. A task that has an existing block and also a proposal shows the existing one.
export function planSlotsByTask<T extends PlanItemLike>(plan: PlanLike<T> | null | undefined): Map<string, PlanSlot<T>> {
  const slots = new Map<string, PlanSlot<T>>();
  if (!plan) return slots;
  const add = (items: T[] | undefined, kind: PlanSlotKind) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (item && typeof item.taskId === "string" && !slots.has(item.taskId)) slots.set(item.taskId, { kind, item });
    }
  };
  add(plan.existingBlocks, "existing");
  add(plan.planBlocks, "proposed");
  add(plan.unscheduled, "unscheduled");
  return slots;
}

// Hours rounded to the nearest half hour; any planned time is at least half an hour.
export function roundedPlanHours(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.max(0.5, Math.round(minutes / 30) / 2);
}

// The plan's estimates for the given tasks (those in the Today list), in minutes. `null` when no plan
// is loaded, so the header omits the "~X h" part instead of claiming zero.
export function planMinutesForTasks(plan: PlanLike | null | undefined, taskIds: Set<string>): number | null {
  if (!plan) return null;
  let total = 0;
  for (const [taskId, slot] of planSlotsByTask(plan)) {
    const minutes = Number(slot.item.estimatedMinutes);
    if (taskIds.has(taskId) && Number.isFinite(minutes) && minutes > 0) total += minutes;
  }
  return total;
}

// Plan items for tasks that are not in the Today list (a close deadline or a priority without a
// planned day). They are not rows; Today only counts them. `eligible`, when given, limits the count
// to tasks that still exist as open tasks (a plan can briefly lag behind a completed task).
export function planItemsOutsideToday(plan: PlanLike | null | undefined, taskIds: Set<string>, eligible?: Set<string>): number {
  let count = 0;
  for (const taskId of planSlotsByTask(plan).keys()) if (!taskIds.has(taskId) && (!eligible || eligible.has(taskId))) count += 1;
  return count;
}

// The owner chose "do not schedule" for this task on the plan's day: the plan leaves it out, but its
// Today row keeps a cell that says so (and offers another day) instead of losing the plan menu.
export function planSkippedToday(task: { properties?: Record<string, unknown> } | null | undefined, planDate: string): boolean {
  const feedback = task?.properties?.planningFeedback as { date?: unknown; decision?: unknown } | null | undefined;
  return Boolean(feedback && typeof feedback === "object" && feedback.date === planDate && feedback.decision === "dismissed");
}
