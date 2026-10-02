import type { DayPlan } from "./day-plan";

export type DayPlanDecision = "accepted" | "tomorrow" | "dismissed";

export function matchesDayPlanCandidate(plan: DayPlan, input: {
  taskId: string;
  start: string;
  end: string;
  decision: DayPlanDecision;
}) {
  const proposed = plan.planBlocks.some((block) => block.taskId === input.taskId && block.start === input.start && block.end === input.end);
  if (input.decision === "accepted") return plan.calendar === "ready" && proposed;
  return proposed || !input.start && !input.end && plan.unscheduled.some((item) => item.taskId === input.taskId);
}
