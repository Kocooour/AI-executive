import type { Entity } from "./db";

/** Legacy UI preview guard only; server Area ACL is an R3 dependency.
 * Never allow an aggregated All or other-workspace status write from the mobile header.
 */
export function taskPreviewCanToggle(
  task: Pick<Entity, "type" | "status" | "workspaceId"> | null,
  activeWorkspaceId: string,
  blocked: boolean,
): boolean {
  return Boolean(task && task.type === "task" && activeWorkspaceId !== "all" &&
    activeWorkspaceId === task.workspaceId &&
    (task.status === "open" || task.status === "completed") && !blocked);
}
