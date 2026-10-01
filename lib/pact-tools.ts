import { calendarAvailability, listCalendarEvents } from "./calendar";
import { listPACTContext, type ContextScope, type PACTPermission } from "./pact";
import { readSnapshot } from "./server-store";

export type PACTToolName =
  | "task.read"
  | "project.read"
  | "note.read"
  | "calendar.read"
  | "calendar.free_time"
  | "context.read"
  | "task.propose";

export interface PACTToolDefinition {
  name: PACTToolName;
  permission: PACTPermission;
  description: string;
}

export const pactToolRegistry: Record<PACTToolName, PACTToolDefinition> = {
  "task.read": { name: "task.read", permission: "read", description: "Read tasks in one workspace." },
  "project.read": { name: "project.read", permission: "read", description: "Read projects in one workspace." },
  "note.read": { name: "note.read", permission: "read", description: "Read notes in one workspace." },
  "calendar.read": { name: "calendar.read", permission: "read", description: "Read normalized calendar events." },
  "calendar.free_time": { name: "calendar.free_time", permission: "read", description: "Calculate free time from normalized calendar data." },
  "context.read": { name: "context.read", permission: "read", description: "Read explicitly allowed durable context." },
  "task.propose": { name: "task.propose", permission: "propose", description: "Prepare a task mutation through the existing approval boundary." },
};

function workspaceExists(workspaceId: string) {
  return readSnapshot().entities.some(
    (entity) => entity.type === "workspace" && entity.workspaceId === workspaceId,
  );
}

export function executePACTReadTool(
  name: Exclude<PACTToolName, "task.propose">,
  workspaceId: string,
  input: Record<string, unknown> = {},
) {
  if (!workspaceId || workspaceId === "all" || !workspaceExists(workspaceId)) {
    throw new Error("A valid explicit workspace is required");
  }
  const snapshot = readSnapshot();
  if (name === "task.read" || name === "project.read" || name === "note.read") {
    const type = name.split(".")[0];
    return snapshot.entities
      .filter((entity) => entity.workspaceId === workspaceId && entity.type === type)
      .slice(0, 100);
  }
  if (name === "context.read") {
    const requested = Array.isArray(input.scopes) ? input.scopes.map(String) : [];
    const allowed = new Set<ContextScope>(["me", "work", "family", "rules", "project", "workspace"]);
    const scopes = requested.filter((scope): scope is ContextScope => allowed.has(scope as ContextScope));
    return listPACTContext(workspaceId, scopes.length ? scopes : [...allowed])
      .filter((item) => item.sensitivity !== "sensitive")
      .slice(0, 100);
  }
  if (name === "calendar.read") {
    const from = Number(input.from);
    const to = Number(input.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("Calendar range is required");
    return listCalendarEvents(workspaceId, from, to).slice(0, 100);
  }
  if (name === "calendar.free_time") {
    const localDate = String(input.localDate || "");
    const timezone = String(input.timezone || "");
    const workdayStart = String(input.workdayStart || "09:00");
    const workdayEnd = String(input.workdayEnd || "17:00");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !timezone) throw new Error("Local date and timezone are required");
    return calendarAvailability(workspaceId, localDate, timezone, workdayStart, workdayEnd);
  }
  throw new Error("Unknown PACT read tool");
}

export function toolPermission(name: PACTToolName) {
  return pactToolRegistry[name].permission;
}
